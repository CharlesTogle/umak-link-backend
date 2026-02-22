import { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import logger from '../utils/logger.js';

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

  reply.status(statusCode).send({
    error: error.name || 'InternalServerError',
    message: error.message || 'An unexpected error occurred',
    statusCode,
  });
}
