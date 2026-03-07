import { FastifyInstance, FastifyRequest } from 'fastify';
import { OAuth2Client } from 'google-auth-library';
import jwt from 'jsonwebtoken';
import sharp from 'sharp';
import { getSupabaseClient } from '../services/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { AuthLoginRequest, AuthLoginResponse, AuthMeResponse, UpdateProfileRequest, UpdateProfileResponse, UserProfile, UserType } from '../types/auth.js';
import logger from '../utils/logger.js';
import { getPhilippineNowIso } from '../utils/time.js';

const JWT_SECRET: string = (() => {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET environment variable is required');
  }
  return secret;
})();
const JWT_EXPIRY = process.env.JWT_EXPIRY || '7d';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const ALLOWED_USER_TYPES: readonly UserType[] = ['User', 'Staff', 'Admin'];

const oauthClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;

function isAllowedUserType(value: unknown): value is UserType {
  return typeof value === 'string' && ALLOWED_USER_TYPES.includes(value as UserType);
}

/**
 * Normalize name to Title Case (first letter of each word capitalized)
 * "CHARLES NATHANIEL TOGLE" -> "Charles Nathaniel Togle"
 * "john doe" -> "John Doe"
 */
function normalizeNameToTitleCase(name: string | null | undefined): string | null {
  if (!name) return null;

  return name
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

async function uploadProfilePicture(
  supabase: ReturnType<typeof getSupabaseClient>,
  userId: string,
  imageUrl: string
): Promise<string | null> {
  try {
    const response = await fetch(imageUrl);
    if (!response.ok) {
      logger.warn({ status: response.status }, 'Failed to fetch Google profile image');
      return null;
    }

    const sourceBuffer = Buffer.from(await response.arrayBuffer());
    const webpBuffer = await sharp(sourceBuffer)
      .resize({
        width: 400,
        height: 400,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: 80 })
      .toBuffer();

    const fileName = `${Date.now()}_thumb.webp`;
    const path = `users/${userId}/${fileName}`;

    const { error } = await supabase.storage.from('profilePictures').upload(path, webpBuffer, {
      contentType: 'image/webp',
      upsert: true,
      cacheControl: '3600',
    });

    if (error) {
      logger.error({ error }, 'Failed to upload profile image to Supabase');
      return null;
    }

    const { data } = supabase.storage.from('profilePictures').getPublicUrl(path);
    return data.publicUrl;
  } catch (error) {
    logger.error({ error }, 'Error uploading profile image');
    return null;
  }
}

export default async function authRoutes(server: FastifyInstance) {
  // POST /auth/google - Login with Google ID token
  server.post<{ Body: AuthLoginRequest }>(
    '/google',
    {
      schema: {
        body: {
          type: 'object',
          required: ['googleIdToken'],
          properties: {
            googleIdToken: { type: 'string', minLength: 1 },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply): Promise<AuthLoginResponse> => {
      const { googleIdToken } = request.body;

      if (!oauthClient) {
        reply.status(500).send({ error: 'Google OAuth not configured' });
        return {} as AuthLoginResponse;
      }

      try {
        // Verify Google ID token
        const ticket = await oauthClient.verifyIdToken({
          idToken: googleIdToken,
          audience: GOOGLE_CLIENT_ID,
        });

        const payload = ticket.getPayload();
        if (!payload || !payload.email || !payload.sub) {
          reply.status(400).send({ error: 'Invalid Google token' });
          return {} as AuthLoginResponse;
        }

        if (payload.email_verified !== true) {
          reply.status(403).send({
            error: 'Access Denied',
            message: 'Only verified organization emails are allowed',
          });
          return {} as AuthLoginResponse;
        }

        const normalizedEmail = payload.email.trim().toLowerCase();

        // Check if email is from allowed domain (UMak)
        const allowedDomain = (process.env.ALLOWED_EMAIL_DOMAIN || 'umak.edu.ph').trim().toLowerCase();
        if (!normalizedEmail.endsWith(`@${allowedDomain}`)) {
          reply.status(403).send({
            error: 'Access Denied',
            message: 'Please use your organization email to sign in',
          });
          return {} as AuthLoginResponse;
        }

        const supabase = getSupabaseClient();
        const loginTimestamp = getPhilippineNowIso();
        const normalizedName = normalizeNameToTitleCase(payload.name);

        // Upsert user (profile image will be handled separately)
        const { data: upsertedUser, error: upsertError } = await supabase
          .from('user_table')
          .upsert(
            {
              email: normalizedEmail,
              user_name: normalizedName,
              last_login: loginTimestamp,
            },
            {
              onConflict: 'email',
            }
          )
          .select()
          .single();
        let user = upsertedUser;

        if (upsertError || !user) {
          logger.error({ error: upsertError }, 'Failed to upsert user');
          reply.status(500).send({ error: 'Failed to create user session' });
          return {} as AuthLoginResponse;
        }

        if (!isAllowedUserType(user.user_type)) {
          logger.error({ userId: user.user_id, userType: user.user_type }, 'Invalid user role in database');
          reply.status(403).send({ error: 'Access Denied', message: 'Unauthorized role' });
          return {} as AuthLoginResponse;
        }

        if (payload.picture) {
          const uploadedUrl = await uploadProfilePicture(supabase, user.user_id, payload.picture);
          if (uploadedUrl) {
            const { data: updatedUser, error: updateError } = await supabase
              .from('user_table')
              .update({ profile_picture_url: uploadedUrl })
              .eq('user_id', user.user_id)
              .select()
              .single();

            if (!updateError && updatedUser) {
              user = updatedUser;
            }
          }
        }

        // Create JWT
        const jwtPayload = {
          user_id: user.user_id,
          email: user.email,
          user_type: user.user_type,
        };
        const token = jwt.sign(jwtPayload, JWT_SECRET, { expiresIn: JWT_EXPIRY } as jwt.SignOptions);

        logger.info({ userId: user.user_id, email: user.email }, 'User logged in');

        return {
          token,
          user: {
            user_id: user.user_id,
            user_name: user.user_name,
            email: user.email,
            profile_picture_url: user.profile_picture_url,
            user_type: user.user_type,
            notification_token: user.notification_token,
          },
        };
      } catch (error) {
        logger.error({ error }, 'Google auth error');
        reply.status(401).send({ error: 'Authentication failed', message: String(error) });
        return {} as AuthLoginResponse;
      }
    }
  );

  // GET /auth/me - Get current user profile
  server.get(
    '/me',
    {
      preHandler: [requireAuth],
      schema: {
        response: {
          200: {
            type: 'object',
            properties: {
              user: {
                type: 'object',
                properties: {
                  user_id: { type: 'string' },
                  user_name: { type: 'string' },
                  email: { type: 'string' },
                  profile_picture_url: { type: ['string', 'null'] },
                  user_type: { type: 'string' },
                  notification_token: { type: ['string', 'null'] },
                },
                required: ['user_id', 'user_name', 'email', 'user_type'],
              },
            },
          },
        },
      },
    },
    async (request: FastifyRequest, reply): Promise<AuthMeResponse> => {
      if (!request.user) {
        reply.status(401).send({ error: 'Unauthorized' });
        return {} as AuthMeResponse;
      }

      const supabase = getSupabaseClient();

      const { data: user, error } = await supabase
        .from('user_table')
        .select('*')
        .eq('user_id', request.user.user_id)
        .single();

      if (error || !user) {
        logger.error({ error, userId: request.user.user_id }, 'Failed to fetch user');
        reply.status(404).send({ error: 'User not found' });
        return {} as AuthMeResponse;
      }

      if (!isAllowedUserType(user.user_type)) {
        logger.warn({ userId: user.user_id, userType: user.user_type }, 'Blocked user with invalid role');
        reply.status(403).send({ error: 'Access Denied', message: 'Unauthorized role' });
        return {} as AuthMeResponse;
      }

      return {
        user: {
          user_id: user.user_id,
          user_name: user.user_name,
          email: user.email,
          profile_picture_url: user.profile_picture_url,
          user_type: user.user_type,
          notification_token: user.notification_token,
        } as UserProfile,
      };
    }
  );

  // PATCH /auth/profile - Update current user profile
  server.patch<{ Body: UpdateProfileRequest }>(
    '/profile',
    {
      preHandler: [requireAuth],
      schema: {
        body: {
          type: 'object',
          properties: {
            notification_token: { type: ['string', 'null'] },
            user_name: { type: ['string', 'null'] },
            profile_picture_url: { type: ['string', 'null'] },
          },
          additionalProperties: false,
        },
        response: {
          200: {
            type: 'object',
            properties: {
              user: {
                type: 'object',
                properties: {
                  user_id: { type: 'string' },
                  user_name: { type: ['string', 'null'] },
                  email: { type: ['string', 'null'] },
                  profile_picture_url: { type: ['string', 'null'] },
                  user_type: { type: 'string' },
                  notification_token: { type: ['string', 'null'] },
                },
                required: ['user_id', 'email', 'user_type'],
              },
            },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Body: UpdateProfileRequest }>, reply): Promise<UpdateProfileResponse> => {
      if (!request.user) {
        reply.status(401).send({ error: 'Unauthorized' });
        return {} as UpdateProfileResponse;
      }

      const updates = request.body;
      const userId = request.user.user_id;

      // Validate at least one field is being updated
      if (Object.keys(updates).length === 0) {
        reply.status(400).send({ error: 'No update fields provided' });
        return {} as UpdateProfileResponse;
      }

      const supabase = getSupabaseClient();

      const { data: updatedUser, error } = await supabase
        .from('user_table')
        .update(updates)
        .eq('user_id', userId)
        .select()
        .single();

      if (error || !updatedUser) {
        logger.error({ error, userId }, 'Failed to update user profile');
        reply.status(500).send({ error: 'Failed to update profile' });
        return {} as UpdateProfileResponse;
      }

      // Log notification token registration
      if (updates.notification_token) {
        logger.info({ userId }, 'Notification token registered');
      }

      return {
        user: {
          user_id: updatedUser.user_id,
          user_name: updatedUser.user_name,
          email: updatedUser.email,
          profile_picture_url: updatedUser.profile_picture_url,
          user_type: updatedUser.user_type,
          notification_token: updatedUser.notification_token,
        } as UserProfile,
      };
    }
  );
}
