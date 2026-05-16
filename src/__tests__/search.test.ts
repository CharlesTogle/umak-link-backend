import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import jwt from 'jsonwebtoken';
import { errorHandler } from '../middleware/error-handler.js';
import searchRoutes from '../routes/search.js';
import { UserType } from '../types/auth.js';

const JWT_SECRET = process.env.JWT_SECRET || 'test_secret_for_tests';

function createToken(
  userType: UserType,
  userId = 'user-1',
  email = 'user-1@umak.edu.ph'
): string {
  return jwt.sign(
    {
      user_id: userId,
      email,
      user_type: userType,
    },
    JWT_SECRET,
    { algorithm: 'HS256' }
  );
}

test(
  'POST /search/image-query allows authenticated users past the role gate',
  { concurrency: false },
  async () => {
    const app = Fastify();
    app.setErrorHandler(errorHandler);
    await app.register(searchRoutes, { prefix: '/search' });

    const res = await app.inject({
      method: 'POST',
      url: '/search/image-query',
      headers: {
        authorization: `Bearer ${createToken('User')}`,
      },
      payload: {},
    });

    assert.equal(res.statusCode, 400);

    await app.close();
  }
);
