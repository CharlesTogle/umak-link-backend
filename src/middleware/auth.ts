import { FastifyRequest, FastifyReply } from 'fastify';
import jwt from 'jsonwebtoken';
import { JwtPayload } from '../types/auth.js';
import logger from '../utils/logger.js';

const JWT_SECRET: string = (() => {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET environment variable is required');
  }
  return secret;
})();

export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const authHeader = request.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    reply.status(401).send({ error: 'Unauthorized', message: 'No token provided' });
    return;
  }

  const token = authHeader.replace('Bearer ', '');

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as JwtPayload;
    request.user = decoded;
  } catch (error) {
    logger.debug({ error }, 'Invalid token');
    reply.status(401).send({ error: 'Unauthorized', message: 'Invalid token' });
    return;
  }
}

export async function requireStaff(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  await requireAuth(request, reply);

  if (reply.sent) return;

  if (!request.user || !['Staff', 'Admin'].includes(request.user.user_type)) {
    reply.status(403).send({ error: 'Forbidden', message: 'Staff access required' });
  }
}

export async function requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  await requireAuth(request, reply);

  if (reply.sent) return;

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
