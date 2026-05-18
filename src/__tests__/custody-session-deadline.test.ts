import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decideCustodyAttempt,
  expireCustodySessions,
  getCustodySessionStatus,
  retryCustodySession,
  scanCustodySession,
} from '../services/custody.js';

interface AttemptState {
  custody_attempt_id: string;
  post_id: number;
  item_id: string;
  poster_id: string;
  guard_post_id: string;
  handover_image_id: number;
  attempt_number: number;
  number_of_attempts: number;
  status: 'open' | 'accepted' | 'rejected' | 'timed_out' | 'cancelled';
  decision_by_guard_id: string | null;
  decision_at: string | null;
  closed_at: string | null;
  created_at: string;
}

interface SessionState {
  qr_code_session_id: string;
  custody_attempt_id: string;
  session_token_hash: string;
  manual_entry_code: string;
  status: 'active' | 'accepted' | 'rejected' | 'expired' | 'cancelled';
  expires_at: string;
  scanned_by_guard_id: string | null;
  scanned_at: string | null;
  closed_at: string | null;
}

interface LifecycleState {
  attempt: AttemptState;
  session: SessionState;
  custodyStatus: string;
  insertedRecords: Array<Record<string, unknown>>;
}

function createLifecycleState(
  overrides: {
    attempt?: Partial<AttemptState>;
    session?: Partial<SessionState>;
    custodyStatus?: string;
    insertedRecords?: Array<Record<string, unknown>>;
  } = {}
): LifecycleState {
  return {
    attempt: {
      custody_attempt_id: 'attempt-1',
      post_id: 42,
      item_id: 'item-1',
      poster_id: 'user-1',
      guard_post_id: 'guard-post-1',
      handover_image_id: 10,
      attempt_number: 1,
      number_of_attempts: 2,
      status: 'open',
      decision_by_guard_id: null,
      decision_at: null,
      closed_at: null,
      created_at: '2026-05-14T10:00:00.000Z',
      ...overrides.attempt,
    },
    session: {
      qr_code_session_id: 'session-1',
      custody_attempt_id: 'attempt-1',
      session_token_hash: 'session-hash-1',
      manual_entry_code: 'AB2C3D',
      status: 'active',
      expires_at: '2026-05-14T10:16:30.000Z',
      scanned_by_guard_id: null,
      scanned_at: null,
      closed_at: null,
      ...overrides.session,
    },
    custodyStatus: overrides.custodyStatus ?? 'handover_in_progress',
    insertedRecords: overrides.insertedRecords ?? [],
  };
}

function createLifecycleSupabase(state: LifecycleState) {
  return {
    from(table: string) {
      if (table === 'qr_code_session_table') {
        return {
          select(columns: string) {
            assert.equal(
              columns,
              'qr_code_session_id, custody_attempt_id, session_token_hash, manual_entry_code, status, expires_at, scanned_by_guard_id, scanned_at, closed_at'
            );

            return {
              eq(column: string, value: unknown) {
                if (column === 'qr_code_session_id') {
                  assert.equal(value, state.session.qr_code_session_id);
                  return {
                    async single() {
                      return {
                        data: { ...state.session },
                        error: null,
                      };
                    },
                  };
                }

                if (column === 'manual_entry_code') {
                  assert.equal(value, state.session.manual_entry_code);
                  return {
                    async single() {
                      return {
                        data: { ...state.session },
                        error: null,
                      };
                    },
                  };
                }

                if (column === 'status') {
                  assert.equal(value, 'active');
                  return {
                    data: state.session.status === 'active' ? [{ ...state.session }] : [],
                    error: null,
                  };
                }

                throw new Error(`Unexpected qr_code_session_table filter: ${column}`);
              },
            };
          },
          update(values: Record<string, unknown>) {
            return {
              eq(column: string, value: unknown) {
                assert.equal(column, 'qr_code_session_id');
                assert.equal(value, state.session.qr_code_session_id);
                state.session = {
                  ...state.session,
                  ...values,
                } as SessionState;
                return Promise.resolve({
                  error: null,
                });
              },
            };
          },
        };
      }

      if (table === 'custody_attempt_table') {
        return {
          select(columns: string) {
            assert.equal(
              columns,
              'custody_attempt_id, post_id, item_id, poster_id, guard_post_id, handover_image_id, attempt_number, number_of_attempts, status, decision_by_guard_id, decision_at, closed_at, created_at'
            );

            return {
              eq(column: string, value: unknown) {
                assert.equal(column, 'custody_attempt_id');
                assert.equal(value, state.attempt.custody_attempt_id);
                return {
                  async single() {
                    return {
                      data: { ...state.attempt },
                      error: null,
                    };
                  },
                };
              },
            };
          },
          update(values: Record<string, unknown>) {
            return {
              eq(column: string, value: unknown) {
                assert.equal(column, 'custody_attempt_id');
                assert.equal(value, state.attempt.custody_attempt_id);
                state.attempt = {
                  ...state.attempt,
                  ...values,
                } as AttemptState;
                return Promise.resolve({
                  error: null,
                });
              },
            };
          },
        };
      }

      if (table === 'item_table') {
        return {
          select(columns: string) {
            assert.equal(columns, 'custody_status');
            return {
              eq(column: string, value: unknown) {
                assert.equal(column, 'item_id');
                assert.equal(value, state.attempt.item_id);
                return {
                  async single() {
                    return {
                      data: {
                        custody_status: state.custodyStatus,
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
          insert(records: Array<Record<string, unknown>>) {
            state.insertedRecords.push(...records);
            return {
              error: null,
            };
          },
        };
      }

      throw new Error(`Unexpected table access: ${table}`);
    },
  } as never;
}

test('getCustodySessionStatus times out the session when the absolute deadline passes before the QR expires', async () => {
  const state = createLifecycleState({
    custodyStatus: 'with_reporter',
    attempt: {
      number_of_attempts: 2,
    },
    session: {
      expires_at: '2026-05-14T10:16:30.000Z',
    },
  });

  const response = await getCustodySessionStatus(
    {
      actor: {
        user_id: 'user-1',
        email: 'user-1@umak.edu.ph',
        user_type: 'User',
      },
      qr_code_session_id: 'session-1',
    },
    {
      getSupabase: () => createLifecycleSupabase(state),
      now: () => new Date('2026-05-14T10:15:01.000Z'),
      absoluteSessionTtlSeconds: 15 * 60,
      maxSessionAttempts: 5,
      auditLogger: async () => {},
    }
  );

  assert.equal(response.attempt_status, 'timed_out');
  assert.equal(response.qr_status, 'expired');
  assert.equal(response.custody_status, 'with_reporter');
  assert.equal(response.current_window_expired, false);
  assert.equal(response.can_retry, false);
  assert.equal(state.attempt.status, 'timed_out');
  assert.equal(state.session.status, 'expired');
  assert.equal(state.insertedRecords.length, 1);
  assert.equal(state.insertedRecords[0]?.record_type, 'qr_expired');
});

test('retryCustodySession clamps the regenerated QR expiry to the absolute session deadline', async () => {
  const state = createLifecycleState({
    custodyStatus: 'handover_in_progress',
    attempt: {
      number_of_attempts: 4,
    },
    session: {
      expires_at: '2026-05-14T10:14:00.000Z',
    },
  });

  const response = await retryCustodySession(
    {
      actor: {
        user_id: 'user-1',
        email: 'user-1@umak.edu.ph',
        user_type: 'User',
      },
      qr_code_session_id: 'session-1',
      session_token: 'rotated-session-token',
    },
    {
      getSupabase: () => createLifecycleSupabase(state),
      now: () => new Date('2026-05-14T10:14:30.000Z'),
      hashSessionToken: () => 'rotated-session-hash',
      generateManualEntryCode: () => 'ZXCVBN',
      qrSessionTtlSeconds: 120,
      absoluteSessionTtlSeconds: 15 * 60,
      maxSessionAttempts: 5,
      auditLogger: async () => {},
    }
  );

  assert.equal(response.expires_at, '2026-05-14T10:15:00.000Z');
  assert.equal(response.number_of_attempts, 5);
  assert.equal(response.retries_remaining, 0);
  assert.equal(response.manual_entry_code, 'ZXCVBN');
  assert.equal(state.session.expires_at, '2026-05-14T10:15:00.000Z');
  assert.equal(state.session.manual_entry_code, 'ZXCVBN');
});

test('scanCustodySession closes an overdue handover even if the current QR window still looks active', async () => {
  const state = createLifecycleState({
    custodyStatus: 'with_reporter',
    session: {
      expires_at: '2026-05-14T10:16:30.000Z',
    },
  });

  await assert.rejects(
    () =>
      scanCustodySession(
        {
          actor: {
            user_id: 'guard-1',
            email: 'guard-1@umak.edu.ph',
            user_type: 'Guard',
          },
          manual_entry_code: 'AB2C3D',
        },
        {
          getSupabase: () => createLifecycleSupabase(state),
          now: () => new Date('2026-05-14T10:15:01.000Z'),
          absoluteSessionTtlSeconds: 15 * 60,
          maxSessionAttempts: 5,
          auditLogger: async () => {},
        }
      ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as Error & { statusCode?: number }).statusCode, 409);
      assert.equal(error.message, 'QR session is no longer active');
      return true;
    }
  );

  assert.equal(state.attempt.status, 'timed_out');
  assert.equal(state.session.status, 'expired');
  assert.equal(state.insertedRecords.length, 1);
});

test('decideCustodyAttempt allows the scanning guard to finish a review after the QR expiry passes', async () => {
  const state = createLifecycleState({
    custodyStatus: 'with_guard',
    session: {
      expires_at: '2026-05-14T10:16:30.000Z',
      scanned_by_guard_id: 'guard-1',
      scanned_at: '2026-05-14T10:14:45.000Z',
    },
  });

  const response = await decideCustodyAttempt(
    {
      actor: {
        user_id: 'guard-1',
        email: 'guard-1@umak.edu.ph',
        user_type: 'Guard',
      },
      custody_attempt_id: 'attempt-1',
      qr_code_session_id: 'session-1',
      decision: 'accepted',
      decision_reason: 'Validated handover',
    },
    {
      getSupabase: () => createLifecycleSupabase(state),
      now: () => new Date('2026-05-14T10:15:01.000Z'),
      absoluteSessionTtlSeconds: 15 * 60,
      maxSessionAttempts: 5,
      auditLogger: async () => {},
    }
  );

  assert.equal(response.attempt_status, 'accepted');
  assert.equal(response.qr_status, 'accepted');
  assert.equal(response.custody_status, 'with_guard');
  assert.equal(state.attempt.status, 'accepted');
  assert.equal(state.attempt.decision_by_guard_id, 'guard-1');
  assert.equal(state.session.status, 'accepted');
  assert.equal(state.insertedRecords.length, 1);
  assert.equal(state.insertedRecords[0]?.record_type, 'guard_accepted');
});

test('expireCustodySessions times out active sessions that cross the absolute deadline before QR expiry', async () => {
  const state = createLifecycleState({
    custodyStatus: 'with_reporter',
    session: {
      expires_at: '2026-05-14T10:16:30.000Z',
    },
  });

  const response = await expireCustodySessions({
    getSupabase: () => createLifecycleSupabase(state),
    now: () => new Date('2026-05-14T10:15:01.000Z'),
    absoluteSessionTtlSeconds: 15 * 60,
    maxSessionAttempts: 5,
    auditLogger: async () => {},
  });

  assert.deepEqual(response, {
    expired_count: 1,
  });
  assert.equal(state.attempt.status, 'timed_out');
  assert.equal(state.session.status, 'expired');
  assert.equal(state.insertedRecords.length, 1);
});

test('expireCustodySessions leaves scanned sessions open while the guard review is pending', async () => {
  const state = createLifecycleState({
    session: {
      expires_at: '2026-05-14T10:16:30.000Z',
      scanned_by_guard_id: 'guard-1',
      scanned_at: '2026-05-14T10:14:45.000Z',
    },
  });

  const response = await expireCustodySessions({
    getSupabase: () => createLifecycleSupabase(state),
    now: () => new Date('2026-05-14T10:15:01.000Z'),
    absoluteSessionTtlSeconds: 15 * 60,
    maxSessionAttempts: 5,
    auditLogger: async () => {},
  });

  assert.deepEqual(response, {
    expired_count: 0,
  });
  assert.equal(state.attempt.status, 'open');
  assert.equal(state.session.status, 'active');
  assert.equal(state.insertedRecords.length, 0);
});
