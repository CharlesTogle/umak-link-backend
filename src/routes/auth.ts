import { FastifyInstance, FastifyRequest } from 'fastify';
import { OAuth2Client } from 'google-auth-library';
import jwt from 'jsonwebtoken';
import sharp from 'sharp';
import { getSupabaseClient } from '../services/supabase.js';
import { isAllowedPortalEmail, normalizePortalEmail, syncPortalUserOnSignIn } from '../services/portal-users.js';
import { requireAuth } from '../middleware/auth.js';
import { AuthLoginRequest, AuthMeResponse, UpdateProfileRequest, UpdateProfileResponse, UserProfile, UserType } from '../types/auth.js';
import logger from '../utils/logger.js';
import { getPhilippineNowIso } from '../utils/time.js';
import { GENERAL_TIMEOUT_MS, withTimeout } from '../utils/timeout.js';

const JWT_SECRET: string = (() => {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET environment variable is required');
  }
  return secret;
})();
const JWT_EXPIRY = process.env.JWT_EXPIRY || '7d';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const ALLOWED_USER_TYPES: readonly UserType[] = ['User', 'Staff', 'Admin', 'Guard'];

const oauthClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;
const LOGIN_TIMEOUT_MESSAGE =
  'Request timed out. Please check your internet connection and try again.';

function isAllowedUserType(value: unknown): value is UserType {
  return typeof value === 'string' && ALLOWED_USER_TYPES.includes(value as UserType);
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.message.toLowerCase().includes('timed out');
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
    const response = await withTimeout(
      fetch(imageUrl),
      GENERAL_TIMEOUT_MS,
      'Fetch Google profile image'
    );
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
    async (request, reply) => {
      const { googleIdToken } = request.body;

      if (!oauthClient) {
        return reply.status(500).send({ error: 'Google OAuth not configured' });
      }

      try {
        // Verify Google ID token with timeout
        const ticket = await withTimeout(
          oauthClient.verifyIdToken({
            idToken: googleIdToken,
            audience: GOOGLE_CLIENT_ID,
          }),
          GENERAL_TIMEOUT_MS,
          'Google token verification'
        );

        const payload = ticket.getPayload();
        if (!payload || !payload.email || !payload.sub) {
          return reply.status(400).send({ error: 'Invalid Google token' });
        }

        if (payload.email_verified !== true) {
          return reply.status(403).send({
            error: 'Access Denied',
            message: 'Only verified organization emails are allowed',
          });
        }

        const normalizedEmail = normalizePortalEmail(payload.email);
        if (!isAllowedPortalEmail(normalizedEmail)) {
          return reply.status(403).send({
            error: 'Access Denied',
            message: 'Sign in failed. Please make sure to use your UMAK Google Account and try again',
          });
        }

        const supabase = getSupabaseClient();
        const loginTimestamp = getPhilippineNowIso();
        const normalizedName = normalizeNameToTitleCase(payload.name);

        const syncedUser = await syncPortalUserOnSignIn(supabase, {
          email: normalizedEmail,
          userName: normalizedName,
          loginTimestamp,
        });

        if (!syncedUser) {
          return reply.status(500).send({ error: 'Failed to create user session' });
        }

        let user = syncedUser;

        if (!isAllowedUserType(user.user_type)) {
          logger.error({ userId: user.user_id, userType: user.user_type }, 'Invalid user role in database');
          return reply.status(403).send({ error: 'Access Denied', message: 'Unauthorized role' });
        }

        // Refresh the stored profile picture on every Google sign-in.
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

        return reply.send({
          token,
          user: {
            user_id: user.user_id,
            user_name: user.user_name,
            email: user.email,
            profile_picture_url: user.profile_picture_url,
            user_type: user.user_type,
            notification_token: user.notification_token,
          },
        });
      } catch (error) {
        logger.error({ error }, 'Google auth error');
        if (isTimeoutError(error)) {
          return reply.status(408).send({
            error: 'Authentication timed out',
            message: LOGIN_TIMEOUT_MESSAGE,
          });
        }

        return reply.status(401).send({
          error: 'Authentication failed',
          message: 'Unable to complete sign in. Please try again.',
        });
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

  // POST /auth/update-picture-from-google - Update profile picture from Google
  server.post<{ Body: { googleIdToken: string } }>(
    '/update-picture-from-google',
    {
      preHandler: [requireAuth],
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
    async (request, reply) => {
      if (!request.user) {
        reply.status(401).send({ error: 'Unauthorized' });
        return;
      }

      if (!oauthClient) {
        reply.status(500).send({ error: 'Google OAuth not configured' });
        return;
      }

      const { googleIdToken } = request.body;

      try {
        // Verify Google ID token
        const ticket = await withTimeout(
          oauthClient.verifyIdToken({
            idToken: googleIdToken,
            audience: GOOGLE_CLIENT_ID,
          }),
          GENERAL_TIMEOUT_MS,
          'Google token verification'
        );

        const payload = ticket.getPayload();
        if (!payload || !payload.email || !payload.picture) {
          reply.status(400).send({ error: 'Invalid Google token or no picture available' });
          return;
        }

        // Verify the token belongs to the current user
        if (!request.user.email || payload.email.trim().toLowerCase() !== request.user.email.toLowerCase()) {
          reply.status(403).send({ error: 'Token does not match current user' });
          return;
        }

        const supabase = getSupabaseClient();

        // Upload profile picture
        const uploadedUrl = await uploadProfilePicture(supabase, request.user.user_id, payload.picture);

        if (!uploadedUrl) {
          reply.status(500).send({ error: 'Failed to upload profile picture' });
          return;
        }

        // Update user profile
        const { data: updatedUser, error } = await supabase
          .from('user_table')
          .update({ profile_picture_url: uploadedUrl })
          .eq('user_id', request.user.user_id)
          .select()
          .single();

        if (error || !updatedUser) {
          logger.error({ error, userId: request.user.user_id }, 'Failed to update profile picture');
          reply.status(500).send({ error: 'Failed to update profile' });
          return;
        }

        logger.info({ userId: request.user.user_id }, 'Profile picture updated from Google');

        return {
          success: true,
          profile_picture_url: uploadedUrl,
          user: {
            user_id: updatedUser.user_id,
            user_name: updatedUser.user_name,
            email: updatedUser.email,
            profile_picture_url: updatedUser.profile_picture_url,
            user_type: updatedUser.user_type,
            notification_token: updatedUser.notification_token,
          },
        };
      } catch (error) {
        logger.error({ error }, 'Failed to update profile picture from Google');
        reply.status(500).send({ error: 'Failed to update profile picture' });
        return;
      }
    }
  );
}
