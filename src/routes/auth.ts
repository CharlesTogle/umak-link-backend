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
import { AUDIT_TIMEOUT_MS, GENERAL_TIMEOUT_MS, withTimeout } from '../utils/timeout.js';
import { buildApiErrorResponse, createHttpError } from '../utils/http-error.js';

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
const APP_LOGIN_AUDIT_USER_TYPES: readonly UserType[] = ['Staff', 'Admin'];
const PORTAL_LOGIN_AUDIT_USER_TYPES: readonly UserType[] = ['Staff', 'Admin', 'Guard'];
type LoginAuditSource = 'umak_link_app' | 'admin_staff_portal';

export interface AuthRouteServices {
  getSupabaseClient: typeof getSupabaseClient;
}

interface AuthRouteOptions {
  services?: Partial<AuthRouteServices>;
}

const defaultServices: AuthRouteServices = {
  getSupabaseClient,
};

const oauthClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;
const LOGIN_TIMEOUT_MESSAGE =
  'Request timed out. Please check your internet connection and try again.';

function isAllowedUserType(value: unknown): value is UserType {
  return typeof value === 'string' && ALLOWED_USER_TYPES.includes(value as UserType);
}

function shouldWriteLoginAudit(userType: UserType, loginSource: LoginAuditSource): boolean {
  if (loginSource === 'umak_link_app') {
    return APP_LOGIN_AUDIT_USER_TYPES.includes(userType);
  }

  return PORTAL_LOGIN_AUDIT_USER_TYPES.includes(userType);
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

function sendRouteError(
  request: FastifyRequest,
  reply: { status: (code: number) => { send: (payload: unknown) => unknown } },
  message: string,
  statusCode: number
) {
  return reply
    .status(statusCode)
    .send(buildApiErrorResponse(createHttpError(message, statusCode), request.id));
}

function getLoginAuditDisplayName(user: Pick<UserProfile, 'user_name' | 'email' | 'user_id'>): string {
  return user.user_name?.trim() || user.email?.trim() || user.user_id;
}

function getPortalLoginDestination(userType: UserType): string {
  if (userType === 'Admin') return 'admin portal';
  if (userType === 'Guard') return 'guard portal';
  return 'staff portal';
}

async function writeLoginAudit(
  supabase: ReturnType<typeof getSupabaseClient>,
  user: UserProfile,
  loginSource: LoginAuditSource
): Promise<void> {
  if (!shouldWriteLoginAudit(user.user_type, loginSource)) {
    return;
  }

  const displayName = getLoginAuditDisplayName(user);
  const details =
    loginSource === 'umak_link_app'
      ? {
        message: `${user.user_type} ${displayName} signed into UMak-LINK app`,
        login_source: loginSource,
        user_type: user.user_type,
        user_name: user.user_name,
        user_email: user.email,
      }
      : {
        message: `${user.user_type} ${displayName} signed into ${getPortalLoginDestination(user.user_type)}`,
        login_source: loginSource,
        user_type: user.user_type,
        user_name: user.user_name,
        user_email: user.email,
      };

  try {
    const { error } = await withTimeout(
      Promise.resolve(
        supabase.rpc('insert_audit_log', {
          p_user_id: user.user_id,
          p_action_type: 'account_login',
          p_target_entity_type: 'user_table',
          p_target_entity_id: user.user_id,
          p_details: details,
        })
      ),
      AUDIT_TIMEOUT_MS,
      'Insert login audit log'
    );

    if (error) {
      logger.error(
        { error, userId: user.user_id, userType: user.user_type, loginSource },
        'Failed to insert login audit log'
      );
    }
  } catch (error) {
    logger.error(
      { error, userId: user.user_id, userType: user.user_type, loginSource },
      'Failed to insert login audit log'
    );
  }
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

export default async function authRoutes(
  server: FastifyInstance,
  options: AuthRouteOptions = {}
) {
  const services = {
    ...defaultServices,
    ...options.services,
  };

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
        return sendRouteError(request, reply, 'Google OAuth not configured', 500);
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
          return sendRouteError(request, reply, 'Invalid Google token', 400);
        }

        if (payload.email_verified !== true) {
          return sendRouteError(
            request,
            reply,
            'Only verified organization emails are allowed',
            403
          );
        }

        const normalizedEmail = normalizePortalEmail(payload.email);
        if (!isAllowedPortalEmail(normalizedEmail)) {
          return sendRouteError(
            request,
            reply,
            'Sign in failed. Please make sure to use your UMAK Google Account and try again',
            403
          );
        }

        const supabase = services.getSupabaseClient();
        const loginTimestamp = getPhilippineNowIso();
        const normalizedName = normalizeNameToTitleCase(payload.name);

        const syncedUser = await syncPortalUserOnSignIn(supabase, {
          email: normalizedEmail,
          userName: normalizedName,
          loginTimestamp,
        });

        if (!syncedUser) {
          return sendRouteError(request, reply, 'Failed to create user session', 500);
        }

        let user = syncedUser;

        if (!isAllowedUserType(user.user_type)) {
          logger.error({ userId: user.user_id, userType: user.user_type }, 'Invalid user role in database');
          return sendRouteError(request, reply, 'Unauthorized role', 403);
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

        await writeLoginAudit(supabase, {
          user_id: user.user_id,
          user_name: user.user_name,
          email: user.email,
          profile_picture_url: user.profile_picture_url,
          user_type: user.user_type,
          notification_token: user.notification_token,
        }, 'umak_link_app');

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
          return sendRouteError(request, reply, LOGIN_TIMEOUT_MESSAGE, 408);
        }

        return sendRouteError(
          request,
          reply,
          'Unable to complete sign in. Please try again.',
          401
        );
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
        sendRouteError(request, reply, 'Unauthorized', 401);
        return {} as AuthMeResponse;
      }

      const supabase = services.getSupabaseClient();

      const { data: user, error } = await supabase
        .from('user_table')
        .select('*')
        .eq('user_id', request.user.user_id)
        .single();

      if (error || !user) {
        logger.error({ error, userId: request.user.user_id }, 'Failed to fetch user');
        sendRouteError(request, reply, 'User not found', 404);
        return {} as AuthMeResponse;
      }

      if (!isAllowedUserType(user.user_type)) {
        logger.warn({ userId: user.user_id, userType: user.user_type }, 'Blocked user with invalid role');
        sendRouteError(request, reply, 'Unauthorized role', 403);
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

  server.post(
    '/portal-login-audit',
    {
      preHandler: [requireAuth],
      schema: {
        response: {
          202: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
            },
            required: ['success'],
          },
        },
      },
    },
    async (request: FastifyRequest, reply): Promise<{ success: boolean }> => {
      if (!request.user) {
        sendRouteError(request, reply, 'Unauthorized', 401);
        return {} as { success: boolean };
      }

      const supabase = services.getSupabaseClient();
      const { data: user, error } = await supabase
        .from('user_table')
        .select('*')
        .eq('user_id', request.user.user_id)
        .single();

      if (error || !user) {
        logger.error({ error, userId: request.user.user_id }, 'Failed to fetch user for portal login audit');
        sendRouteError(request, reply, 'User not found', 404);
        return {} as { success: boolean };
      }

      if (!isAllowedUserType(user.user_type)) {
        logger.warn(
          { userId: user.user_id, userType: user.user_type },
          'Blocked portal login audit for invalid role'
        );
        sendRouteError(request, reply, 'Unauthorized role', 403);
        return {} as { success: boolean };
      }

      if (!PORTAL_LOGIN_AUDIT_USER_TYPES.includes(user.user_type)) {
        sendRouteError(request, reply, 'Portal access required', 403);
        return {} as { success: boolean };
      }

      void writeLoginAudit(
        supabase,
        {
          user_id: user.user_id,
          user_name: user.user_name,
          email: user.email,
          profile_picture_url: user.profile_picture_url,
          user_type: user.user_type,
          notification_token: user.notification_token,
        },
        'admin_staff_portal'
      );

      return reply.code(202).send({ success: true });
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
        sendRouteError(request, reply, 'Unauthorized', 401);
        return {} as UpdateProfileResponse;
      }

      const updates = request.body;
      const userId = request.user.user_id;

      // Validate at least one field is being updated
      if (Object.keys(updates).length === 0) {
        sendRouteError(request, reply, 'No update fields provided', 400);
        return {} as UpdateProfileResponse;
      }

      const supabase = services.getSupabaseClient();

      const { data: updatedUser, error } = await supabase
        .from('user_table')
        .update(updates)
        .eq('user_id', userId)
        .select()
        .single();

      if (error || !updatedUser) {
        logger.error({ error, userId }, 'Failed to update user profile');
        sendRouteError(request, reply, 'Failed to update profile', 500);
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
        sendRouteError(request, reply, 'Unauthorized', 401);
        return;
      }

      if (!oauthClient) {
        sendRouteError(request, reply, 'Google OAuth not configured', 500);
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
          sendRouteError(request, reply, 'Invalid Google token or no picture available', 400);
          return;
        }

        // Verify the token belongs to the current user
        if (!request.user.email || payload.email.trim().toLowerCase() !== request.user.email.toLowerCase()) {
          sendRouteError(request, reply, 'Token does not match current user', 403);
          return;
        }

        const supabase = services.getSupabaseClient();

        // Upload profile picture
        const uploadedUrl = await uploadProfilePicture(supabase, request.user.user_id, payload.picture);

        if (!uploadedUrl) {
          sendRouteError(request, reply, 'Failed to upload profile picture', 500);
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
          sendRouteError(request, reply, 'Failed to update profile', 500);
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
        sendRouteError(request, reply, 'Failed to update profile picture', 500);
        return;
      }
    }
  );
}
