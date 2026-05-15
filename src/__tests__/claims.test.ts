import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import jwt from 'jsonwebtoken';
import { setAuthSupabaseClientFactoryForTests } from '../middleware/auth.js';
import claimsRoutes from '../routes/claims.js';
import type { UserType } from '../types/auth.js';

const JWT_SECRET = process.env.JWT_SECRET || 'test_secret_for_tests';

function createToken(
  userType: UserType,
  userId = 'staff-1',
  email = 'staff-1@umak.edu.ph'
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

function createClaimsAuthSupabase(userType: UserType, email: string) {
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

test(
  'POST /claims/process rejects invalid claimable post state before RPC',
  { concurrency: false },
  async (t) => {
    const app = Fastify();
    let rpcCalled = false;

    const fakeSupabase = {
      from(table: string) {
        assert.equal(table, 'post_public_view');

        return {
          select(columns: string) {
            assert.equal(
              columns,
              'post_id, item_id, item_name, poster_name, is_anonymous, item_type, post_status, item_status, custody_status'
            );

            return {
              eq(column: string, value: number) {
                assert.equal(column, 'post_id');
                assert.equal(value, 42);

                return {
                  async single() {
                    return {
                      data: {
                        post_id: 42,
                        item_id: 'item-42',
                        item_name: 'Wallet',
                        poster_name: 'Alice',
                        is_anonymous: false,
                        item_type: 'found',
                        post_status: 'accepted',
                        item_status: 'claimed',
                        custody_status: 'in_security_office',
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
        rpcCalled = true;
        return { data: null, error: null };
      },
    } as never;

    await app.register(claimsRoutes, {
      prefix: '/claims',
      getSupabase: () => fakeSupabase,
      getUserName: async () => 'Staff One',
      logAudit: async () => {},
    });

    setAuthSupabaseClientFactoryForTests(() =>
      createClaimsAuthSupabase('Staff', 'staff-1@umak.edu.ph')
    );
    t.after(() => setAuthSupabaseClientFactoryForTests(null));

    const res = await app.inject({
      method: 'POST',
      url: '/claims/process',
      headers: {
        authorization: `Bearer ${createToken('Staff')}`,
      },
      payload: {
        found_post_id: 42,
        claim_details: {
          claimer_name: 'Bob',
          claimer_school_email: 'bob@umak.edu.ph',
          claimer_contact_num: '0912 345 6789',
        },
      },
    });

    assert.equal(res.statusCode, 400);
    assert.match(res.body, /no longer available for claim/i);
    assert.equal(rpcCalled, false);

    await app.close();
  }
);

test(
  'POST /claims/process persists linked missing item and claimed_at using the claim_table row',
  { concurrency: false },
  async (t) => {
    const app = Fastify();
    const rpcCalls: Array<{ functionName: string; args: Record<string, unknown> }> = [];
    const custodyUpdates: Array<{ values: Record<string, unknown>; itemId: string }> = [];

    const fakeSupabase = {
      from(table: string) {
        if (table === 'post_public_view') {
          return {
            select(columns: string) {
              return {
                eq(column: string, value: number) {
                  assert.equal(column, 'post_id');

                  return {
                    async single() {
                      if (
                        columns ===
                        'post_id, item_id, item_name, poster_name, is_anonymous, item_type, post_status, item_status, custody_status'
                      ) {
                        assert.equal(value, 42);
                        return {
                          data: {
                            post_id: 42,
                            item_id: 'found-item-42',
                            item_name: 'Wallet',
                            poster_name: 'Alice',
                            is_anonymous: false,
                            item_type: 'found',
                            post_status: 'accepted',
                            item_status: 'unclaimed',
                            custody_status: 'in_security_office',
                          },
                          error: null,
                        };
                      }

                      if (
                        columns ===
                        'post_id, item_id, item_name, poster_id, item_type, post_status, item_status, custody_status'
                      ) {
                        assert.equal(value, 42);
                        return {
                          data: {
                            post_id: 42,
                            item_id: 'found-item-42',
                            item_name: 'Wallet',
                            poster_id: 'user-1',
                            item_type: 'found',
                            post_status: 'accepted',
                            item_status: 'claimed',
                            custody_status: 'in_security_office',
                          },
                          error: null,
                        };
                      }

                      assert.equal(
                        columns,
                        'post_id, item_id, item_type, post_status, item_status'
                      );
                      assert.equal(value, 24);

                      return {
                        data: {
                          post_id: 24,
                          item_id: 'missing-item-24',
                          item_type: 'missing',
                          post_status: 'accepted',
                          item_status: 'lost',
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

        if (table === 'claim_table') {
          return {
            select(columns: string) {
              return {
                eq(column: string, value: string) {
                  assert.equal(column, 'item_id');

                  return {
                    async single() {
                      if (
                        columns ===
                        'claim_id, item_id, claimer_name, claimer_school_email, claimer_contact_num, processed_by_staff_id, claimed_at, verification_method, verified_claimer_user_id, claim_verification_session_id'
                      ) {
                        return {
                          data: null,
                          error: { code: 'PGRST116' },
                        };
                      }

                      assert.equal(columns, 'claim_id');
                      assert.equal(value, 'found-item-42');
                      return {
                        data: { claim_id: 'claim-123' },
                        error: null,
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
              assert.equal(columns, 'user_id, user_name');

              return {
                eq(column: string, value: string) {
                  assert.equal(column, 'user_id');
                  assert.equal(value, 'staff-1');

                  return {
                    async single() {
                      return {
                        data: {
                          user_id: 'staff-1',
                          user_name: 'Staff One',
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
            insert() {
              return Promise.resolve({ error: null });
            },
          };
        }

        if (table === 'item_table') {
          return {
            update(values: Record<string, unknown>) {
              return {
                eq(column: string, value: string) {
                  assert.equal(column, 'item_id');
                  custodyUpdates.push({ values, itemId: value });
                  return Promise.resolve({ error: null });
                },
              };
            },
          };
        }

        throw new Error(`Unexpected table: ${table}`);
      },
      async rpc(functionName: string, args: Record<string, unknown>) {
        rpcCalls.push({ functionName, args });
        assert.equal(functionName, 'process_claim');
        return { data: null, error: null };
      },
    } as never;

    await app.register(claimsRoutes, {
      prefix: '/claims',
      getSupabase: () => fakeSupabase,
      getUserName: async () => 'Staff One',
      logAudit: async () => {},
    });

    setAuthSupabaseClientFactoryForTests(() =>
      createClaimsAuthSupabase('Staff', 'staff-1@umak.edu.ph')
    );
    t.after(() => setAuthSupabaseClientFactoryForTests(null));

    const res = await app.inject({
      method: 'POST',
      url: '/claims/process',
      headers: {
        authorization: `Bearer ${createToken('Staff')}`,
      },
      payload: {
        found_post_id: 42,
        missing_post_id: 24,
        claim_details: {
          claimer_name: 'Bob',
          claimer_school_email: 'bob@umak.edu.ph',
          claimer_contact_num: '+63 912-345-6789',
          claimed_at: '2026-05-15T09:30:00+08:00',
        },
      },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(rpcCalls.length, 1);
    assert.deepEqual(rpcCalls[0]?.args, {
      found_post_id: 42,
      missing_post_id: 24,
      claim_details: {
        claimer_name: 'Bob',
        claimer_school_email: 'bob@umak.edu.ph',
        claimer_contact_num: '0912 345 6789',
        claimed_at: '2026-05-15T01:30:00.000Z',
        poster_name: 'Alice',
        staff_id: 'staff-1',
        staff_name: 'Staff One',
      },
    });
    assert.deepEqual(custodyUpdates, [
      {
        itemId: 'found-item-42',
        values: {
          custody_status: 'claimed_by_student',
        },
      },
    ]);

    await app.close();
  }
);

test(
  'GET /claims/by-item/:itemId returns the full claim details expected by mobile for staff and guard clients',
  { concurrency: false },
  async (t) => {
    const app = Fastify();

    const fakeSupabase = {
      from(table: string) {
        assert.equal(table, 'claim_table');

        return {
          select(columns: string) {
            assert.equal(
              columns,
              'claim_id, item_id, claimer_name, claimer_school_email, claimer_contact_num, processed_by_staff_id, claimed_at, verification_method, verified_claimer_user_id, claim_verification_session_id'
            );

            return {
              eq(column: string, value: string) {
                assert.equal(column, 'item_id');
                assert.equal(value, 'found-item-42');

                return {
                  async single() {
                    return {
                      data: {
                        claim_id: 'claim-123',
                        item_id: 'found-item-42',
                        claimer_name: 'Bob',
                        claimer_school_email: 'bob@umak.edu.ph',
                        claimer_contact_num: '0912 345 6789',
                        processed_by_staff_id: 'staff-1',
                        claimed_at: '2026-05-15T01:30:00.000Z',
                        verification_method: 'manual_staff',
                        verified_claimer_user_id: null,
                        claim_verification_session_id: null,
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

    await app.register(claimsRoutes, {
      prefix: '/claims',
      getSupabase: () => fakeSupabase,
      getUserName: async () => 'Staff One',
      logAudit: async () => {},
    });

    setAuthSupabaseClientFactoryForTests(() =>
      createClaimsAuthSupabase('Staff', 'staff-1@umak.edu.ph')
    );
    t.after(() => setAuthSupabaseClientFactoryForTests(null));

    const res = await app.inject({
      method: 'GET',
      url: '/claims/by-item/found-item-42',
      headers: {
        authorization: `Bearer ${createToken('Staff')}`,
      },
    });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), {
      exists: true,
      claim: {
        claim_id: 'claim-123',
        item_id: 'found-item-42',
        claimer_name: 'Bob',
        claimer_email: 'bob@umak.edu.ph',
        claimer_school_email: 'bob@umak.edu.ph',
        claimer_contact_num: '0912 345 6789',
        processed_by_staff_id: 'staff-1',
        claimed_at: '2026-05-15T01:30:00.000Z',
        staff_name: 'Staff One',
        verification_method: 'manual_staff',
      },
    });

    setAuthSupabaseClientFactoryForTests(() =>
      createClaimsAuthSupabase('Guard', 'guard-1@umak.edu.ph')
    );
    const guardRes = await app.inject({
      method: 'GET',
      url: '/claims/by-item/found-item-42',
      headers: {
        authorization: `Bearer ${createToken('Guard', 'guard-1', 'guard-1@umak.edu.ph')}`,
      },
    });

    assert.equal(guardRes.statusCode, 200);

    await app.close();
  }
);

test(
  'POST /claims/process allows direct guard claims without verification metadata',
  { concurrency: false },
  async (t) => {
    const app = Fastify();
    const rpcCalls: Array<{ functionName: string; args: Record<string, unknown> }> = [];
    const custodyUpdates: Array<{ values: Record<string, unknown>; itemId: string }> = [];
    const postUpdates: Array<{ values: Record<string, unknown>; postId: number }> = [];
    let verificationCalled = false;
    let completionCalled = false;

    const fakeSupabase = {
      from(table: string) {
        if (table === 'post_public_view') {
          return {
            select(columns: string) {
              return {
                eq(column: string, value: number) {
                  assert.equal(column, 'post_id');

                  return {
                    async single() {
                      if (
                        columns ===
                        'post_id, item_id, item_name, poster_name, is_anonymous, item_type, post_status, item_status, custody_status'
                      ) {
                        assert.equal(value, 42);
                        return {
                          data: {
                            post_id: 42,
                            item_id: 'found-item-42',
                            item_name: 'Wallet',
                            poster_name: 'Alice',
                            is_anonymous: false,
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
                        'post_id, item_id, item_name, poster_id, item_type, post_status, item_status, custody_status'
                      );
                      assert.equal(value, 42);
                      return {
                        data: {
                          post_id: 42,
                          item_id: 'found-item-42',
                          item_name: 'Wallet',
                          poster_id: 'user-1',
                          item_type: 'found',
                          post_status: 'accepted',
                          item_status: 'claimed',
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

        if (table === 'claim_table') {
          return {
            select(columns: string) {
              return {
                eq(column: string, value: string) {
                  assert.equal(column, 'item_id');

                  return {
                    async single() {
                      if (
                        columns ===
                          'claim_id, item_id, claimer_name, claimer_school_email, claimer_contact_num, processed_by_staff_id, claimed_at' ||
                        columns ===
                          'claim_id, item_id, claimer_name, claimer_school_email, claimer_contact_num, processed_by_staff_id, claimed_at, verification_method, verified_claimer_user_id, claim_verification_session_id'
                      ) {
                        return {
                          data: null,
                          error: { code: 'PGRST116' },
                        };
                      }

                      assert.equal(columns, 'claim_id');
                      assert.equal(value, 'found-item-42');
                      return {
                        data: { claim_id: 'claim-guard-direct-123' },
                        error: null,
                      };
                    },
                  };
                },
              };
            },
          };
        }

        if (table === 'post_table') {
          return {
            update(values: Record<string, unknown>) {
              return {
                eq(column: string, value: number) {
                  assert.equal(column, 'post_id');
                  postUpdates.push({ values, postId: value });
                  return Promise.resolve({ error: null });
                },
              };
            },
          };
        }

        if (table === 'custody_record_table') {
          return {
            insert() {
              return Promise.resolve({ error: null });
            },
          };
        }

        if (table === 'item_table') {
          return {
            update(values: Record<string, unknown>) {
              return {
                eq(column: string, value: string) {
                  assert.equal(column, 'item_id');
                  custodyUpdates.push({ values, itemId: value });
                  return Promise.resolve({ error: null });
                },
              };
            },
          };
        }

        if (table === 'user_table') {
          return {
            select(columns: string) {
              assert.equal(columns, 'user_id, user_name');

              return {
                eq(column: string, value: string) {
                  assert.equal(column, 'user_id');
                  assert.equal(value, 'guard-1');

                  return {
                    async single() {
                      return {
                        data: {
                          user_id: 'guard-1',
                          user_name: 'Guard One',
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

        throw new Error(`Unexpected table: ${table}`);
      },
      async rpc(functionName: string, args: Record<string, unknown>) {
        rpcCalls.push({ functionName, args });
        assert.equal(functionName, 'process_claim');
        return { data: null, error: null };
      },
    } as never;

    await app.register(claimsRoutes, {
      prefix: '/claims',
      getSupabase: () => fakeSupabase,
      getUserName: async () => 'Guard One',
      logAudit: async () => {},
      canGuardAccessClaimReview: async () => true,
      verifyClaimSubmission: async () => {
        verificationCalled = true;
        throw new Error('verifyClaimSubmission should not run for direct guard claims');
      },
      completeClaimVerificationSession: async () => {
        completionCalled = true;
      },
    });

    setAuthSupabaseClientFactoryForTests(() =>
      createClaimsAuthSupabase('Guard', 'guard-1@umak.edu.ph')
    );
    t.after(() => setAuthSupabaseClientFactoryForTests(null));

    const res = await app.inject({
      method: 'POST',
      url: '/claims/process',
      headers: {
        authorization: `Bearer ${createToken('Guard', 'guard-1', 'guard-1@umak.edu.ph')}`,
      },
      payload: {
        found_post_id: 42,
        claim_details: {
          claimer_name: 'Claimed Student',
          claimer_school_email: 'claimed.student@umak.edu.ph',
          claimer_contact_num: '0912 345 6789',
          claimed_at: '2026-05-15T09:30:00+08:00',
        },
      },
    });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(rpcCalls[0]?.args, {
      found_post_id: 42,
      missing_post_id: null,
      claim_details: {
        claimer_name: 'Claimed Student',
        claimer_school_email: 'claimed.student@umak.edu.ph',
        claimer_contact_num: '0912 345 6789',
        claimed_at: '2026-05-15T01:30:00.000Z',
        poster_name: 'Alice',
        staff_id: 'guard-1',
        staff_name: 'Guard One',
      },
    });
    assert.deepEqual(postUpdates, [
      {
        postId: 42,
        values: {
          status: 'accepted',
        },
      },
    ]);
    assert.deepEqual(custodyUpdates, [
      {
        itemId: 'found-item-42',
        values: {
          custody_status: 'claimed_by_student',
        },
      },
    ]);
    assert.equal(verificationCalled, false);
    assert.equal(completionCalled, false);

    await app.close();
  }
);

test(
  'POST /claims/process completes a guard QR claim using the verified claimer identity',
  { concurrency: false },
  async (t) => {
    const app = Fastify();
    const rpcCalls: Array<{ functionName: string; args: Record<string, unknown> }> = [];
    const claimUpdates: Array<{ values: Record<string, unknown>; itemId: string }> = [];
    const custodyUpdates: Array<{ values: Record<string, unknown>; itemId: string }> = [];
    const postUpdates: Array<{ values: Record<string, unknown>; postId: number }> = [];
    const completedSessions: Array<Record<string, unknown>> = [];

    const fakeSupabase = {
      from(table: string) {
        if (table === 'post_public_view') {
          return {
            select(columns: string) {
              return {
                eq(column: string, value: number) {
                  assert.equal(column, 'post_id');

                  return {
                    async single() {
                      if (
                        columns ===
                        'post_id, item_id, item_name, poster_name, is_anonymous, item_type, post_status, item_status, custody_status'
                      ) {
                        assert.equal(value, 42);
                        return {
                          data: {
                            post_id: 42,
                            item_id: 'found-item-42',
                            item_name: 'Wallet',
                            poster_name: 'Alice',
                            is_anonymous: false,
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
                        'post_id, item_id, item_name, poster_id, item_type, post_status, item_status, custody_status'
                      );
                      assert.equal(value, 42);
                      return {
                        data: {
                          post_id: 42,
                          item_id: 'found-item-42',
                          item_name: 'Wallet',
                          poster_id: 'user-1',
                          item_type: 'found',
                          post_status: 'accepted',
                          item_status: 'claimed',
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

        if (table === 'claim_table') {
          return {
            select(columns: string) {
              return {
                eq(column: string, value: string) {
                  assert.equal(column, 'item_id');

                  return {
                    async single() {
                      if (
                        columns ===
                          'claim_id, item_id, claimer_name, claimer_school_email, claimer_contact_num, processed_by_staff_id, claimed_at' ||
                        columns ===
                          'claim_id, item_id, claimer_name, claimer_school_email, claimer_contact_num, processed_by_staff_id, claimed_at, verification_method, verified_claimer_user_id, claim_verification_session_id'
                      ) {
                        return {
                          data: null,
                          error: { code: 'PGRST116' },
                        };
                      }

                      assert.equal(columns, 'claim_id');
                      assert.equal(value, 'found-item-42');
                      return {
                        data: { claim_id: 'claim-guard-123' },
                        error: null,
                      };
                    },
                  };
                },
              };
            },
            update(values: Record<string, unknown>) {
              return {
                eq(column: string, value: string) {
                  assert.equal(column, 'item_id');
                  claimUpdates.push({ values, itemId: value });
                  return Promise.resolve({ error: null });
                },
              };
            },
          };
        }

        if (table === 'custody_record_table') {
          return {
            insert() {
              return Promise.resolve({ error: null });
            },
          };
        }

        if (table === 'post_table') {
          return {
            update(values: Record<string, unknown>) {
              return {
                eq(column: string, value: number) {
                  assert.equal(column, 'post_id');
                  postUpdates.push({ values, postId: value });
                  return Promise.resolve({ error: null });
                },
              };
            },
          };
        }

        if (table === 'item_table') {
          return {
            update(values: Record<string, unknown>) {
              return {
                eq(column: string, value: string) {
                  assert.equal(column, 'item_id');
                  custodyUpdates.push({ values, itemId: value });
                  return Promise.resolve({ error: null });
                },
              };
            },
          };
        }

        if (table === 'user_table') {
          return {
            select(columns: string) {
              assert.equal(columns, 'user_id, user_name');

              return {
                eq(column: string, value: string) {
                  assert.equal(column, 'user_id');
                  assert.equal(value, 'guard-1');

                  return {
                    async single() {
                      return {
                        data: {
                          user_id: 'guard-1',
                          user_name: 'Guard One',
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

        throw new Error(`Unexpected table: ${table}`);
      },
      async rpc(functionName: string, args: Record<string, unknown>) {
        rpcCalls.push({ functionName, args });
        assert.equal(functionName, 'process_claim');
        return { data: null, error: null };
      },
    } as never;

    await app.register(claimsRoutes, {
      prefix: '/claims',
      getSupabase: () => fakeSupabase,
      getUserName: async () => 'Guard One',
      logAudit: async () => {},
      canGuardAccessClaimReview: async () => true,
      verifyClaimSubmission: async () => ({
        claim_verification_session_id: 'verification-1',
        claim_qr_session_id: 'qr-1',
        verification_method: 'guard_qr',
        verified_claimer: {
          user_id: 'claimer-1',
          user_name: 'Verified Claimer',
          email: 'verified@umak.edu.ph',
          profile_picture_url: null,
        },
      }),
      completeClaimVerificationSession: async (input: unknown) => {
        completedSessions.push(input as unknown as Record<string, unknown>);
      },
    });

    setAuthSupabaseClientFactoryForTests(() =>
      createClaimsAuthSupabase('Guard', 'guard-1@umak.edu.ph')
    );
    t.after(() => setAuthSupabaseClientFactoryForTests(null));

    const res = await app.inject({
      method: 'POST',
      url: '/claims/process',
      headers: {
        authorization: `Bearer ${createToken('Guard', 'guard-1', 'guard-1@umak.edu.ph')}`,
      },
      payload: {
        found_post_id: 42,
        missing_post_id: null,
        claim_details: {
          claimer_name: 'Spoofed Name',
          claimer_school_email: 'spoofed@umak.edu.ph',
          claimer_contact_num: '0912 345 6789',
          claimed_at: '2026-05-15T09:30:00+08:00',
        },
        claim_verification: {
          claim_verification_session_id: 'verification-1',
          verification_method: 'guard_qr',
        },
      },
    });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(rpcCalls[0]?.args, {
      found_post_id: 42,
      missing_post_id: null,
      claim_details: {
        claimer_name: 'Verified Claimer',
        claimer_school_email: 'verified@umak.edu.ph',
        claimer_contact_num: '0912 345 6789',
        claimed_at: '2026-05-15T01:30:00.000Z',
        poster_name: 'Alice',
        staff_id: 'guard-1',
        staff_name: 'Guard One',
      },
    });
    assert.deepEqual(claimUpdates, [
      {
        itemId: 'found-item-42',
        values: {
          verified_claimer_user_id: 'claimer-1',
          claim_verification_session_id: 'verification-1',
          verification_method: 'guard_qr',
        },
      },
    ]);
    assert.deepEqual(postUpdates, [
      {
        postId: 42,
        values: {
          status: 'accepted',
        },
      },
    ]);
    assert.deepEqual(custodyUpdates, [
      {
        itemId: 'found-item-42',
        values: {
          custody_status: 'claimed_by_student',
        },
      },
    ]);
    assert.equal(completedSessions.length, 1);
    assert.equal(completedSessions[0]?.claim_verification_session_id, 'verification-1');
    assert.equal(completedSessions[0]?.claim_qr_session_id, 'qr-1');
    assert.equal(completedSessions[0]?.verification_method, 'guard_qr');

    await app.close();
  }
);

test(
  'POST /claims/process returns success after the claim commit even when post-commit custody finalization fails',
  { concurrency: false },
  async (t) => {
    const app = Fastify();
    const rpcCalls: Array<{ functionName: string; args: Record<string, unknown> }> = [];
    const postUpdates: Array<{ values: Record<string, unknown>; postId: number }> = [];

    const fakeSupabase = {
      from(table: string) {
        if (table === 'post_public_view') {
          return {
            select(columns: string) {
              return {
                eq(column: string, value: number) {
                  assert.equal(column, 'post_id');

                  return {
                    async single() {
                      if (
                        columns ===
                        'post_id, item_id, item_name, poster_name, is_anonymous, item_type, post_status, item_status, custody_status'
                      ) {
                        assert.equal(value, 42);
                        return {
                          data: {
                            post_id: 42,
                            item_id: 'found-item-42',
                            item_name: 'Wallet',
                            poster_name: 'Alice',
                            is_anonymous: false,
                            item_type: 'found',
                            post_status: 'pending',
                            item_status: 'unclaimed',
                            custody_status: 'with_guard',
                          },
                          error: null,
                        };
                      }

                      throw new Error(`Unexpected columns: ${columns}`);
                    },
                  };
                },
              };
            },
          };
        }

        if (table === 'claim_table') {
          return {
            select(columns: string) {
              return {
                eq(column: string, value: string) {
                  assert.equal(column, 'item_id');

                  return {
                    async single() {
                      if (
                        columns ===
                          'claim_id, item_id, claimer_name, claimer_school_email, claimer_contact_num, processed_by_staff_id, claimed_at' ||
                        columns ===
                          'claim_id, item_id, claimer_name, claimer_school_email, claimer_contact_num, processed_by_staff_id, claimed_at, verification_method, verified_claimer_user_id, claim_verification_session_id'
                      ) {
                        return {
                          data: null,
                          error: { code: 'PGRST116' },
                        };
                      }

                      assert.equal(columns, 'claim_id');
                      assert.equal(value, 'found-item-42');
                      return {
                        data: { claim_id: 'claim-post-commit-123' },
                        error: null,
                      };
                    },
                  };
                },
              };
            },
          };
        }

        if (table === 'post_table') {
          return {
            update(values: Record<string, unknown>) {
              return {
                eq(column: string, value: number) {
                  assert.equal(column, 'post_id');
                  postUpdates.push({ values, postId: value });
                  return Promise.resolve({ error: null });
                },
              };
            },
          };
        }

        if (table === 'user_table') {
          return {
            select(columns: string) {
              assert.equal(columns, 'user_id, user_name');

              return {
                eq(column: string, value: string) {
                  assert.equal(column, 'user_id');
                  assert.equal(value, 'guard-1');

                  return {
                    async single() {
                      return {
                        data: {
                          user_id: 'guard-1',
                          user_name: 'Guard One',
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

        throw new Error(`Unexpected table: ${table}`);
      },
      async rpc(functionName: string, args: Record<string, unknown>) {
        rpcCalls.push({ functionName, args });
        assert.equal(functionName, 'process_claim');
        return { data: null, error: null };
      },
    } as never;

    await app.register(claimsRoutes, {
      prefix: '/claims',
      getSupabase: () => fakeSupabase,
      getUserName: async () => 'Guard One',
      logAudit: async () => {},
      canGuardAccessClaimReview: async () => true,
      updateClaimedCustodyStatus: async () => {
        throw new Error('late custody failure');
      },
    });

    setAuthSupabaseClientFactoryForTests(() =>
      createClaimsAuthSupabase('Guard', 'guard-1@umak.edu.ph')
    );
    t.after(() => setAuthSupabaseClientFactoryForTests(null));

    const res = await app.inject({
      method: 'POST',
      url: '/claims/process',
      headers: {
        authorization: `Bearer ${createToken('Guard', 'guard-1', 'guard-1@umak.edu.ph')}`,
      },
      payload: {
        found_post_id: 42,
        claim_details: {
          claimer_name: 'Claimed Student',
          claimer_school_email: 'claimed.student@umak.edu.ph',
          claimer_contact_num: '0912 345 6789',
        },
      },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(rpcCalls.length, 1);
    assert.deepEqual(postUpdates, [
      {
        postId: 42,
        values: {
          status: 'accepted',
        },
      },
    ]);
    assert.deepEqual(JSON.parse(res.body), {
      success: true,
      claim_id: 'claim-post-commit-123',
    });

    await app.close();
  }
);
