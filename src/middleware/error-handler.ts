import { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import logger from '../utils/logger.js';
import { buildApiErrorResponse } from '../utils/http-error.js';

export async function errorHandler(
  error: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const statusCode = error.statusCode || 500;

  logger.error({
    error: error.message,
    stack: error.stack,
    statusCode,
    method: request.method,
    url: request.url,
  }, 'Request error');

  const errorResponse = buildApiErrorResponse(error, request.id);

  if (typeof errorResponse.retryAfterSeconds === 'number') {
    reply.header('Retry-After', String(errorResponse.retryAfterSeconds));
  }

  reply.status(statusCode).send(errorResponse);
}
