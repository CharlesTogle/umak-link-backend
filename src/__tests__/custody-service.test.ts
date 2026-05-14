import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createCustodyAttempt,
  escalateStaleAcceptedCustodyAttempts,
  notifyGuardForCustodyFollowUp,
} from '../services/custody.js';

const baseInput = {
  post_id: 42,
  guard_post_id: 'guard-post-1',
  handover_image_url: 'https://example.com/handover.webp',
  handover_image_hash: 'handover-hash-1',
  session_token: 'live-qr-session-token',
  actor: {
    user_id: 'user-1',
    email: 'user-1@umak.edu.ph',
    user_type: 'User' as const,
  },
};

for (const custodyStatus of [
  'with_guard',
  'in_security_office',
  'under_investigation',
] as const) {
  test(`createCustodyAttempt rejects posts already in ${custodyStatus}`, async () => {
    const fakeSupabase = {
      from(table: string) {
        assert.equal(table, 'post_public_view');

        return {
          select(columns: string) {
            assert.equal(columns, 'post_id, item_id, poster_id, item_type, post_status, custody_status');

            return {
              eq(column: string, value: number) {
                assert.equal(column, 'post_id');
                assert.equal(value, baseInput.post_id);

                return {
                  async single() {
                    return {
                      data: {
                        post_id: 42,
                        item_id: 'item-1',
                        poster_id: 'user-1',
                        item_type: 'found',
                        post_status: 'accepted',
                        custody_status: custodyStatus,
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

    await assert.rejects(
      () =>
        createCustodyAttempt(baseInput, {
          getSupabase: () => fakeSupabase,
        }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal((error as Error & { statusCode?: number }).statusCode, 409);
        assert.equal(
          error.message,
          'Post cannot start a new custody handover from its current custody state'
        );
        return true;
      }
    );
  });
}

test('notifyGuardForCustodyFollowUp creates an in-app notification for the accepted guard', async () => {
  let capturedNotificationPayload: Record<string, unknown> | null = null;
  let capturedAuditDetails: Record<string, unknown> | null = null;

  const fakeSupabase = {
    from(table: string) {
      if (table === 'post_public_view') {
        return {
          select(columns: string) {
            assert.equal(columns, 'post_id, item_id, poster_id, item_type, post_status, custody_status');

            return {
              eq(column: string, value: number) {
                assert.equal(column, 'post_id');
                assert.equal(value, 42);

                return {
                  async single() {
                    return {
                      data: {
                        post_id: 42,
                        item_id: 'item-1',
                        poster_id: 'user-1',
                        item_type: 'found',
                        post_status: 'accepted',
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
            assert.equal(
              columns,
              'custody_attempt_id, post_id, item_id, poster_id, guard_post_id, handover_image_id, attempt_number, number_of_attempts, status, decision_by_guard_id, decision_at, closed_at, office_received_by_staff_id, office_received_at, investigation_opened_by, investigation_opened_at'
            );

            return {
              eq(column: string, value: unknown) {
                if (column === 'post_id') {
                  assert.equal(value, 42);
                  return this;
                }

                if (column === 'status') {
                  assert.equal(value, 'accepted');
                  return this;
                }

                throw new Error(`Unexpected filter column: ${column}`);
              },
              order(column: string, options: { ascending: boolean }) {
                assert.equal(column, 'attempt_number');
                assert.equal(options.ascending, false);
                return this;
              },
              limit(limitValue: number) {
                assert.equal(limitValue, 1);
                return this;
              },
              async maybeSingle() {
                return {
                  data: {
                    custody_attempt_id: 'attempt-1',
                    post_id: 42,
                    item_id: 'item-1',
                    poster_id: 'user-1',
                    guard_post_id: 'guard-post-1',
                    handover_image_id: 10,
                    attempt_number: 1,
                    number_of_attempts: 1,
                    status: 'accepted',
                    decision_by_guard_id: 'guard-1',
                    decision_at: '2026-05-14T09:00:00.000Z',
                    closed_at: '2026-05-14T09:00:00.000Z',
                    office_received_by_staff_id: null,
                    office_received_at: null,
                    investigation_opened_by: null,
                    investigation_opened_at: null,
                  },
                  error: null,
                };
              },
            };
          },
        };
      }

      throw new Error(`Unexpected table access: ${table}`);
    },
  } as never;

  const response = await notifyGuardForCustodyFollowUp(
    {
      post_id: 42,
      actor: {
        user_id: 'staff-1',
        email: 'staff-1@umak.edu.ph',
        user_type: 'Staff',
      },
    },
    {
      getSupabase: () => fakeSupabase,
      now: () => new Date('2026-05-14T10:00:00.000Z'),
      notificationCreator: async (payload) => {
        capturedNotificationPayload = payload as unknown as Record<string, unknown>;
        return 'notification-1';
      },
      auditLogger: async (params) => {
        capturedAuditDetails = params.details;
      },
    }
  );

  assert.deepEqual(response, {
    post_id: 42,
    custody_attempt_id: 'attempt-1',
    guard_id: 'guard-1',
    notification_id: 'notification-1',
    notification_status: 'created',
    requested_at: '2026-05-14T10:00:00.000Z',
  });

  assert.deepEqual(capturedNotificationPayload, {
    user_id: 'guard-1',
    title: 'Custody Follow-up Needed',
    body: 'A staff member requested follow-up for a custody handover that has not yet been received in the Security Office.',
    description: 'Please review the accepted custody handover and coordinate delivery to the Security Office.',
    type: 'custody_guard_follow_up',
    data: {
      post_id: 42,
      custody_attempt_id: 'attempt-1',
      guard_id: 'guard-1',
      url: '/guard/notifications',
    },
    sent_by: 'staff-1',
    skip_push: true,
  });

  assert.deepEqual(capturedAuditDetails, {
    post_id: 42,
    item_id: 'item-1',
    custody_attempt_id: 'attempt-1',
    guard_id: 'guard-1',
    notification_id: 'notification-1',
  });
});

test('notifyGuardForCustodyFollowUp rejects already received items', async () => {
  const fakeSupabase = {
    from(table: string) {
      if (table === 'post_public_view') {
        return {
          select() {
            return {
              eq() {
                return {
                  async single() {
                    return {
                      data: {
                        post_id: 42,
                        item_id: 'item-1',
                        poster_id: 'user-1',
                        item_type: 'found',
                        post_status: 'accepted',
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
      }

      if (table === 'custody_attempt_table') {
        return {
          select() {
            return {
              eq() {
                return this;
              },
              order() {
                return this;
              },
              limit() {
                return this;
              },
              async maybeSingle() {
                return {
                  data: {
                    custody_attempt_id: 'attempt-1',
                    post_id: 42,
                    item_id: 'item-1',
                    poster_id: 'user-1',
                    guard_post_id: 'guard-post-1',
                    handover_image_id: 10,
                    attempt_number: 1,
                    number_of_attempts: 1,
                    status: 'accepted',
                    decision_by_guard_id: 'guard-1',
                    decision_at: '2026-05-14T09:00:00.000Z',
                    closed_at: '2026-05-14T09:00:00.000Z',
                    office_received_by_staff_id: 'staff-2',
                    office_received_at: '2026-05-14T09:30:00.000Z',
                    investigation_opened_by: null,
                    investigation_opened_at: null,
                  },
                  error: null,
                };
              },
            };
          },
        };
      }

      throw new Error(`Unexpected table access: ${table}`);
    },
  } as never;

  await assert.rejects(
    () =>
      notifyGuardForCustodyFollowUp(
        {
          post_id: 42,
          actor: {
            user_id: 'staff-1',
            email: 'staff-1@umak.edu.ph',
            user_type: 'Staff',
          },
        },
        {
          getSupabase: () => fakeSupabase,
        }
      ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as Error & { statusCode?: number }).statusCode, 409);
      assert.equal(error.message, 'Item is already marked as received in the Security Office');
      return true;
    }
  );
});

test('escalateStaleAcceptedCustodyAttempts opens investigations for accepted handovers older than the threshold', async () => {
  const insertedRecords: Array<Record<string, unknown>> = [];
  const auditDetails: Array<Record<string, unknown> | null | undefined> = [];
  const staleAttempts = [
    {
      custody_attempt_id: 'attempt-1',
      post_id: 42,
      item_id: 'item-1',
      poster_id: 'user-1',
      guard_post_id: 'guard-post-1',
      handover_image_id: 10,
      attempt_number: 1,
      number_of_attempts: 1,
      status: 'accepted',
      decision_by_guard_id: 'guard-1',
      decision_at: '2026-05-12T11:00:00.000Z',
      closed_at: '2026-05-12T11:00:00.000Z',
      office_received_by_staff_id: null,
      office_received_at: null,
      investigation_opened_by: null,
      investigation_opened_at: null,
    },
    {
      custody_attempt_id: 'attempt-2',
      post_id: 43,
      item_id: 'item-2',
      poster_id: 'user-2',
      guard_post_id: 'guard-post-2',
      handover_image_id: 11,
      attempt_number: 1,
      number_of_attempts: 1,
      status: 'accepted',
      decision_by_guard_id: 'guard-2',
      decision_at: '2026-05-11T12:00:00.000Z',
      closed_at: '2026-05-11T12:00:00.000Z',
      office_received_by_staff_id: null,
      office_received_at: null,
      investigation_opened_by: null,
      investigation_opened_at: null,
    },
  ];

  const fakeSupabase = {
    from(table: string) {
      if (table === 'user_table') {
        return {
          select(columns: string) {
            assert.equal(columns, 'user_id, user_type, email');
            return {
              eq(column: string, value: string) {
                assert.equal(column, 'user_id');
                assert.equal(value, 'staff-automation-1');
                return {
                  async single() {
                    return {
                      data: {
                        user_id: 'staff-automation-1',
                        user_type: 'Staff',
                        email: 'automation@umak.edu.ph',
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
            assert.equal(
              columns,
              'custody_attempt_id, post_id, item_id, poster_id, guard_post_id, handover_image_id, attempt_number, number_of_attempts, status, decision_by_guard_id, decision_at, closed_at, office_received_by_staff_id, office_received_at, investigation_opened_by, investigation_opened_at'
            );

            return {
              eq(column: string, value: unknown) {
                if (column === 'status') {
                  assert.equal(value, 'accepted');
                  return this;
                }

                throw new Error(`Unexpected eq column: ${column}`);
              },
              is(column: string, value: null) {
                assert.equal(value, null);
                assert.ok(
                  column === 'office_received_at' || column === 'investigation_opened_at'
                );
                return this;
              },
              lte(column: string, value: string) {
                assert.equal(column, 'decision_at');
                assert.equal(value, '2026-05-12T12:00:00.000Z');
                return this;
              },
              async order(column: string, options: { ascending: boolean }) {
                assert.equal(column, 'decision_at');
                assert.equal(options.ascending, true);
                return {
                  data: staleAttempts,
                  error: null,
                };
              },
            };
          },
          update(values: Record<string, unknown>) {
            assert.deepEqual(values, {
              investigation_opened_by: 'staff-automation-1',
              investigation_opened_at: '2026-05-14T12:00:00.000Z',
            });

            return {
              in(column: string, value: string[]) {
                assert.equal(column, 'custody_attempt_id');
                assert.deepEqual(value, ['attempt-1', 'attempt-2']);
                return Promise.resolve({
                  error: null,
                });
              },
            };
          },
        };
      }

      if (table === 'custody_record_table') {
        return {
          insert(records: Array<Record<string, unknown>>) {
            insertedRecords.push(...records);
            return {
              async select(selectColumns: string) {
                assert.equal(selectColumns, 'custody_record_id');
                return {
                  async single() {
                    return {
                      data: { custody_record_id: 'record-1' },
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

  const response = await escalateStaleAcceptedCustodyAttempts({
    getSupabase: () => fakeSupabase,
    now: () => new Date('2026-05-14T12:00:00.000Z'),
    automationStaffUserId: 'staff-automation-1',
    staleAcceptedEscalationHours: 48,
    auditLogger: async (params) => {
      auditDetails.push(params.details);
    },
  });

  assert.deepEqual(response, {
    escalated_count: 2,
  });

  assert.equal(insertedRecords.length, 2);
  assert.deepEqual(insertedRecords[0], {
    post_id: 42,
    item_id: 'item-1',
    custody_attempt_id: 'attempt-1',
    qr_code_session_id: null,
    guard_post_id: 'guard-post-1',
    actor_user_id: 'staff-automation-1',
    record_type: 'investigation_opened',
    visible_to_poster: true,
    details: {
      attempt_status: 'accepted',
      escalation_reason: 'accepted_not_received_after_threshold',
      decision_at: '2026-05-12T11:00:00.000Z',
      threshold_hours: 48,
    },
    occurred_at: '2026-05-14T12:00:00.000Z',
  });
  assert.equal(auditDetails.length, 2);
});

test('escalateStaleAcceptedCustodyAttempts rejects missing automation staff configuration', async () => {
  const fakeSupabase = {
    from() {
      throw new Error('No database access expected when automation staff user is missing');
    },
  } as never;

  await assert.rejects(
    () =>
      escalateStaleAcceptedCustodyAttempts({
        getSupabase: () => fakeSupabase,
        automationStaffUserId: null,
      }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as Error & { statusCode?: number }).statusCode, 500);
      assert.equal(error.message, 'Custody automation staff user is not configured');
      return true;
    }
  );
});
