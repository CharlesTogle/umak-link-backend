import { FastifyRequest, FastifyReply } from 'fastify';
import jwt from 'jsonwebtoken';
import { getSupabaseClient } from '../services/supabase.js';
import { JwtPayload, UserType } from '../types/auth.js';
import logger from '../utils/logger.js';

const JWT_SECRET: string = (() => {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET environment variable is required');
  }
  return secret;
})();

const JWT_BEARER_PATTERN = /^Bearer ([A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+)$/;
const ALLOWED_USER_TYPES: readonly UserType[] = ['User', 'Staff', 'Admin'];

function isAllowedUserType(value: unknown): value is UserType {
  return typeof value === 'string' && ALLOWED_USER_TYPES.includes(value as UserType);
}

function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  const match = authHeader.match(JWT_BEARER_PATTERN);
  return match ? match[1] : null;
}

function isJwtPayloadShape(decoded: string | jwt.JwtPayload): decoded is JwtPayload {
  if (!decoded || typeof decoded !== 'object') return false;
  if (typeof decoded.user_id !== 'string' || decoded.user_id.length === 0) return false;
  if (decoded.email !== null && typeof decoded.email !== 'string') return false;
  return isAllowedUserType(decoded.user_type);
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
  const token = extractBearerToken(request.headers.authorization);
  if (!token) {
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
  } catch (error) {
    logger.debug({ error }, 'Invalid token');
    reply.status(401).send({ error: 'Unauthorized', message: 'Invalid token' });
    return;
  }
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
