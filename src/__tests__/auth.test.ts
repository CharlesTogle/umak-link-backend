import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import jwt from 'jsonwebtoken';
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

test('GET /auth/me with malformed bearer token returns 401', async () => {
  const app = Fastify();
  await app.register(authRoutes, { prefix: '/auth' });

  const res = await app.inject({
    method: 'GET',
    url: '/auth/me',
    headers: {
      authorization: 'Bearer not-a-jwt-token',
    },
  });

  assert.equal(res.statusCode, 401);
  await app.close();
});

test('GET /auth/me rejects injected user_type claim', async () => {
  const app = Fastify();
  await app.register(authRoutes, { prefix: '/auth' });

  const token = jwt.sign(
    {
      user_id: '00000000-0000-0000-0000-000000000000',
      email: 'test@umak.edu.ph',
      user_type: 'SuperAdmin',
    },
    process.env.JWT_SECRET || 'test_secret_for_tests',
    { algorithm: 'HS256' }
  );

  const res = await app.inject({
    method: 'GET',
    url: '/auth/me',
    headers: {
      authorization: `Bearer ${token}`,
    },
  });

  assert.equal(res.statusCode, 401);
  await app.close();
});
