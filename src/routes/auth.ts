import { FastifyInstance, FastifyRequest } from 'fastify';
import { OAuth2Client } from 'google-auth-library';
import jwt from 'jsonwebtoken';
import { getSupabaseClient } from '../services/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { AuthLoginRequest, AuthLoginResponse, AuthMeResponse, UserProfile } from '../types/auth.js';
import logger from '../utils/logger.js';

const JWT_SECRET: string = (() => {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET environment variable is required');
  }
  return secret;
})();
const JWT_EXPIRY = process.env.JWT_EXPIRY || '7d';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;

const oauthClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;

export default async function authRoutes(server: FastifyInstance) {
  // POST /auth/google - Login with Google ID token
  server.post<{ Body: AuthLoginRequest }>(
    '/google',
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
        if (!payload || !payload.email) {
          reply.status(400).send({ error: 'Invalid Google token' });
          return {} as AuthLoginResponse;
        }

        // Check if email is from allowed domain (UMak)
        const allowedDomain = process.env.ALLOWED_EMAIL_DOMAIN || 'umak.edu.ph';
        if (!payload.email.endsWith(`@${allowedDomain}`)) {
          reply.status(403).send({
            error: 'Access Denied',
            message: 'Please use your organization email to sign in',
          });
          return {} as AuthLoginResponse;
        }

        const supabase = getSupabaseClient();

        // Upsert user
        const { data: user, error: upsertError } = await supabase
          .from('user_table')
          .upsert(
            {
              user_id: payload.sub,
              email: payload.email,
              user_name: payload.name || null,
              profile_picture_url: payload.picture || null,
            },
            {
              onConflict: 'user_id',
            }
          )
          .select()
          .single();

        if (upsertError || !user) {
          logger.error({ error: upsertError }, 'Failed to upsert user');
          reply.status(500).send({ error: 'Failed to create user session' });
          return {} as AuthLoginResponse;
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
}
