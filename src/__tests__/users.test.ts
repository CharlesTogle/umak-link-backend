import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import jwt from 'jsonwebtoken';
import { setAuthSupabaseClientFactoryForTests } from '../middleware/auth.js';
import { errorHandler } from '../middleware/error-handler.js';
import usersRoutes, { UserRouteServices, searchUsersWithCompatibleRpcSignature } from '../routes/users.js';
import { UserType } from '../types/auth.js';

const JWT_SECRET = process.env.JWT_SECRET || 'test_secret_for_tests';

function createToken(userType: UserType, userId = 'staff-1', email = 'staff-1@umak.edu.ph'): string {
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

function createAuthoritativeAuthSupabase(userType: UserType, email: string) {
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

test('searchUsersWithCompatibleRpcSignature uses canonical RPC args first', async () => {
  const calls: Array<{ functionName: string; args: Record<string, unknown> }> = [];
  const fakeSupabase = {
    async rpc(functionName: string, args: Record<string, unknown>) {
      calls.push({ functionName, args });
      return {
        data: [
          {
            user_id: 'user-1',
            user_name: 'Alice',
            email: 'alice@umak.edu.ph',
            profile_picture_url: null,
            user_type: 'User' as const,
            notification_token: null,
          },
        ],
        error: null,
      };
    },
  };

  const result = await searchUsersWithCompatibleRpcSignature(
    fakeSupabase,
    'search_users_secure_staff',
    'alice'
  );

  assert.equal(result.error, null);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    functionName: 'search_users_secure_staff',
    args: {
      search_query: 'alice',
      search_limit: 20,
    },
  });
});

test('searchUsersWithCompatibleRpcSignature retries with legacy args on schema-cache signature mismatch', async () => {
  const calls: Array<{ functionName: string; args: Record<string, unknown> }> = [];
  const fakeSupabase = {
    async rpc(functionName: string, args: Record<string, unknown>) {
      calls.push({ functionName, args });

      if (calls.length === 1) {
        return {
          data: null,
          error: {
            code: 'PGRST202',
            message: 'Could not find function in schema cache',
            details: 'Searched for the function public.search_users_secure_staff with parameter search_term.',
          },
        };
      }

      return {
        data: [
          {
            user_id: 'user-2',
            user_name: 'Bob',
            email: 'bob@umak.edu.ph',
            profile_picture_url: null,
            user_type: 'User' as const,
            notification_token: null,
          },
        ],
        error: null,
      };
    },
  };

  const result = await searchUsersWithCompatibleRpcSignature(
    fakeSupabase,
    'search_users_secure_staff',
    'bob',
    5
  );

  assert.equal(result.error, null);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], {
    functionName: 'search_users_secure_staff',
    args: {
      search_query: 'bob',
      search_limit: 5,
    },
  });
  assert.deepEqual(calls[1], {
    functionName: 'search_users_secure_staff',
    args: {
      search_term: 'bob',
    },
  });
});

test('searchUsersWithCompatibleRpcSignature does not retry non-signature errors', async () => {
  const calls: Array<{ functionName: string; args: Record<string, unknown> }> = [];
  const fakeSupabase = {
    async rpc(functionName: string, args: Record<string, unknown>) {
      calls.push({ functionName, args });
      return {
        data: null,
        error: {
          code: '42501',
          message: 'permission denied for function search_users_secure_staff',
        },
      };
    },
  };

  const result = await searchUsersWithCompatibleRpcSignature(
    fakeSupabase,
    'search_users_secure_staff',
    'charlie'
  );

  assert.equal(result.error?.code, '42501');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    functionName: 'search_users_secure_staff',
    args: {
      search_query: 'charlie',
      search_limit: 20,
    },
  });
});

test('GET /users/search maps RPC authorization errors to 403', { concurrency: false }, async (t) => {
  const app = Fastify();
  app.setErrorHandler(errorHandler);

  const services: UserRouteServices = {
    getSupabaseClient: () =>
      ({
        async rpc() {
          return {
            data: null,
            error: {
              code: 'P0001',
              message: 'Unauthorized: Only Staff can use this',
            },
          };
        },
      }) as never,
    generateClaimCode: () => 'AB2C3D',
  };

  await app.register(usersRoutes, {
    prefix: '/users',
    services,
  });

  setAuthSupabaseClientFactoryForTests(() =>
    createAuthoritativeAuthSupabase('Staff', 'staff-1@umak.edu.ph')
  );
  t.after(() => setAuthSupabaseClientFactoryForTests(null));

  const res = await app.inject({
    method: 'GET',
    url: '/users/search?query=seed',
    headers: {
      authorization: `Bearer ${createToken('Staff', 'staff-1', 'staff-1@umak.edu.ph')}`,
    },
  });

  assert.equal(res.statusCode, 403);
  assert.deepEqual(JSON.parse(res.body), {
    error: 'Error',
    message: 'Unauthorized: Only Staff can use this',
    statusCode: 403,
  });

  await app.close();
});

test('GET /users/claim-code/:code resolves a user by stored manual entry code', { concurrency: false }, async (t) => {
  const app = Fastify();
  app.setErrorHandler(errorHandler);
  const activeCodeExpiresAt = '2999-01-01T00:00:00.000Z';

  const services: UserRouteServices = {
    getSupabaseClient: () =>
      ({
        from(table: string) {
          assert.equal(table, 'user_table');

          return {
            select(columns: string) {
              assert.equal(
                columns,
                'user_id, user_name, email, profile_picture_url, user_type, claim_manual_entry_code_expires_at'
              );

              return {
                eq(column: string, value: string) {
                  assert.equal(column, 'user_type');
                  assert.equal(value, 'User');

                  return {
                    eq(innerColumn: string, innerValue: string) {
                      assert.equal(innerColumn, 'claim_manual_entry_code');
                      assert.equal(innerValue, 'AB2C3D');

                      return {
                        async single() {
                          return {
                            data: {
                              user_id: 'user-42',
                              user_name: 'Stefanie Gabion',
                              email: 'stefanie.gabion@umak.edu.ph',
                              profile_picture_url: null,
                              user_type: 'User',
                              claim_manual_entry_code_expires_at: activeCodeExpiresAt,
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
          };
        },
      }) as never,
    generateClaimCode: () => 'ZX7M2Q',
  };

  await app.register(usersRoutes, {
    prefix: '/users',
    services,
  });

  setAuthSupabaseClientFactoryForTests(() =>
    createAuthoritativeAuthSupabase('Staff', 'staff-1@umak.edu.ph')
  );
  t.after(() => setAuthSupabaseClientFactoryForTests(null));

  const res = await app.inject({
    method: 'GET',
    url: '/users/claim-code/ab2-c3d',
    headers: {
      authorization: `Bearer ${createToken('Staff', 'staff-1', 'staff-1@umak.edu.ph')}`,
    },
  });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), {
    user_id: 'user-42',
    user_name: 'Stefanie Gabion',
    email: 'stefanie.gabion@umak.edu.ph',
    profile_picture_url: null,
    user_type: 'User',
  });

  await app.close();
});

test('GET /users/claim-code/:code allows a guard to resolve a claim code for their active review post', { concurrency: false }, async (t) => {
  const app = Fastify();
  app.setErrorHandler(errorHandler);
  const activeCodeExpiresAt = '2999-01-01T00:00:00.000Z';

  const services: UserRouteServices = {
    getSupabaseClient: () =>
      ({
        from(table: string) {
          assert.equal(table, 'user_table');

          return {
            select(columns: string) {
              assert.equal(
                columns,
                'user_id, user_name, email, profile_picture_url, user_type, claim_manual_entry_code_expires_at'
              );

              return {
                eq(column: string, value: string) {
                  assert.equal(column, 'user_type');
                  assert.equal(value, 'User');

                  return {
                    eq(innerColumn: string, innerValue: string) {
                      assert.equal(innerColumn, 'claim_manual_entry_code');
                      assert.equal(innerValue, 'AB2C3D');

                      return {
                        async single() {
                          return {
                            data: {
                              user_id: 'user-42',
                              user_name: 'Stefanie Gabion',
                              email: 'stefanie.gabion@umak.edu.ph',
                              profile_picture_url: null,
                              user_type: 'User',
                              claim_manual_entry_code_expires_at: activeCodeExpiresAt,
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
          };
        },
      }) as never,
    generateClaimCode: () => 'ZX7M2Q',
    canGuardAccessClaimReview: async (postId: number, guardUserId: string) => {
      assert.equal(postId, 42);
      assert.equal(guardUserId, 'guard-1');
      return true;
    },
  };

  await app.register(usersRoutes, {
    prefix: '/users',
    services,
  });

  setAuthSupabaseClientFactoryForTests(() =>
    createAuthoritativeAuthSupabase('Guard', 'guard-1@umak.edu.ph')
  );
  t.after(() => setAuthSupabaseClientFactoryForTests(null));

  const res = await app.inject({
    method: 'GET',
    url: '/users/claim-code/ab2-c3d?found_post_id=42',
    headers: {
      authorization: `Bearer ${createToken('Guard', 'guard-1', 'guard-1@umak.edu.ph')}`,
    },
  });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), {
    user_id: 'user-42',
    user_name: 'Stefanie Gabion',
    email: 'stefanie.gabion@umak.edu.ph',
    profile_picture_url: null,
    user_type: 'User',
  });

  await app.close();
});

test('GET /users/claim-code/:code rejects an expired claim code', { concurrency: false }, async (t) => {
  const app = Fastify();
  app.setErrorHandler(errorHandler);
  const expiredCodeExpiresAt = '2000-01-01T00:00:00.000Z';

  const services: UserRouteServices = {
    getSupabaseClient: () =>
      ({
        from(table: string) {
          assert.equal(table, 'user_table');

          return {
            select(columns: string) {
              assert.equal(
                columns,
                'user_id, user_name, email, profile_picture_url, user_type, claim_manual_entry_code_expires_at'
              );

              return {
                eq(column: string, value: string) {
                  assert.equal(column, 'user_type');
                  assert.equal(value, 'User');

                  return {
                    eq(innerColumn: string, innerValue: string) {
                      assert.equal(innerColumn, 'claim_manual_entry_code');
                      assert.equal(innerValue, 'AB2C3D');

                      return {
                        async single() {
                          return {
                            data: {
                              user_id: 'user-42',
                              user_name: 'Stefanie Gabion',
                              email: 'stefanie.gabion@umak.edu.ph',
                              profile_picture_url: null,
                              user_type: 'User',
                              claim_manual_entry_code_expires_at: expiredCodeExpiresAt,
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
          };
        },
      }) as never,
    generateClaimCode: () => 'ZX7M2Q',
  };

  await app.register(usersRoutes, {
    prefix: '/users',
    services,
  });

  setAuthSupabaseClientFactoryForTests(() =>
    createAuthoritativeAuthSupabase('Staff', 'staff-1@umak.edu.ph')
  );
  t.after(() => setAuthSupabaseClientFactoryForTests(null));

  const res = await app.inject({
    method: 'GET',
    url: '/users/claim-code/ab2-c3d',
    headers: {
      authorization: `Bearer ${createToken('Staff', 'staff-1', 'staff-1@umak.edu.ph')}`,
    },
  });

  assert.equal(res.statusCode, 410);
  assert.deepEqual(JSON.parse(res.body), {
    error: 'Error',
    message: 'Claim QR expired. Ask the student to open the claim QR again.',
    statusCode: 410,
  });

  await app.close();
});

test('GET /users/claim-code/:code rejects a guard when the found post is not theirs to claim', { concurrency: false }, async (t) => {
  const app = Fastify();
  app.setErrorHandler(errorHandler);

  const services: UserRouteServices = {
    getSupabaseClient: () =>
      ({
        from() {
          throw new Error('Claim code lookup should not run when guard access is denied');
        },
      }) as never,
    generateClaimCode: () => 'ZX7M2Q',
    canGuardAccessClaimReview: async (postId: number, guardUserId: string) => {
      assert.equal(postId, 42);
      assert.equal(guardUserId, 'guard-1');
      return false;
    },
  };

  await app.register(usersRoutes, {
    prefix: '/users',
    services,
  });

  setAuthSupabaseClientFactoryForTests(() =>
    createAuthoritativeAuthSupabase('Guard', 'guard-1@umak.edu.ph')
  );
  t.after(() => setAuthSupabaseClientFactoryForTests(null));

  const res = await app.inject({
    method: 'GET',
    url: '/users/claim-code/ab2-c3d?found_post_id=42',
    headers: {
      authorization: `Bearer ${createToken('Guard', 'guard-1', 'guard-1@umak.edu.ph')}`,
    },
  });

  assert.equal(res.statusCode, 403);
  assert.deepEqual(JSON.parse(res.body), {
    error: 'Error',
    message: 'Guard can only resolve claim codes for items still in their custody review.',
    statusCode: 403,
  });

  await app.close();
});

test('GET /users/me/claim-code generates and stores a code when a user has none yet', { concurrency: false }, async (t) => {
  const app = Fastify();
  app.setErrorHandler(errorHandler);

  let selectCount = 0;
  const updates: Array<{ code: string; expiresAt: string }> = [];

  const services: UserRouteServices = {
    getSupabaseClient: () =>
      ({
        from(table: string) {
          assert.equal(table, 'user_table');

          return {
            select(columns: string) {
              if (
                columns ===
                'user_id, user_type, claim_manual_entry_code, claim_manual_entry_code_expires_at'
              ) {
                return {
                  eq(column: string, value: string) {
                    assert.equal(column, 'user_id');
                    assert.equal(value, 'user-1');

                    return {
                      async single() {
                        selectCount += 1;

                        return {
                          data: {
                            user_id: 'user-1',
                            user_type: 'User',
                            claim_manual_entry_code: selectCount === 1 ? null : 'AB2C3D',
                            claim_manual_entry_code_expires_at:
                              selectCount === 1 ? null : '2999-01-01T00:00:00.000Z',
                          },
                          error: null,
                        };
                      },
                    };
                  },
                };
              }

              assert.equal(
                columns,
                'claim_manual_entry_code, claim_manual_entry_code_expires_at'
              );

              return {
                eq(column: string, value: string) {
                  assert.equal(column, 'user_id');
                  assert.equal(value, 'user-1');

                  return {
                    async select(selectedColumns: string) {
                      assert.equal(
                        selectedColumns,
                        'claim_manual_entry_code, claim_manual_entry_code_expires_at'
                      );

                      const latestUpdate = updates.at(-1);
                      return {
                        data: latestUpdate
                          ? [{
                              claim_manual_entry_code: latestUpdate.code,
                              claim_manual_entry_code_expires_at: latestUpdate.expiresAt,
                            }]
                          : [],
                        error: null,
                      };
                    },
                  };
                },
              };
            },
            update(values: Record<string, unknown>) {
              updates.push({
                code: String(values.claim_manual_entry_code),
                expiresAt: String(values.claim_manual_entry_code_expires_at),
              });

              return {
                eq(column: string, value: string) {
                  assert.equal(column, 'user_id');
                  assert.equal(value, 'user-1');

                  return {
                    async select(selectedColumns: string) {
                      assert.equal(
                        selectedColumns,
                        'claim_manual_entry_code, claim_manual_entry_code_expires_at'
                      );

                      const latestUpdate = updates.at(-1);
                      return {
                        data: latestUpdate
                          ? [{
                              claim_manual_entry_code: latestUpdate.code,
                              claim_manual_entry_code_expires_at: latestUpdate.expiresAt,
                            }]
                          : [],
                        error: null,
                      };
                    },
                  };
                },
              };
            },
          };
        },
      }) as never,
    generateClaimCode: () => 'AB2C3D',
  };

  await app.register(usersRoutes, {
    prefix: '/users',
    services,
  });

  setAuthSupabaseClientFactoryForTests(() =>
    createAuthoritativeAuthSupabase('User', 'user-1@umak.edu.ph')
  );
  t.after(() => setAuthSupabaseClientFactoryForTests(null));

  const res = await app.inject({
    method: 'GET',
    url: '/users/me/claim-code',
    headers: {
      authorization: `Bearer ${createToken('User', 'user-1', 'user-1@umak.edu.ph')}`,
    },
  });

  assert.equal(res.statusCode, 200);
  const responseBody = JSON.parse(res.body);
  assert.deepEqual(JSON.parse(res.body), {
    claim_manual_entry_code: 'AB2C3D',
    expires_at: responseBody.expires_at,
  });
  assert.equal(updates.length, 1);
  assert.equal(updates[0]?.code, 'AB2C3D');
  assert.equal(responseBody.expires_at, updates[0]?.expiresAt);

  await app.close();
});

test('GET /users/me/claim-code refreshes an expired claim code', { concurrency: false }, async (t) => {
  const app = Fastify();
  app.setErrorHandler(errorHandler);
  const updates: Array<{ code: string; expiresAt: string }> = [];

  const services: UserRouteServices = {
    getSupabaseClient: () =>
      ({
        from(table: string) {
          assert.equal(table, 'user_table');

          return {
            select(columns: string) {
              assert.equal(
                columns,
                'user_id, user_type, claim_manual_entry_code, claim_manual_entry_code_expires_at'
              );

              return {
                eq(column: string, value: string) {
                  assert.equal(column, 'user_id');
                  assert.equal(value, 'user-1');

                  return {
                    async single() {
                      return {
                        data: {
                          user_id: 'user-1',
                          user_type: 'User',
                          claim_manual_entry_code: 'OLD123',
                          claim_manual_entry_code_expires_at: '2000-01-01T00:00:00.000Z',
                        },
                        error: null,
                      };
                    },
                  };
                },
              };
            },
            update(values: Record<string, unknown>) {
              updates.push({
                code: String(values.claim_manual_entry_code),
                expiresAt: String(values.claim_manual_entry_code_expires_at),
              });

              return {
                eq(column: string, value: string) {
                  assert.equal(column, 'user_id');
                  assert.equal(value, 'user-1');

                  return {
                    async select(selectedColumns: string) {
                      assert.equal(
                        selectedColumns,
                        'claim_manual_entry_code, claim_manual_entry_code_expires_at'
                      );

                      const latestUpdate = updates.at(-1);
                      return {
                        data: latestUpdate
                          ? [{
                              claim_manual_entry_code: latestUpdate.code,
                              claim_manual_entry_code_expires_at: latestUpdate.expiresAt,
                            }]
                          : [],
                        error: null,
                      };
                    },
                  };
                },
              };
            },
          };
        },
      }) as never,
    generateClaimCode: () => 'ZX7M2Q',
  };

  await app.register(usersRoutes, {
    prefix: '/users',
    services,
  });

  setAuthSupabaseClientFactoryForTests(() =>
    createAuthoritativeAuthSupabase('User', 'user-1@umak.edu.ph')
  );
  t.after(() => setAuthSupabaseClientFactoryForTests(null));

  const res = await app.inject({
    method: 'GET',
    url: '/users/me/claim-code',
    headers: {
      authorization: `Bearer ${createToken('User', 'user-1', 'user-1@umak.edu.ph')}`,
    },
  });

  assert.equal(res.statusCode, 200);
  const responseBody = JSON.parse(res.body);
  assert.equal(responseBody.claim_manual_entry_code, 'ZX7M2Q');
  assert.equal(responseBody.expires_at, updates[0]?.expiresAt);
  assert.equal(updates.length, 1);
  assert.equal(updates[0]?.code, 'ZX7M2Q');

  await app.close();
});
