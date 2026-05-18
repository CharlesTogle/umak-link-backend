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
  'POST /claims/process returns the RPC claim_id and forwards linked missing item plus claimed_at',
  { concurrency: false },
  async (t) => {
    const app = Fastify();
    const rpcCalls: Array<{ functionName: string; args: Record<string, unknown> }> = [];

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
                eq(column: string, _value: string) {
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
                      throw new Error(`Unexpected claim_table select columns: ${columns}`);
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

        throw new Error(`Unexpected table: ${table}`);
      },
      async rpc(functionName: string, args: Record<string, unknown>) {
        rpcCalls.push({ functionName, args });
        assert.equal(functionName, 'process_claim');
        return { data: 'claim-123', error: null };
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
      claim_verification: null,
    });
    assert.deepEqual(JSON.parse(res.body), {
      success: true,
      claim_id: 'claim-123',
    });

    await app.close();
  }
);

test(
  'POST /claims/process allows linking a pending missing post without a second route-level promotion',
  { concurrency: false },
  async (t) => {
    const app = Fastify();
    const rpcCalls: Array<{ functionName: string; args: Record<string, unknown> }> = [];

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
                          post_status: 'pending',
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
                eq(column: string, _value: string) {
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
                      throw new Error(`Unexpected claim_table select columns: ${columns}`);
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

        throw new Error(`Unexpected table: ${table}`);
      },
      async rpc(functionName: string, args: Record<string, unknown>) {
        rpcCalls.push({ functionName, args });
        assert.equal(functionName, 'process_claim');
        return { data: 'claim-pending-link-123', error: null };
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
          claimer_contact_num: '0912 345 6789',
          claimed_at: '2026-05-15T09:30:00+08:00',
        },
      },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(rpcCalls.length, 1);
    assert.deepEqual(JSON.parse(res.body), {
      success: true,
      claim_id: 'claim-pending-link-123',
    });

    await app.close();
  }
);

test(
  'POST /claims/process rejects linking a discarded missing item',
  { concurrency: false },
  async (t) => {
    const app = Fastify();
    let rpcCalled = false;

    const fakeSupabase = {
      from(table: string) {
        assert.equal(table, 'post_public_view');

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
                        item_status: 'discarded',
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
        missing_post_id: 24,
        claim_details: {
          claimer_name: 'Bob',
          claimer_school_email: 'bob@umak.edu.ph',
          claimer_contact_num: '0912 345 6789',
        },
      },
    });

    assert.equal(res.statusCode, 400);
    assert.match(res.body, /discarded/i);
    assert.equal(rpcCalled, false);

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
    const auditCalls: Array<{
      userId: string;
      actionType: string;
      details: Record<string, unknown>;
      recordId?: string;
    }> = [];
    let verificationCalled = false;

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
                eq(column: string, _value: string) {
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
                      throw new Error(`Unexpected claim_table select columns: ${columns}`);
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
        return { data: 'claim-guard-direct-123', error: null };
      },
    } as never;

    await app.register(claimsRoutes, {
      prefix: '/claims',
      getSupabase: () => fakeSupabase,
      getUserName: async () => 'Guard One',
      logAudit: async (params: {
        userId: string;
        actionType: string;
        details: Record<string, unknown>;
        recordId?: string;
      }) => {
        auditCalls.push({
          userId: params.userId,
          actionType: params.actionType,
          details: params.details,
          recordId: params.recordId,
        });
      },
      canGuardAccessClaimReview: async () => true,
      verifyClaimSubmission: async () => {
        verificationCalled = true;
        throw new Error('verifyClaimSubmission should not run for direct guard claims');
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
      claim_verification: {
        verification_method: 'guard_qr',
      },
    });
    assert.deepEqual(JSON.parse(res.body), {
      success: true,
      claim_id: 'claim-guard-direct-123',
    });
    assert.equal(verificationCalled, false);
    assert.equal(auditCalls.length, 1);
    assert.equal(auditCalls[0]?.userId, 'guard-1');
    assert.equal(auditCalls[0]?.actionType, 'claim_processed');
    assert.equal(auditCalls[0]?.recordId, 'claim-guard-direct-123');
    assert.equal(auditCalls[0]?.details.item_name, 'Wallet');
    assert.equal(auditCalls[0]?.details.found_post_id, 42);
    assert.equal(auditCalls[0]?.details.missing_post_id, null);
    assert.equal(auditCalls[0]?.details.claimer_name, 'Claimed Student');
    assert.equal(auditCalls[0]?.details.processed_by_staff, 'Guard One');
    assert.equal(
      auditCalls[0]?.details.message,
      "Guard One processed Claimed Student's claim for Wallet"
    );
    assert.equal(typeof auditCalls[0]?.details.timestamp, 'string');

    await app.close();
  }
);

test(
  'POST /claims/process passes finalized guard QR verification metadata into the RPC',
  { concurrency: false },
  async (t) => {
    const app = Fastify();
    const rpcCalls: Array<{ functionName: string; args: Record<string, unknown> }> = [];

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
                eq(column: string, _value: string) {
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
                      throw new Error(`Unexpected claim_table select columns: ${columns}`);
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
        return { data: 'claim-guard-123', error: null };
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
      claim_verification: {
        claim_verification_session_id: 'verification-1',
        claim_qr_session_id: 'qr-1',
        verification_method: 'guard_qr',
        verified_claimer_user_id: 'claimer-1',
      },
    });
    assert.deepEqual(JSON.parse(res.body), {
      success: true,
      claim_id: 'claim-guard-123',
    });

    await app.close();
  }
);

test(
  'POST /claims/process returns failure when the process_claim RPC fails',
  { concurrency: false },
  async (t) => {
    const app = Fastify();
    const rpcCalls: Array<{ functionName: string; args: Record<string, unknown> }> = [];

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
                eq(column: string, _value: string) {
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
                      throw new Error(`Unexpected claim_table select columns: ${columns}`);
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
        return {
          data: null,
          error: {
            code: 'PGRST204',
            message: 'process_claim rpc failed',
          },
        };
      },
    } as never;

    await app.register(claimsRoutes, {
      prefix: '/claims',
      getSupabase: () => fakeSupabase,
      getUserName: async () => 'Guard One',
      logAudit: async () => {},
      canGuardAccessClaimReview: async () => true,
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

    assert.equal(res.statusCode, 500);
    assert.equal(rpcCalls.length, 1);
    assert.deepEqual(JSON.parse(res.body), {
      statusCode: 500,
      code: 'BACKEND_CONFIGURATION_ERROR',
      error: 'Internal Server Error',
      message: 'Failed to process claim',
    });

    await app.close();
  }
);
