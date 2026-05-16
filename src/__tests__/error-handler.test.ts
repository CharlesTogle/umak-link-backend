import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { errorHandler } from '../middleware/error-handler.js';
import { createHttpError } from '../utils/http-error.js';

test('global error handler serializes safe 403 responses', async () => {
  const app = Fastify();
  app.setErrorHandler(errorHandler);
  app.get('/forbidden', async () => {
    throw createHttpError('Only staff can do this action', 403);
  });

  const response = await app.inject({
    method: 'GET',
    url: '/forbidden',
  });

  assert.equal(response.statusCode, 403);
  assert.deepEqual(response.json(), {
    statusCode: 403,
    error: 'Forbidden',
    code: 'FORBIDDEN',
    message: 'Forbidden',
    requestId: response.json().requestId,
  });
  assert.equal(typeof response.json().requestId, 'string');

  await app.close();
});

test('global error handler sets Retry-After and safe 429 payloads', async () => {
  const app = Fastify();
  app.setErrorHandler(errorHandler);
  app.get('/rate-limited', async () => {
    throw createHttpError('Too many requests for this action', 429, {
      retryAfterSeconds: 5,
    });
  });

  const response = await app.inject({
    method: 'GET',
    url: '/rate-limited',
  });

  assert.equal(response.statusCode, 429);
  assert.equal(response.headers['retry-after'], '5');
  assert.deepEqual(response.json(), {
    statusCode: 429,
    error: 'Rate Limited',
    code: 'RATE_LIMITED',
    message: 'Rate Limited',
    requestId: response.json().requestId,
    retryAfterSeconds: 5,
  });

  await app.close();
});

test('global error handler does not leak raw unexpected error messages', async () => {
  const app = Fastify();
  app.setErrorHandler(errorHandler);
  app.get('/explode', async () => {
    throw new Error('relation internal_admin_only_table does not exist');
  });

  const response = await app.inject({
    method: 'GET',
    url: '/explode',
  });

  assert.equal(response.statusCode, 500);
  assert.deepEqual(response.json(), {
    statusCode: 500,
    error: 'Internal Server Error',
    code: 'INTERNAL_SERVER_ERROR',
    message: 'Internal Server Error',
    requestId: response.json().requestId,
  });
  assert.equal(response.body.includes('internal_admin_only_table'), false);

  await app.close();
});
