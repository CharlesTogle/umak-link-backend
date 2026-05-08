import { FastifyRequest, FastifyReply } from 'fastify';
import jwt from 'jsonwebtoken';
import { getSupabaseClient } from '../services/supabase.js';
import { isAllowedPortalEmail, normalizePortalEmail, syncPortalUserOnSignIn } from '../services/portal-users.js';
import { JwtPayload, UserType } from '../types/auth.js';
import logger from '../utils/logger.js';
import { extractBearerToken, getAuthorizationHeader } from '../utils/http-headers.js';
import { getPhilippineNowIso } from '../utils/time.js';

const JWT_SECRET: string = (() => {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET environment variable is required');
  }
  return secret;
})();

const ALLOWED_USER_TYPES: readonly UserType[] = ['User', 'Staff', 'Admin'];

function isAllowedUserType(value: unknown): value is UserType {
  return typeof value === 'string' && ALLOWED_USER_TYPES.includes(value as UserType);
}

function isJwtPayloadShape(decoded: string | jwt.JwtPayload): decoded is JwtPayload {
  if (!decoded || typeof decoded !== 'object') return false;
  if (typeof decoded.user_id !== 'string' || decoded.user_id.length === 0) return false;
  if (decoded.email !== null && typeof decoded.email !== 'string') return false;
  return isAllowedUserType(decoded.user_type);
}

function normalizeNameToTitleCase(name: string | null | undefined): string | null {
  if (!name) return null;

  return name
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function getUserMetadataValue(
  metadata: Record<string, unknown> | undefined,
  key: string
): string | null {
  const value = metadata?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

async function resolvePortalUserFromSupabaseToken(token: string): Promise<JwtPayload | null> {
  try {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.auth.getUser(token);
    const authUser = data.user;

    if (error || !authUser?.email) {
      logger.debug({ error }, 'Supabase token validation failed');
      return null;
    }

    const normalizedEmail = normalizePortalEmail(authUser.email);
    if (!isAllowedPortalEmail(normalizedEmail)) {
      logger.warn({ email: normalizedEmail }, 'Blocked Supabase-authenticated user from unauthorized email domain');
      return null;
    }

    const normalizedName = normalizeNameToTitleCase(
      getUserMetadataValue(authUser.user_metadata, 'full_name') ??
      getUserMetadataValue(authUser.user_metadata, 'name')
    );
    const profilePictureUrl =
      getUserMetadataValue(authUser.user_metadata, 'avatar_url') ??
      getUserMetadataValue(authUser.user_metadata, 'picture');

    const loginTimestamp = getPhilippineNowIso();
    const upsertedUser = await syncPortalUserOnSignIn(supabase, {
      email: normalizedEmail,
      userName: normalizedName,
      loginTimestamp,
    });

    if (!upsertedUser || !isAllowedUserType(upsertedUser.user_type)) {
      logger.warn({ email: normalizedEmail }, 'Failed to resolve portal user from Supabase-authenticated user');
      return null;
    }

    if (profilePictureUrl) {
      await supabase
        .from('user_table')
        .update({ profile_picture_url: profilePictureUrl })
        .eq('user_id', upsertedUser.user_id);
    }

    return {
      user_id: upsertedUser.user_id,
      email: upsertedUser.email,
      user_type: upsertedUser.user_type,
    };
  } catch (error) {
    logger.debug({ error }, 'Supabase auth resolution unavailable');
    return null;
  }
}

async function syncAuthoritativeUser(request: FastifyRequest): Promise<boolean> {
  if (!request.user) return false;

  const supabase = getSupabaseClient();
  const { data: user, error } = await supabase
    .from('user_table')
    .select('email, user_type')
    .eq('user_id', request.user.user_id)
    .single();

  if (error || !user || !isAllowedUserType(user.user_type)) {
    logger.warn({ userId: request.user.user_id, error }, 'Failed to load authoritative user for auth guard');
    return false;
  }

  if (request.user.email && user.email && request.user.email !== user.email) {
    logger.warn(
      { userId: request.user.user_id, tokenEmail: request.user.email, dbEmail: user.email },
      'Email mismatch between token and database'
    );
    return false;
  }

  if (request.user.user_type !== user.user_type) {
    logger.warn(
      { userId: request.user.user_id, tokenRole: request.user.user_type, dbRole: user.user_type },
      'Role mismatch between token and database'
    );
  }

  request.user = {
    ...request.user,
    email: user.email,
    user_type: user.user_type,
  };
  return true;
}

export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const authorizationHeader = getAuthorizationHeader(request);
  const token = extractBearerToken(authorizationHeader);
  if (!token) {
    logger.warn(
      {
        requestAuthorizationHeaderPresent: typeof authorizationHeader === 'string',
        requestAuthorizationScheme: authorizationHeader?.trim().split(/\s+/, 1)[0] ?? null,
        requestHeadersAuthorizationPresent: typeof request.headers.authorization !== 'undefined',
        rawHeadersAuthorizationPresent: typeof request.raw.headers.authorization !== 'undefined',
      },
      'Missing or malformed authorization header'
    );
    reply.status(401).send({ error: 'Unauthorized', message: 'No token provided' });
    return;
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET, {
      algorithms: ['HS256'],
    });

    if (!isJwtPayloadShape(decoded)) {
      reply.status(401).send({ error: 'Unauthorized', message: 'Invalid token payload' });
      return;
    }

    request.user = {
      user_id: decoded.user_id,
      email: decoded.email,
      user_type: decoded.user_type,
      iat: decoded.iat,
      exp: decoded.exp,
    };
    return;
  } catch (error) {
    logger.debug({ error }, 'Token was not a valid legacy JWT, trying Supabase auth');
  }

  const supabaseUser = await resolvePortalUserFromSupabaseToken(token);
  if (!supabaseUser) {
    reply.status(401).send({ error: 'Unauthorized', message: 'Invalid token' });
    return;
  }

  request.user = supabaseUser;
}

export async function requireStaff(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  await requireAuth(request, reply);

  if (reply.sent) return;
  const isSynced = await syncAuthoritativeUser(request);
  if (!isSynced) {
    reply.status(401).send({ error: 'Unauthorized', message: 'Session validation failed' });
    return;
  }

  if (!request.user || !['Staff', 'Admin'].includes(request.user.user_type)) {
    reply.status(403).send({ error: 'Forbidden', message: 'Staff access required' });
  }
}

export async function requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  await requireAuth(request, reply);

  if (reply.sent) return;
  const isSynced = await syncAuthoritativeUser(request);
  if (!isSynced) {
    reply.status(401).send({ error: 'Unauthorized', message: 'Session validation failed' });
    return;
  }

  if (!request.user || request.user.user_type !== 'Admin') {
    reply.status(403).send({ error: 'Forbidden', message: 'Admin access required' });
  }
}

// Helper functions matching DB role helpers
export function isStaff(userType: string): boolean {
  return userType === 'Staff';
}

export function isAdmin(userType: string): boolean {
  return userType === 'Admin';
}

export function isStaffOrAdmin(userType: string): boolean {
  return userType === 'Staff' || userType === 'Admin';
}
