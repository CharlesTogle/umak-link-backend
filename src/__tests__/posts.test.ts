import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import postsRoutes from '../routes/posts.js';

test('POST /posts invalid body returns 400', async () => {
  const app = Fastify();
  await app.register(postsRoutes, { prefix: '/posts' });

  const res = await app.inject({
    method: 'POST',
    url: '/posts',
    payload: { p_item_name: '' },
  });

  assert.equal(res.statusCode, 400);
  await app.close();
});

test('POST /posts without auth returns 401', async () => {
  const app = Fastify();
  await app.register(postsRoutes, { prefix: '/posts' });

  const res = await app.inject({
    method: 'POST',
    url: '/posts',
    payload: {
      p_item_name: 'Wallet',
      p_item_type: 'found',
      p_image_hash: 'hash',
      p_location_path: [{ name: 'Lobby', type: 'building' }],
    },
  });

  assert.equal(res.statusCode, 401);
  await app.close();
});

test('GET /posts/:id/full without auth returns 401', async () => {
  const app = Fastify();
  await app.register(postsRoutes, { prefix: '/posts' });

  const res = await app.inject({
    method: 'GET',
    url: '/posts/1/full',
  });

  assert.equal(res.statusCode, 401);
  await app.close();
});

test('PUT /posts/:id/status without auth returns 401', async () => {
  const app = Fastify();
  await app.register(postsRoutes, { prefix: '/posts' });

  const res = await app.inject({
    method: 'PUT',
    url: '/posts/1/status',
    payload: { status: 'accepted' },
  });

  assert.equal(res.statusCode, 401);
  await app.close();
});

test('PUT /posts/items/:id/status without auth returns 401', async () => {
  const app = Fastify();
  await app.register(postsRoutes, { prefix: '/posts' });

  const res = await app.inject({
    method: 'PUT',
    url: '/posts/items/1/status',
    payload: { status: 'claimed' },
  });

  assert.equal(res.statusCode, 401);
  await app.close();
});

test('PUT /posts/:id/edit-with-image without auth returns 401', async () => {
  const app = Fastify();
  await app.register(postsRoutes, { prefix: '/posts' });

  const res = await app.inject({
    method: 'PUT',
    url: '/posts/1/edit-with-image',
    payload: {},
  });

  assert.equal(res.statusCode, 401);
  await app.close();
});

test('DELETE /posts/:id without auth returns 401', async () => {
  const app = Fastify();
  await app.register(postsRoutes, { prefix: '/posts' });

  const res = await app.inject({
    method: 'DELETE',
    url: '/posts/1',
  });

  assert.equal(res.statusCode, 401);
  await app.close();
});
