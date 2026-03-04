import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import storageRoutes from '../routes/storage.js';

test('POST /storage/upload-url invalid body returns 400', async () => {
  const app = Fastify();
  await app.register(storageRoutes, { prefix: '/storage' });

  const res = await app.inject({
    method: 'POST',
    url: '/storage/upload-url',
    payload: { bucket: 'items' },
  });

  assert.equal(res.statusCode, 400);
  await app.close();
});
