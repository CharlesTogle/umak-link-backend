import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import jwt from 'jsonwebtoken';
import { setAuthSupabaseClientFactoryForTests } from '../middleware/auth.js';
import postsRoutes from '../routes/posts.js';
import { UserType } from '../types/auth.js';

const JWT_SECRET = process.env.JWT_SECRET || 'test_secret_for_tests';

function createToken(userType: UserType, userId = 'user-1', email = 'user-1@umak.edu.ph'): string {
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

function createPostsAuthSupabase(userType: UserType, email: string) {
  return {
    from(table: string) {
      assert.equal(table, 'user_table');

      return {
        select() {
          return {
            eq() {
              return {
                async single() {
                  return {
                    data: {
                      email,
                      user_type: userType,
                    },
                    error: null,
                  };
                },
              };
            },
          };
        },
      };
    },
  } as never;
}

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
      p_image_link: 'https://example.com/items/wallet.webp',
      p_last_seen_date: '2026-05-14',
      p_last_seen_hours: 10,
      p_last_seen_minutes: 30,
      p_location_path: [{ name: 'Lobby', type: 'building' }],
    },
  });

  assert.equal(res.statusCode, 401);
  await app.close();
});

test('POST /posts recomputes custody status for found items after creation', async () => {
  const app = Fastify();
  const rpcCalls: Array<{ functionName: string; args: Record<string, unknown> }> = [];
  const fakeSupabase = {
    async rpc(functionName: string, args: Record<string, unknown>) {
      rpcCalls.push({ functionName, args });

      if (functionName === 'create_post_with_item_date_time_location') {
        return {
          data: 123,
          error: null,
        };
      }

      if (functionName === 'recompute_item_custody_status') {
        return {
          data: 'with_reporter',
          error: null,
        };
      }

      throw new Error(`Unexpected RPC call: ${functionName}`);
    },
    from(table: string) {
      assert.equal(table, 'post_public_view');

      return {
        select(columns: string) {
          assert.equal(columns, 'post_id, item_id, item_type');

          return {
            eq(column: string, value: number) {
              assert.equal(column, 'post_id');
              assert.equal(value, 123);

              return {
                async single() {
                  return {
                    data: {
                      post_id: 123,
                      item_id: 'item-123',
                      item_type: 'found',
                    },
                    error: null,
                  };
                },
              };
            },
          };
        },
      };
    },
  } as never;

  await app.register(postsRoutes, {
    prefix: '/posts',
    writeRouteOptions: {
      getSupabase: () => fakeSupabase,
    },
  });

  const res = await app.inject({
    method: 'POST',
    url: '/posts',
    headers: {
      authorization: `Bearer ${createToken('User')}`,
    },
    payload: {
      p_item_name: 'Wallet',
      p_item_type: 'found',
      p_image_hash: 'hash',
      p_image_link: 'https://example.com/items/wallet.webp',
      p_last_seen_date: '2026-05-14',
      p_last_seen_hours: 10,
      p_last_seen_minutes: 30,
      p_location_path: [{ name: 'Lobby', type: 'building' }],
    },
  });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { post_id: 123 });
  assert.deepEqual(
    rpcCalls.map((call) => call.functionName),
    ['create_post_with_item_date_time_location', 'recompute_item_custody_status']
  );
  assert.deepEqual(rpcCalls[0]?.args, {
    p_item_name: 'Wallet',
    p_item_description: undefined,
    p_item_type: 'found',
    p_poster_id: 'user-1',
    p_image_hash: 'hash',
    p_image_link: 'https://example.com/items/wallet.webp',
    p_category: undefined,
    p_last_seen_date: '2026-05-14',
    p_last_seen_hours: 10,
    p_last_seen_minutes: 30,
    p_item_status: 'unclaimed',
    p_post_status: 'pending',
    p_location_path: [{ name: 'Lobby', type: 'building' }],
    p_is_anonymous: undefined,
  });
  assert.deepEqual(rpcCalls[1]?.args, {
    p_post_id: 123,
    p_item_id: 'item-123',
  });

  await app.close();
});

test('POST /posts creates an initial security office custody record for staff-created found items', async () => {
  const app = Fastify();
  const rpcCalls: Array<{ functionName: string; args: Record<string, unknown> }> = [];
  const custodyRecordInserts: Array<Record<string, unknown>> = [];
  const fakeSupabase = {
    async rpc(functionName: string, args: Record<string, unknown>) {
      rpcCalls.push({ functionName, args });

      if (functionName === 'create_post_with_item_date_time_location') {
        return {
          data: 456,
          error: null,
        };
      }

      throw new Error(`Unexpected RPC call: ${functionName}`);
    },
    from(table: string) {
      if (table === 'post_public_view') {
        return {
          select(columns: string) {
            assert.equal(columns, 'post_id, item_id, item_type');

            return {
              eq(column: string, value: number) {
                assert.equal(column, 'post_id');
                assert.equal(value, 456);

                return {
                  async single() {
                    return {
                      data: {
                        post_id: 456,
                        item_id: 'item-456',
                        item_type: 'found',
                      },
                      error: null,
                    };
                  },
                };
              },
            };
          },
        };
      }

      if (table === 'custody_record_table') {
        return {
          async insert(payload: Record<string, unknown>) {
            custodyRecordInserts.push(payload);
            return {
              error: null,
            };
          },
        };
      }

      throw new Error(`Unexpected table access: ${table}`);
    },
  } as never;

  await app.register(postsRoutes, {
    prefix: '/posts',
    writeRouteOptions: {
      getSupabase: () => fakeSupabase,
    },
  });

  const res = await app.inject({
    method: 'POST',
    url: '/posts',
    headers: {
      authorization: `Bearer ${createToken('Staff', 'staff-1', 'staff-1@umak.edu.ph')}`,
    },
    payload: {
      p_item_name: 'ID Lace',
      p_item_type: 'found',
      p_image_hash: 'hash',
      p_image_link: 'https://example.com/items/id-lace.webp',
      p_last_seen_date: '2026-05-14',
      p_last_seen_hours: 11,
      p_last_seen_minutes: 45,
      p_location_path: [{ name: 'Security Office', type: 'office' }],
    },
  });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { post_id: 456 });
  assert.deepEqual(
    rpcCalls.map((call) => call.functionName),
    ['create_post_with_item_date_time_location']
  );
  assert.deepEqual(rpcCalls[0]?.args, {
    p_item_name: 'ID Lace',
    p_item_description: undefined,
    p_item_type: 'found',
    p_poster_id: 'staff-1',
    p_image_hash: 'hash',
    p_image_link: 'https://example.com/items/id-lace.webp',
    p_category: undefined,
    p_last_seen_date: '2026-05-14',
    p_last_seen_hours: 11,
    p_last_seen_minutes: 45,
    p_item_status: 'unclaimed',
    p_post_status: 'pending',
    p_location_path: [{ name: 'Security Office', type: 'office' }],
    p_is_anonymous: undefined,
  });
  assert.equal(custodyRecordInserts.length, 1);
  assert.equal(custodyRecordInserts[0]?.post_id, 456);
  assert.equal(custodyRecordInserts[0]?.item_id, 'item-456');
  assert.equal(custodyRecordInserts[0]?.actor_user_id, 'staff-1');
  assert.equal(custodyRecordInserts[0]?.record_type, 'security_office_received');
  assert.equal(custodyRecordInserts[0]?.visible_to_poster, true);
  assert.deepEqual(custodyRecordInserts[0]?.details, {
    source: 'staff_created_post',
  });
  assert.equal(typeof custodyRecordInserts[0]?.occurred_at, 'string');

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

test('GET /posts/:id/full allows staff to fetch any post', { concurrency: false }, async (t) => {
  const app = Fastify();
  const fakeSupabase = {
    from(table: string) {
      assert.equal(table, 'v_post_records_details');

      return {
        select(columns: string) {
          assert.equal(columns, '*');

          return {
            eq(column: string, value: number) {
              assert.equal(column, 'post_id');
              assert.equal(value, 42);

              return {
                async single() {
                  return {
                    data: {
                      post_id: 42,
                      poster_id: 'user-2',
                      item_name: 'Umbrella',
                    },
                    error: null,
                  };
                },
              };
            },
          };
        },
      };
    },
  } as never;

  await app.register(postsRoutes, {
    prefix: '/posts',
    readRouteOptions: {
      getSupabase: () => fakeSupabase,
    },
  });

  setAuthSupabaseClientFactoryForTests(() =>
    createPostsAuthSupabase('Staff', 'staff-1@umak.edu.ph')
  );
  t.after(() => setAuthSupabaseClientFactoryForTests(null));

  const res = await app.inject({
    method: 'GET',
    url: '/posts/42/full',
    headers: {
      authorization: `Bearer ${createToken('Staff', 'staff-1', 'staff-1@umak.edu.ph')}`,
    },
  });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), {
    post_id: 42,
    poster_id: 'user-2',
    item_name: 'Umbrella',
  });

  await app.close();
});

test('GET /posts/:id/full allows a user to fetch their own post', { concurrency: false }, async (t) => {
  const app = Fastify();
  const fakeSupabase = {
    from(table: string) {
      if (table === 'post_public_view') {
        return {
          select(columns: string) {
            assert.equal(columns, 'poster_id');

            return {
              eq(column: string, value: number) {
                assert.equal(column, 'post_id');
                assert.equal(value, 42);

                return {
                  async single() {
                    return {
                      data: {
                        poster_id: 'user-1',
                      },
                      error: null,
                    };
                  },
                };
              },
            };
          },
        };
      }

      if (table === 'v_post_records_details') {
        return {
          select(columns: string) {
            assert.equal(columns, '*');

            return {
              eq(column: string, value: number) {
                assert.equal(column, 'post_id');
                assert.equal(value, 42);

                return {
                  async single() {
                    return {
                      data: {
                        post_id: 42,
                        poster_id: 'user-1',
                        item_name: 'Wallet',
                      },
                      error: null,
                    };
                  },
                };
              },
            };
          },
        };
      }

      throw new Error(`Unexpected table access: ${table}`);
    },
  } as never;

  await app.register(postsRoutes, {
    prefix: '/posts',
    readRouteOptions: {
      getSupabase: () => fakeSupabase,
    },
  });

  setAuthSupabaseClientFactoryForTests(() =>
    createPostsAuthSupabase('User', 'user-1@umak.edu.ph')
  );
  t.after(() => setAuthSupabaseClientFactoryForTests(null));

  const res = await app.inject({
    method: 'GET',
    url: '/posts/42/full',
    headers: {
      authorization: `Bearer ${createToken('User', 'user-1', 'user-1@umak.edu.ph')}`,
    },
  });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), {
    post_id: 42,
    poster_id: 'user-1',
    item_name: 'Wallet',
  });

  await app.close();
});

test("GET /posts/:id/full rejects a user fetching another user's post", { concurrency: false }, async (t) => {
  const app = Fastify();
  const fakeSupabase = {
    from(table: string) {
      assert.equal(table, 'post_public_view');

      return {
        select(columns: string) {
          assert.equal(columns, 'poster_id');

          return {
            eq(column: string, value: number) {
              assert.equal(column, 'post_id');
              assert.equal(value, 42);

              return {
                async single() {
                  return {
                    data: {
                      poster_id: 'user-2',
                    },
                    error: null,
                  };
                },
              };
            },
          };
        },
      };
    },
  } as never;

  await app.register(postsRoutes, {
    prefix: '/posts',
    readRouteOptions: {
      getSupabase: () => fakeSupabase,
    },
  });

  setAuthSupabaseClientFactoryForTests(() =>
    createPostsAuthSupabase('User', 'user-1@umak.edu.ph')
  );
  t.after(() => setAuthSupabaseClientFactoryForTests(null));

  const res = await app.inject({
    method: 'GET',
    url: '/posts/42/full',
    headers: {
      authorization: `Bearer ${createToken('User', 'user-1', 'user-1@umak.edu.ph')}`,
    },
  });

  assert.equal(res.statusCode, 403);
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
