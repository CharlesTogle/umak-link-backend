import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import authRoutes from '../routes/auth.js';

test('GET /auth/me without token returns 401', async () => {
  const app = Fastify();
  await app.register(authRoutes, { prefix: '/auth' });

  const res = await app.inject({
    method: 'GET',
    url: '/auth/me',
  });

  assert.equal(res.statusCode, 401);
  await app.close();
});

test('POST /auth/google with missing body returns 400', async () => {
  const app = Fastify();
  await app.register(authRoutes, { prefix: '/auth' });

  const res = await app.inject({
    method: 'POST',
    url: '/auth/google',
    payload: {},
  });

  assert.equal(res.statusCode, 400);
  await app.close();
});
