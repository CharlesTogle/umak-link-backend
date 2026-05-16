import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import jwt from 'jsonwebtoken';
import { setAuthSupabaseClientFactoryForTests } from '../middleware/auth.js';
import postsRoutes from '../routes/posts.js';
import { canGuardAccessClaimReview } from '../services/claim-verification.js';
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

test(
  'GET /posts/:id/full includes the claim processor role for claimed items',
  { concurrency: false },
  async (t) => {
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
                        claim_processed_by_name: 'Stefanie Gabion',
                        claim_processed_by_email: 'sgabion.k12148528@umak.edu.ph',
                        claim_processed_by_user_type: 'Guard',
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
      claim_processed_by_name: 'Stefanie Gabion',
      claim_processed_by_email: 'sgabion.k12148528@umak.edu.ph',
      claim_processed_by_user_type: 'Guard',
    });

    await app.close();
  }
);

test(
  'GET /posts/:id/full includes the accepting guard identity for with_guard custody',
  { concurrency: false },
  async (t) => {
    const app = Fastify();
    const fakeSupabase = {
      from(table: string) {
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
                          poster_id: 'user-2',
                          item_name: 'Umbrella',
                          custody_status: 'with_guard',
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

        if (table === 'custody_attempt_table') {
          return {
            select(columns: string) {
              assert.equal(columns, 'decision_by_guard_id');

              return {
                eq(column: string, value: number | string) {
                  assert.equal(column, 'post_id');
                  assert.equal(value, 42);

                  return {
                    eq(nextColumn: string, nextValue: string) {
                      assert.equal(nextColumn, 'status');
                      assert.equal(nextValue, 'accepted');

                      return {
                        order(orderColumn: string, options: { ascending: boolean }) {
                          assert.equal(orderColumn, 'attempt_number');
                          assert.deepEqual(options, { ascending: false });

                          return {
                            limit(limitValue: number) {
                              assert.equal(limitValue, 1);

                              return {
                                async maybeSingle() {
                                  return {
                                    data: {
                                      decision_by_guard_id: 'guard-7',
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
              };
            },
          };
        }

        if (table === 'user_table') {
          return {
            select(columns: string) {
              assert.equal(columns, 'user_id, user_name, email');

              return {
                eq(column: string, value: string) {
                  assert.equal(column, 'user_id');
                  assert.equal(value, 'guard-7');

                  return {
                    async maybeSingle() {
                      return {
                        data: {
                          user_id: 'guard-7',
                          user_name: 'Guard Greg',
                          email: 'guard.greg@umak.edu.ph',
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
      custody_status: 'with_guard',
      accepted_by_guard_name: 'Guard Greg',
      accepted_by_guard_email: 'guard.greg@umak.edu.ph',
    });

    await app.close();
  }
);

test(
  'GET /posts/:id/full allows the accepted guard to fetch a pending with_guard post',
  { concurrency: false },
  async (t) => {
    const app = Fastify();
    const fakeSupabase = {
      from(table: string) {
        if (table === 'v_post_records_details') {
          return {
            select(columns: string) {
              return {
                eq(column: string, value: number) {
                  assert.equal(column, 'post_id');
                  assert.equal(value, 42);

                  return {
                    async single() {
                      if (columns === '*') {
                        return {
                          data: {
                            post_id: 42,
                            poster_id: 'user-2',
                            item_name: 'Umbrella',
                            item_type: 'found',
                            post_status: 'pending',
                            item_status: 'unclaimed',
                            custody_status: 'with_guard',
                          },
                          error: null,
                        };
                      }

                      assert.equal(
                        columns,
                        'post_id, item_id, item_type, post_status, item_status, custody_status'
                      );

                      return {
                        data: {
                          post_id: 42,
                          item_id: 'item-42',
                          item_type: 'found',
                          post_status: 'pending',
                          item_status: 'unclaimed',
                          custody_status: 'with_guard',
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

        if (table === 'custody_attempt_table') {
          return {
            select(columns: string) {
              if (columns === 'post_id, attempt_number, office_received_at, investigation_opened_at') {
                return {
                  in(column: string, value: number[]) {
                    assert.equal(column, 'post_id');
                    assert.deepEqual(value, [42]);

                    return {
                      async order(orderColumn: string, options: { ascending: boolean }) {
                        assert.equal(orderColumn, 'attempt_number');
                        assert.deepEqual(options, { ascending: false });

                        return {
                          data: [
                            {
                              post_id: 42,
                              attempt_number: 1,
                              office_received_at: null,
                              investigation_opened_at: null,
                            },
                          ],
                          error: null,
                        };
                      },
                    };
                  },
                };
              }

              return {
                eq(column: string, value: number | string) {
                  assert.equal(column, 'post_id');
                  assert.equal(value, 42);

                  return {
                    eq(nextColumn: string, nextValue: string) {
                      assert.equal(nextColumn, 'status');
                      assert.equal(nextValue, 'accepted');

                      return {
                        order(orderColumn: string, options: { ascending: boolean }) {
                          assert.equal(orderColumn, 'attempt_number');
                          assert.deepEqual(options, { ascending: false });

                          return {
                            limit(limitValue: number) {
                              assert.equal(limitValue, 1);

                              return {
                                async maybeSingle() {
                                  if (
                                    columns ===
                                    'custody_attempt_id, post_id, item_id, attempt_number, status, decision_by_guard_id, office_received_at'
                                  ) {
                                    return {
                                      data: {
                                        custody_attempt_id: 'attempt-1',
                                        post_id: 42,
                                        item_id: 'item-42',
                                        attempt_number: 1,
                                        status: 'accepted',
                                        decision_by_guard_id: 'guard-7',
                                        office_received_at: null,
                                      },
                                      error: null,
                                    };
                                  }

                                  assert.equal(columns, 'decision_by_guard_id');
                                  return {
                                    data: {
                                      decision_by_guard_id: 'guard-7',
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
              };
            },
          };
        }

        if (table === 'user_table') {
          return {
            select(columns: string) {
              assert.equal(columns, 'user_id, user_name, email');

              return {
                eq(column: string, value: string) {
                  assert.equal(column, 'user_id');
                  assert.equal(value, 'guard-7');

                  return {
                    async maybeSingle() {
                      return {
                        data: {
                          user_id: 'guard-7',
                          user_name: 'Guard Greg',
                          email: 'guard.greg@umak.edu.ph',
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
        canGuardAccessClaimReview: async (postId: number, guardUserId: string) =>
          await canGuardAccessClaimReview(postId, guardUserId, {
            getSupabase: () => fakeSupabase,
          }),
      },
    });

    setAuthSupabaseClientFactoryForTests(() =>
      createPostsAuthSupabase('Guard', 'guard-7@umak.edu.ph')
    );
    t.after(() => setAuthSupabaseClientFactoryForTests(null));

    const res = await app.inject({
      method: 'GET',
      url: '/posts/42/full',
      headers: {
        authorization: `Bearer ${createToken('Guard', 'guard-7', 'guard-7@umak.edu.ph')}`,
      },
    });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), {
      post_id: 42,
      poster_id: 'user-2',
      item_name: 'Umbrella',
      item_type: 'found',
      post_status: 'pending',
      item_status: 'unclaimed',
      custody_status: 'with_guard',
      accepted_by_guard_name: 'Guard Greg',
      accepted_by_guard_email: 'guard.greg@umak.edu.ph',
    });

    await app.close();
  }
);

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

test(
  'PUT /posts/items/:id/status requires discard reason for discard transitions',
  { concurrency: false },
  async (t) => {
    const app = Fastify();
    const fakeSupabase = {
      async rpc() {
        throw new Error('RPC should not be called when discard reason is missing');
      },
      from(table: string) {
        assert.equal(table, 'post_public_view');

        return {
          select(columns: string) {
            assert.equal(
              columns,
              'post_id, item_id, item_name, item_type, poster_id, item_status, custody_status'
            );

            return {
              eq(column: string, value: string) {
                assert.equal(column, 'item_id');
                assert.equal(value, 'item-1');

                return {
                  async single() {
                    return {
                      data: {
                        post_id: 42,
                        item_id: 'item-1',
                        item_name: 'Wallet',
                        item_type: 'found',
                        poster_id: 'user-1',
                        item_status: 'unclaimed',
                        custody_status: 'with_reporter',
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
      statusRouteOptions: {
        getSupabase: () => fakeSupabase,
        auditLogger: async () => {},
        getAuditUserName: async () => 'Staff User',
      },
    });

    setAuthSupabaseClientFactoryForTests(() =>
      createPostsAuthSupabase('Staff', 'staff-1@umak.edu.ph')
    );
    t.after(() => setAuthSupabaseClientFactoryForTests(null));

    const res = await app.inject({
      method: 'PUT',
      url: '/posts/items/item-1/status',
      headers: {
        authorization: `Bearer ${createToken('Staff', 'staff-1', 'staff-1@umak.edu.ph')}`,
      },
      payload: { status: 'discarded' },
    });

    assert.equal(res.statusCode, 400);
    assert.equal(JSON.parse(res.body).message, 'Discard reason is required when marking an item as discarded.');
    await app.close();
  }
);

test(
  'PUT /posts/items/:id/status discards found items through discard_found_item RPC',
  { concurrency: false },
  async (t) => {
    const app = Fastify();
    const rpcCalls: Array<{ functionName: string; args: Record<string, unknown> }> = [];
    const auditCalls: Array<Record<string, unknown>> = [];
    const fakeSupabase = {
      async rpc(functionName: string, args: Record<string, unknown>) {
        rpcCalls.push({ functionName, args });

        if (functionName === 'discard_found_item') {
          return {
            data: {
              post_id: 42,
              item_id: 'item-1',
              item_name: 'Wallet',
              previous_item_status: 'unclaimed',
              previous_custody_status: 'with_reporter',
              discarded_reason: 'Transferred to campus recycling after hold period.',
              discarded_at: '2026-05-15T03:00:00.000Z',
              item_discard_id: 'discard-1',
              custody_record_id: 'record-1',
            },
            error: null,
          };
        }

        throw new Error(`Unexpected RPC call: ${functionName}`);
      },
      from(table: string) {
        assert.equal(table, 'post_public_view');

        return {
          select(columns: string) {
            assert.equal(
              columns,
              'post_id, item_id, item_name, item_type, poster_id, item_status, custody_status'
            );

            return {
              eq(column: string, value: string) {
                assert.equal(column, 'item_id');
                assert.equal(value, 'item-1');

                return {
                  async single() {
                    return {
                      data: {
                        post_id: 42,
                        item_id: 'item-1',
                        item_name: 'Wallet',
                        item_type: 'found',
                        poster_id: 'user-1',
                        item_status: 'unclaimed',
                        custody_status: 'with_reporter',
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
      statusRouteOptions: {
        getSupabase: () => fakeSupabase,
        auditLogger: async (params: { details: unknown }) => {
          auditCalls.push(params.details as Record<string, unknown>);
        },
        getAuditUserName: async () => 'Staff User',
      },
    });

    setAuthSupabaseClientFactoryForTests(() =>
      createPostsAuthSupabase('Staff', 'staff-1@umak.edu.ph')
    );
    t.after(() => setAuthSupabaseClientFactoryForTests(null));

    const res = await app.inject({
      method: 'PUT',
      url: '/posts/items/item-1/status',
      headers: {
        authorization: `Bearer ${createToken('Staff', 'staff-1', 'staff-1@umak.edu.ph')}`,
      },
      payload: {
        status: 'discarded',
        discard_reason: 'Transferred to campus recycling after hold period.',
      },
    });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), { success: true });
    assert.deepEqual(rpcCalls, [
      {
        functionName: 'discard_found_item',
        args: {
          p_item_id: 'item-1',
          p_actor_user_id: 'staff-1',
          p_discarded_reason: 'Transferred to campus recycling after hold period.',
          p_occurred_at: auditCalls[0]?.timestamp,
        },
      },
    ]);
    assert.equal(auditCalls[0]?.discard_reason, 'Transferred to campus recycling after hold period.');
    assert.equal(auditCalls[0]?.new_custody_status, 'discarded');
    await app.close();
  }
);

test(
  'PUT /posts/items/:id/status recomputes custody status when restoring a discarded found item',
  { concurrency: false },
  async (t) => {
    const app = Fastify();
    const rpcCalls: Array<{ functionName: string; args: Record<string, unknown> }> = [];
    const auditCalls: Array<Record<string, unknown>> = [];
    const itemUpdates: Array<Record<string, unknown>> = [];
    const fakeSupabase = {
      async rpc(functionName: string, args: Record<string, unknown>) {
        rpcCalls.push({ functionName, args });

        if (functionName === 'recompute_item_custody_status') {
          return {
            data: 'with_reporter',
            error: null,
          };
        }

        throw new Error(`Unexpected RPC call: ${functionName}`);
      },
      from(table: string) {
        if (table === 'post_public_view') {
          return {
            select(columns: string) {
              assert.equal(
                columns,
                'post_id, item_id, item_name, item_type, poster_id, item_status, custody_status'
              );

              return {
                eq(column: string, value: string) {
                  assert.equal(column, 'item_id');
                  assert.equal(value, 'item-1');

                  return {
                    async single() {
                      return {
                        data: {
                          post_id: 42,
                          item_id: 'item-1',
                          item_name: 'Wallet',
                          item_type: 'found',
                          poster_id: 'user-1',
                          item_status: 'discarded',
                          custody_status: 'discarded',
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

        if (table === 'item_table') {
          return {
            update(values: Record<string, unknown>) {
              itemUpdates.push(values);

              return {
                eq(column: string, value: string) {
                  assert.equal(column, 'item_id');
                  assert.equal(value, 'item-1');

                  return Promise.resolve({
                    error: null,
                  });
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
      statusRouteOptions: {
        getSupabase: () => fakeSupabase,
        auditLogger: async (params: { details: unknown }) => {
          auditCalls.push(params.details as Record<string, unknown>);
        },
        getAuditUserName: async () => 'Staff User',
      },
    });

    setAuthSupabaseClientFactoryForTests(() =>
      createPostsAuthSupabase('Staff', 'staff-1@umak.edu.ph')
    );
    t.after(() => setAuthSupabaseClientFactoryForTests(null));

    const res = await app.inject({
      method: 'PUT',
      url: '/posts/items/item-1/status',
      headers: {
        authorization: `Bearer ${createToken('Staff', 'staff-1', 'staff-1@umak.edu.ph')}`,
      },
      payload: {
        status: 'unclaimed',
      },
    });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(itemUpdates, [{ status: 'unclaimed' }]);
    assert.deepEqual(rpcCalls, [
      {
        functionName: 'recompute_item_custody_status',
        args: {
          p_post_id: 42,
          p_item_id: 'item-1',
        },
      },
    ]);
    assert.equal(auditCalls[0]?.new_custody_status, 'with_reporter');
    await app.close();
  }
);

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

test('DELETE /posts/:id allows a user to delete their own post while custody is with_reporter', {
  concurrency: false,
}, async (t) => {
  const app = Fastify();
  const rpcCalls: Array<{ functionName: string; args: Record<string, unknown> }> = [];
  const fakeSupabase = {
    async rpc(functionName: string, args: Record<string, unknown>) {
      rpcCalls.push({ functionName, args });
      assert.equal(functionName, 'delete_post_by_id');
      assert.deepEqual(args, {
        p_post_id: 42,
      });

      return {
        data: true,
        error: null,
      };
    },
    from(table: string) {
      assert.equal(table, 'post_public_view');

      return {
        select(columns: string) {
          assert.equal(
            columns,
            'poster_id, post_status, item_status, item_id, item_name, poster_name, custody_status'
          );

          return {
            eq(column: string, value: number) {
              assert.equal(column, 'post_id');
              assert.equal(value, 42);

              return {
                async single() {
                  return {
                    data: {
                      poster_id: 'user-1',
                      post_status: 'pending',
                      item_status: 'unclaimed',
                      item_id: 'item-42',
                      item_name: 'Wallet',
                      poster_name: 'User One',
                      custody_status: 'with_reporter',
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

  setAuthSupabaseClientFactoryForTests(() =>
    createPostsAuthSupabase('User', 'user-1@umak.edu.ph')
  );
  t.after(() => setAuthSupabaseClientFactoryForTests(null));

  const res = await app.inject({
    method: 'DELETE',
    url: '/posts/42',
    headers: {
      authorization: `Bearer ${createToken('User', 'user-1', 'user-1@umak.edu.ph')}`,
    },
  });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { success: true });
  assert.equal(rpcCalls.length, 1);
  await app.close();
});

test('DELETE /posts/:id rejects user delete when custody is not with_reporter', {
  concurrency: false,
}, async (t) => {
  const app = Fastify();
  let rpcCalled = false;
  const fakeSupabase = {
    async rpc() {
      rpcCalled = true;
      throw new Error('delete_post_by_id should not be called');
    },
    from(table: string) {
      assert.equal(table, 'post_public_view');

      return {
        select(columns: string) {
          assert.equal(
            columns,
            'poster_id, post_status, item_status, item_id, item_name, poster_name, custody_status'
          );

          return {
            eq(column: string, value: number) {
              assert.equal(column, 'post_id');
              assert.equal(value, 42);

              return {
                async single() {
                  return {
                    data: {
                      poster_id: 'user-1',
                      post_status: 'pending',
                      item_status: 'unclaimed',
                      item_id: 'item-42',
                      item_name: 'Wallet',
                      poster_name: 'User One',
                      custody_status: 'with_guard',
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

  setAuthSupabaseClientFactoryForTests(() =>
    createPostsAuthSupabase('User', 'user-1@umak.edu.ph')
  );
  t.after(() => setAuthSupabaseClientFactoryForTests(null));

  const res = await app.inject({
    method: 'DELETE',
    url: '/posts/42',
    headers: {
      authorization: `Bearer ${createToken('User', 'user-1', 'user-1@umak.edu.ph')}`,
    },
  });

  assert.equal(res.statusCode, 403);
  assert.equal(JSON.parse(res.body).message, 'Users can only delete posts while custody is with reporter');
  assert.equal(rpcCalled, false);
  await app.close();
});
