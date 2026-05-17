import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import jwt from 'jsonwebtoken';
import { maybeSyncProfilePictureFromSupabaseMetadata, requireAuth } from '../middleware/auth.js';
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

test('POST /auth/portal-login-audit accepts guard users and records a guard portal audit', async () => {
  const app = Fastify();
  let capturedRpcArgs: Record<string, unknown> | null = null;

  await app.register(authRoutes, {
    prefix: '/auth',
    services: {
      getSupabaseClient: () =>
        ({
          from(table: string) {
            assert.equal(table, 'user_table');
            return {
              select() {
                return {
                  eq(column: string, value: string) {
                    assert.equal(column, 'user_id');
                    assert.equal(value, 'guard-1');
                    return {
                      async single() {
                        return {
                          data: {
                            user_id: 'guard-1',
                            user_name: 'Guard User',
                            email: 'guard-1@umak.edu.ph',
                            profile_picture_url: null,
                            user_type: 'Guard',
                            notification_token: null,
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
          async rpc(functionName: string, args: Record<string, unknown>) {
            assert.equal(functionName, 'insert_audit_log');
            capturedRpcArgs = args;
            return { data: 'audit-1', error: null };
          },
        }) as never,
    },
  });

  const token = jwt.sign(
    {
      user_id: 'guard-1',
      email: 'guard-1@umak.edu.ph',
      user_type: 'Guard',
    },
    process.env.JWT_SECRET || 'test_secret_for_tests',
    { algorithm: 'HS256' }
  );

  const res = await app.inject({
    method: 'POST',
    url: '/auth/portal-login-audit',
    headers: {
      authorization: `Bearer ${token}`,
    },
  });

  assert.equal(res.statusCode, 202);
  assert.deepEqual(JSON.parse(res.body), { success: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(capturedRpcArgs, {
    p_user_id: 'guard-1',
    p_action_type: 'account_login',
    p_target_entity_type: 'user_table',
    p_target_entity_id: 'guard-1',
    p_details: {
      message: 'Guard Guard User signed into guard portal',
      login_source: 'admin_staff_portal',
      user_type: 'Guard',
      user_name: 'Guard User',
      user_email: 'guard-1@umak.edu.ph',
    },
  });

  await app.close();
});

test('POST /auth/portal-login-audit still succeeds when the audit log write fails', async () => {
  const app = Fastify();
  let rpcAttempted = false;

  await app.register(authRoutes, {
    prefix: '/auth',
    services: {
      getSupabaseClient: () =>
        ({
          from() {
            return {
              select() {
                return {
                  eq() {
                    return {
                      async single() {
                        return {
                          data: {
                            user_id: 'staff-1',
                            user_name: 'Staff User',
                            email: 'staff-1@umak.edu.ph',
                            profile_picture_url: null,
                            user_type: 'Staff',
                            notification_token: null,
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
          async rpc() {
            rpcAttempted = true;
            throw new Error('insert failed');
          },
        }) as never,
    },
  });

  const token = jwt.sign(
    {
      user_id: 'staff-1',
      email: 'staff-1@umak.edu.ph',
      user_type: 'Staff',
    },
    process.env.JWT_SECRET || 'test_secret_for_tests',
    { algorithm: 'HS256' }
  );

  const res = await app.inject({
    method: 'POST',
    url: '/auth/portal-login-audit',
    headers: {
      authorization: `Bearer ${token}`,
    },
  });

  assert.equal(res.statusCode, 202);
  assert.deepEqual(JSON.parse(res.body), { success: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(rpcAttempted, true);

  await app.close();
});

test('requireAuth accepts an uppercase Authorization header', async () => {
  const app = Fastify();
  app.get(
    '/protected',
    {
      preHandler: [requireAuth],
    },
    async (request) => ({
      user: request.user,
    })
  );

  const token = jwt.sign(
    {
      user_id: '00000000-0000-0000-0000-000000000000',
      email: 'test@umak.edu.ph',
      user_type: 'User',
    },
    process.env.JWT_SECRET || 'test_secret_for_tests',
    { algorithm: 'HS256' }
  );

  const res = await app.inject({
    method: 'GET',
    url: '/protected',
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.user.user_id, '00000000-0000-0000-0000-000000000000');
  assert.equal(body.user.email, 'test@umak.edu.ph');
  assert.equal(body.user.user_type, 'User');
  assert.equal(typeof body.user.iat, 'number');

  await app.close();
});

test('maybeSyncProfilePictureFromSupabaseMetadata ignores raw Google avatar URLs', async () => {
  const calls: Array<{
    table: string;
    values: Record<string, unknown>;
    column: string;
    value: string;
  }> = [];

  const fakeSupabase = {
    from(table: string) {
      return {
        update(values: Record<string, unknown>) {
          return {
            async eq(column: string, value: string) {
              calls.push({ table, values, column, value });
              return { error: null };
            },
          };
        },
      };
    },
  } as never;

  const didSync = await maybeSyncProfilePictureFromSupabaseMetadata(
    fakeSupabase,
    'user-123',
    'https://lh3.googleusercontent.com/a/ACg8ocExample=s96-c'
  );

  assert.equal(didSync, false);
  assert.equal(calls.length, 0);
});

test('maybeSyncProfilePictureFromSupabaseMetadata persists object-storage profile picture URLs', async () => {
  const calls: Array<{
    table: string;
    values: Record<string, unknown>;
    column: string;
    value: string;
  }> = [];

  const fakeSupabase = {
    from(table: string) {
      return {
        update(values: Record<string, unknown>) {
          return {
            async eq(column: string, value: string) {
              calls.push({ table, values, column, value });
              return { error: null };
            },
          };
        },
      };
    },
  } as never;

  const objectUrl = 'https://project.supabase.co/storage/v1/object/public/profilePictures/users/user-123/avatar.webp';
  const didSync = await maybeSyncProfilePictureFromSupabaseMetadata(fakeSupabase, 'user-123', objectUrl);

  assert.equal(didSync, true);
  assert.deepEqual(calls, [
    {
      table: 'user_table',
      values: { profile_picture_url: objectUrl },
      column: 'user_id',
      value: 'user-123',
    },
  ]);
});
