import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createCustodyAttempt,
  escalateStaleAcceptedCustodyAttempts,
  getStudentCustodyHistory,
  notifyGuardForCustodyFollowUp,
  openCustodyInvestigation,
  updatePostCustodyStatus,
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

test('getStudentCustodyHistory includes guard decision notes in poster-visible history', async () => {
  const fakeSupabase = {
    from(table: string) {
      if (table === 'post_public_view') {
        return {
          select(columns: string) {
            assert.equal(
              columns,
              'post_id, item_id, poster_id, item_type, post_status, item_status, custody_status, submission_date'
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
                        item_id: 'item-1',
                        poster_id: 'user-1',
                        item_type: 'found',
                        post_status: 'accepted',
                        item_status: 'unclaimed',
                        custody_status: 'with_reporter',
                        submission_date: '2026-05-14T09:00:00.000Z',
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
          select(columns: string) {
            assert.equal(
              columns,
              'custody_record_id, post_id, item_id, custody_attempt_id, qr_code_session_id, guard_post_id, actor_user_id, record_type, details, occurred_at'
            );

            return {
              eq(column: string, value: number | boolean) {
                assert.equal(column, 'post_id');
                assert.equal(value, 42);

                return {
                  eq(nextColumn: string, nextValue: boolean) {
                    assert.equal(nextColumn, 'visible_to_poster');
                    assert.equal(nextValue, true);

                    return {
                      order(orderColumn: string, options: { ascending: boolean }) {
                        assert.equal(orderColumn, 'occurred_at');
                        assert.deepEqual(options, { ascending: true });

                        return Promise.resolve({
                          data: [
                            {
                              custody_record_id: 'history-1',
                              post_id: 42,
                              item_id: 'item-1',
                              custody_attempt_id: 'attempt-1',
                              qr_code_session_id: 'session-1',
                              guard_post_id: 'guard-post-1',
                              actor_user_id: 'guard-1',
                              record_type: 'guard_rejected',
                              details: {
                                decision: 'rejected',
                                decision_reason: 'hello test optional reason',
                              },
                              occurred_at: '2026-05-14T09:15:00.000Z',
                            },
                          ],
                          error: null,
                        });
                      },
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
              'custody_attempt_id, attempt_number, handover_image_id, guard_post_id'
            );

            return {
              eq(column: string, value: number) {
                assert.equal(column, 'post_id');
                assert.equal(value, 42);

                return {
                  order(orderColumn: string, options: { ascending: boolean }) {
                    assert.equal(orderColumn, 'attempt_number');
                    assert.deepEqual(options, { ascending: true });

                    return Promise.resolve({
                      data: [
                        {
                          custody_attempt_id: 'attempt-1',
                          attempt_number: 1,
                          handover_image_id: 99,
                          guard_post_id: 'guard-post-1',
                        },
                      ],
                      error: null,
                    });
                  },
                };
              },
            };
          },
        };
      }

      if (table === 'item_image_table') {
        return {
          select(columns: string) {
            assert.equal(columns, 'item_image_id, image_link');

            return {
              in(column: string, values: number[]) {
                assert.equal(column, 'item_image_id');
                assert.deepEqual(values, [99]);

                return Promise.resolve({
                  data: [
                    {
                      item_image_id: 99,
                      image_link: 'https://example.com/handover.webp',
                    },
                  ],
                  error: null,
                });
              },
            };
          },
        };
      }

      if (table === 'guard_post_table') {
        return {
          select(columns: string) {
            assert.equal(columns, 'guard_post_id, guard_post_name, location_id, is_active');

            return {
              in(column: string, values: string[]) {
                assert.equal(column, 'guard_post_id');
                assert.deepEqual(values, ['guard-post-1']);

                return Promise.resolve({
                  data: [
                    {
                      guard_post_id: 'guard-post-1',
                      guard_post_name: 'Academic Building 1',
                      location_id: 17,
                      is_active: true,
                    },
                  ],
                  error: null,
                });
              },
            };
          },
        };
      }

      if (table === 'location_lookup') {
        return {
          select(columns: string) {
            assert.equal(columns, 'location_id, full_location_name');

            return {
              in(column: string, values: number[]) {
                assert.equal(column, 'location_id');
                assert.deepEqual(values, [17]);

                return Promise.resolve({
                  data: [
                    {
                      location_id: 17,
                      full_location_name: 'Academic Building 1',
                    },
                  ],
                  error: null,
                });
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
              in(column: string, values: string[]) {
                assert.equal(column, 'user_id');
                assert.deepEqual(values, ['guard-1']);

                return Promise.resolve({
                  data: [
                    {
                      user_id: 'guard-1',
                      user_name: 'Guard Stefanie Gabion',
                    },
                  ],
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

  const response = await getStudentCustodyHistory(
    {
      post_id: 42,
      actor: {
        user_id: 'user-1',
        email: 'user-1@umak.edu.ph',
        user_type: 'User',
      },
    },
    {
      getSupabase: () => fakeSupabase,
    }
  );

  assert.deepEqual(response.history, [
    {
      history_id: 'item-reported-42',
      event_type: 'item_reported',
      source_record_type: null,
      message: 'Item reported in Umak Link',
      occurred_at: '2026-05-14T09:00:00.000Z',
      custody_attempt_id: null,
      qr_code_session_id: null,
      attempt_number: null,
      guard_post_id: null,
      guard_post_name: null,
      full_location_name: null,
      handover_image_url: null,
      actor_user_id: 'user-1',
      actor_name: null,
    },
    {
      history_id: 'history-1',
      event_type: 'guard_rejected',
      source_record_type: 'guard_rejected',
      message: 'Guard Guard Stefanie Gabion has rejected the handover',
      occurred_at: '2026-05-14T09:15:00.000Z',
      custody_attempt_id: 'attempt-1',
      qr_code_session_id: 'session-1',
      attempt_number: 1,
      guard_post_id: 'guard-post-1',
      guard_post_name: 'Academic Building 1',
      full_location_name: 'Academic Building 1',
      handover_image_url: 'https://example.com/handover.webp',
      actor_user_id: 'guard-1',
      actor_name: 'Guard Stefanie Gabion',
      decision_reason: 'hello test optional reason',
      discard_reason: null,
    },
  ]);
});

test('getStudentCustodyHistory allows the accepted guard to read tracking history', async () => {
  const fakeSupabase = {
    from(table: string) {
      if (table === 'post_public_view') {
        return {
          select(columns: string) {
            assert.equal(
              columns,
              'post_id, item_id, poster_id, item_type, post_status, item_status, custody_status, submission_date'
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
                        item_id: 'item-1',
                        poster_id: 'user-1',
                        item_type: 'found',
                        post_status: 'pending',
                        item_status: 'unclaimed',
                        custody_status: 'with_guard',
                        submission_date: '2026-05-14T09:00:00.000Z',
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
            if (
              columns ===
              'custody_attempt_id, post_id, item_id, poster_id, guard_post_id, handover_image_id, attempt_number, number_of_attempts, status, decision_by_guard_id, decision_at, closed_at, created_at, office_received_by_staff_id, office_received_at, investigation_opened_by, investigation_opened_at'
            ) {
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
                                      custody_attempt_id: 'attempt-1',
                                      post_id: 42,
                                      item_id: 'item-1',
                                      poster_id: 'user-1',
                                      guard_post_id: 'guard-post-1',
                                      handover_image_id: 99,
                                      attempt_number: 1,
                                      number_of_attempts: 1,
                                      status: 'accepted',
                                      decision_by_guard_id: 'guard-1',
                                      decision_at: '2026-05-14T09:15:00.000Z',
                                      closed_at: '2026-05-14T09:15:00.000Z',
                                      created_at: '2026-05-14T09:05:00.000Z',
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
                        },
                      };
                    },
                  };
                },
              };
            }

            assert.equal(
              columns,
              'custody_attempt_id, attempt_number, handover_image_id, guard_post_id'
            );

            return {
              eq(column: string, value: number) {
                assert.equal(column, 'post_id');
                assert.equal(value, 42);

                return {
                  order(orderColumn: string, options: { ascending: boolean }) {
                    assert.equal(orderColumn, 'attempt_number');
                    assert.deepEqual(options, { ascending: true });

                    return Promise.resolve({
                      data: [],
                      error: null,
                    });
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
            assert.deepEqual(values, {
              custody_status: 'under_investigation',
            });

            return {
              in(column: string, value: string[]) {
                assert.equal(column, 'item_id');
                assert.deepEqual(value, ['item-1', 'item-2']);
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
          update(values: Record<string, unknown>) {
            assert.deepEqual(values, {
              custody_status: 'under_investigation',
            });

            return {
              in(column: string, value: string[]) {
                assert.equal(column, 'item_id');
                assert.deepEqual(value, ['item-1', 'item-2']);
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
          update(values: Record<string, unknown>) {
            assert.deepEqual(values, {
              custody_status: 'under_investigation',
            });

            return {
              in(column: string, value: string[]) {
                assert.equal(column, 'item_id');
                assert.deepEqual(value, ['item-1', 'item-2']);
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
          select(columns: string) {
            assert.equal(
              columns,
              'custody_record_id, post_id, item_id, custody_attempt_id, qr_code_session_id, guard_post_id, actor_user_id, record_type, details, occurred_at'
            );

            return {
              eq(column: string, value: number | boolean) {
                assert.equal(column, 'post_id');
                assert.equal(value, 42);

                return {
                  eq(nextColumn: string, nextValue: boolean) {
                    assert.equal(nextColumn, 'visible_to_poster');
                    assert.equal(nextValue, true);

                    return {
                      order(orderColumn: string, options: { ascending: boolean }) {
                        assert.equal(orderColumn, 'occurred_at');
                        assert.deepEqual(options, { ascending: true });

                        return Promise.resolve({
                          data: [],
                          error: null,
                        });
                      },
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

  const response = await getStudentCustodyHistory(
    {
      post_id: 42,
      actor: {
        user_id: 'guard-1',
        email: 'guard-1@umak.edu.ph',
        user_type: 'Guard',
      },
    },
    {
      getSupabase: () => fakeSupabase,
    }
  );

  assert.deepEqual(response.history, [
    {
      history_id: 'item-reported-42',
      event_type: 'item_reported',
      source_record_type: null,
      message: 'Item reported in Umak Link',
      occurred_at: '2026-05-14T09:00:00.000Z',
      custody_attempt_id: null,
      qr_code_session_id: null,
      attempt_number: null,
      guard_post_id: null,
      guard_post_name: null,
      full_location_name: null,
      handover_image_url: null,
      actor_user_id: 'user-1',
      actor_name: null,
    },
  ]);
});

test('getStudentCustodyHistory still rejects guards who do not own the active review', async () => {
  const fakeSupabase = {
    from(table: string) {
      if (table === 'post_public_view') {
        return {
          select(columns: string) {
            assert.equal(
              columns,
              'post_id, item_id, poster_id, item_type, post_status, item_status, custody_status, submission_date'
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
                        item_id: 'item-1',
                        poster_id: 'user-1',
                        item_type: 'found',
                        post_status: 'pending',
                        item_status: 'unclaimed',
                        custody_status: 'with_guard',
                        submission_date: '2026-05-14T09:00:00.000Z',
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
              'custody_attempt_id, post_id, item_id, poster_id, guard_post_id, handover_image_id, attempt_number, number_of_attempts, status, decision_by_guard_id, decision_at, closed_at, created_at, office_received_by_staff_id, office_received_at, investigation_opened_by, investigation_opened_at'
            );

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
                                    custody_attempt_id: 'attempt-1',
                                    post_id: 42,
                                    item_id: 'item-1',
                                    poster_id: 'user-1',
                                    guard_post_id: 'guard-post-1',
                                    handover_image_id: 99,
                                    attempt_number: 1,
                                    number_of_attempts: 1,
                                    status: 'accepted',
                                    decision_by_guard_id: 'guard-2',
                                    decision_at: '2026-05-14T09:15:00.000Z',
                                    closed_at: '2026-05-14T09:15:00.000Z',
                                    created_at: '2026-05-14T09:05:00.000Z',
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
                      },
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

  await assert.rejects(
    () =>
      getStudentCustodyHistory(
        {
          post_id: 42,
          actor: {
            user_id: 'guard-1',
            email: 'guard-1@umak.edu.ph',
            user_type: 'Guard',
          },
        },
        {
          getSupabase: () => fakeSupabase,
        }
      ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as Error & { statusCode?: number }).statusCode, 403);
      assert.equal(error.message, 'Forbidden');
      return true;
    }
  );
});

for (const custodyStatus of [
  'with_guard',
  'in_security_office',
  'claimed_by_student',
  'under_investigation',
  'discarded',
] as const) {
test(`createCustodyAttempt rejects posts already in ${custodyStatus}`, async () => {
    const fakeSupabase = {
      from(table: string) {
        assert.equal(table, 'post_public_view');

        return {
          select(columns: string) {
            assert.equal(
              columns,
              'post_id, item_id, poster_id, item_type, post_status, custody_status'
            );

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

test('updatePostCustodyStatus updates claimed found item custody and writes poster-visible history', async () => {
  const insertedRecords: Array<Record<string, unknown>> = [];
  let capturedAuditDetails: Record<string, unknown> | null = null;

  const fakeSupabase = {
    from(table: string) {
      if (table === 'post_public_view') {
        return {
          select(columns: string) {
            assert.equal(
              columns,
              'post_id, item_id, item_name, poster_id, item_type, post_status, item_status, custody_status'
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
                        item_id: 'item-1',
                        item_name: 'Canvas Tote Bag',
                        poster_id: 'user-1',
                        item_type: 'found',
                        post_status: 'accepted',
                        item_status: 'claimed',
                        custody_status: 'claimed_by_student',
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
            assert.deepEqual(values, {
              custody_status: 'under_investigation',
            });

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
                        user_name: 'Alyssa Ramos',
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
            assert.deepEqual(values, {
              custody_status: 'under_investigation',
            });

            return {
              in(column: string, value: string[]) {
                assert.equal(column, 'item_id');
                assert.deepEqual(value, ['item-1', 'item-2']);
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
              error: null,
            };
          },
        };
      }

      throw new Error(`Unexpected table access: ${table}`);
    },
  } as never;

  const response = await updatePostCustodyStatus(
    {
      post_id: 42,
      custody_status: 'under_investigation',
      actor: {
        user_id: 'staff-1',
        email: 'staff-1@umak.edu.ph',
        user_type: 'Staff',
      },
      details: {
        claimer_name: 'Jane Doe',
      },
    },
    {
      getSupabase: () => fakeSupabase,
      now: () => new Date('2026-05-14T11:20:00.000Z'),
      auditLogger: async (params) => {
        capturedAuditDetails = params.details as Record<string, unknown>;
      },
    }
  );

  assert.deepEqual(response, {
    post_id: 42,
    item_id: 'item-1',
    custody_status: 'under_investigation',
    updated_at: '2026-05-14T11:20:00.000Z',
  });

  assert.deepEqual(insertedRecords, [
    {
      post_id: 42,
      item_id: 'item-1',
      custody_attempt_id: null,
      qr_code_session_id: null,
      guard_post_id: null,
      actor_user_id: 'staff-1',
      record_type: 'investigation_opened',
      visible_to_poster: true,
      details: {
        previous_custody_status: 'claimed_by_student',
        next_custody_status: 'under_investigation',
        claimer_name: 'Jane Doe',
      },
      occurred_at: '2026-05-14T11:20:00.000Z',
    },
  ]);

  assert.deepEqual(capturedAuditDetails, {
    message: 'Staff Alyssa Ramos marked Canvas Tote Bag under investigation',
    post_title: 'Canvas Tote Bag',
    post_id: 42,
    item_id: 'item-1',
    old_custody_status: 'claimed_by_student',
    new_custody_status: 'under_investigation',
  });
});

test('openCustodyInvestigation persists under_investigation on the item record', async () => {
  const insertedRecords: Array<Record<string, unknown>> = [];
  const auditDetails: Array<Record<string, unknown>> = [];

  const fakeSupabase = {
    from(table: string) {
      if (table === 'post_public_view') {
        return {
          select(columns: string) {
            assert.equal(
              columns,
              'post_id, item_id, item_name, poster_id, item_type, post_status, custody_status'
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
                        item_id: 'item-1',
                        item_name: 'Canvas Tote Bag',
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
              'custody_attempt_id, post_id, item_id, poster_id, guard_post_id, handover_image_id, attempt_number, number_of_attempts, status, decision_by_guard_id, decision_at, closed_at, created_at, office_received_by_staff_id, office_received_at, investigation_opened_by, investigation_opened_at'
            );

            return {
              eq(column: string, value: number) {
                assert.equal(column, 'post_id');
                assert.equal(value, 42);

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
                                custody_attempt_id: 'attempt-1',
                                post_id: 42,
                                item_id: 'item-1',
                                poster_id: 'user-1',
                                guard_post_id: 'guard-post-1',
                                handover_image_id: 99,
                                attempt_number: 1,
                                number_of_attempts: 1,
                                status: 'accepted',
                                decision_by_guard_id: 'guard-2',
                                decision_at: '2026-05-14T09:15:00.000Z',
                                closed_at: '2026-05-14T09:15:00.000Z',
                                created_at: '2026-05-14T09:05:00.000Z',
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
                  },
                };
              },
            };
          },
          update(values: Record<string, unknown>) {
            assert.deepEqual(values, {
              investigation_opened_by: 'staff-1',
              investigation_opened_at: '2026-05-14T12:00:00.000Z',
            });

            return {
              eq(column: string, value: string) {
                assert.equal(column, 'custody_attempt_id');
                assert.equal(value, 'attempt-1');
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
              eq(column: string, value: string) {
                assert.equal(column, 'item_id');
                assert.equal(value, 'item-1');

                return {
                  async single() {
                    return {
                      data: {
                        custody_status: 'under_investigation',
                      },
                      error: null,
                    };
                  },
                };
              },
            };
          },
          update(values: Record<string, unknown>) {
            assert.deepEqual(values, {
              custody_status: 'under_investigation',
            });

            return {
              in(column: string, value: string[]) {
                assert.equal(column, 'item_id');
                assert.deepEqual(value, ['item-1']);
                return Promise.resolve({
                  error: null,
                });
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
                        user_name: 'Alyssa Ramos',
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
            insertedRecords.push(...records);
            return {
              error: null,
            };
          },
        };
      }

      throw new Error(`Unexpected table access: ${table}`);
    },
  } as never;

  const response = await openCustodyInvestigation(
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
      now: () => new Date('2026-05-14T12:00:00.000Z'),
      auditLogger: async (params) => {
        auditDetails.push(params.details);
      },
    }
  );

  assert.deepEqual(response, {
    post_id: 42,
    custody_attempt_id: 'attempt-1',
    custody_status: 'under_investigation',
    investigation_opened_at: '2026-05-14T12:00:00.000Z',
  });

  assert.equal(insertedRecords.length, 1);
  assert.deepEqual(insertedRecords[0], {
    post_id: 42,
    item_id: 'item-1',
    custody_attempt_id: 'attempt-1',
    qr_code_session_id: null,
    guard_post_id: 'guard-post-1',
    actor_user_id: 'staff-1',
    record_type: 'investigation_opened',
    visible_to_poster: true,
    details: {
      attempt_status: 'accepted',
    },
    occurred_at: '2026-05-14T12:00:00.000Z',
  });
  assert.equal(auditDetails.length, 1);
});

test('updatePostCustodyStatus updates untracked found item custody with the allowed untracked options', async () => {
  const insertedRecords: Array<Record<string, unknown>> = [];
  let capturedAuditDetails: Record<string, unknown> | null = null;

  const fakeSupabase = {
    from(table: string) {
      if (table === 'post_public_view') {
        return {
          select(columns: string) {
            assert.equal(
              columns,
              'post_id, item_id, item_name, poster_id, item_type, post_status, item_status, custody_status'
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
                        item_id: 'item-1',
                        item_name: 'Canvas Tote Bag',
                        poster_id: 'user-1',
                        item_type: 'found',
                        post_status: 'pending',
                        item_status: 'unclaimed',
                        custody_status: 'untracked',
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
            assert.deepEqual(values, {
              custody_status: 'with_guard',
            });

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
                        user_name: 'Alyssa Ramos',
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
            insertedRecords.push(...records);
            return {
              error: null,
            };
          },
        };
      }

      throw new Error(`Unexpected table access: ${table}`);
    },
  } as never;

  const response = await updatePostCustodyStatus(
    {
      post_id: 42,
      custody_status: 'with_guard',
      actor: {
        user_id: 'staff-1',
        email: 'staff-1@umak.edu.ph',
        user_type: 'Staff',
      },
    },
    {
      getSupabase: () => fakeSupabase,
      now: () => new Date('2026-05-14T11:20:00.000Z'),
      auditLogger: async (params) => {
        capturedAuditDetails = params.details as Record<string, unknown>;
      },
    }
  );

  assert.deepEqual(response, {
    post_id: 42,
    item_id: 'item-1',
    custody_status: 'with_guard',
    updated_at: '2026-05-14T11:20:00.000Z',
  });

  assert.deepEqual(insertedRecords, [
    {
      post_id: 42,
      item_id: 'item-1',
      custody_attempt_id: null,
      qr_code_session_id: null,
      guard_post_id: null,
      actor_user_id: 'staff-1',
      record_type: 'staff_marked_with_guard',
      visible_to_poster: true,
      details: {
        previous_custody_status: 'untracked',
        next_custody_status: 'with_guard',
      },
      occurred_at: '2026-05-14T11:20:00.000Z',
    },
  ]);

  assert.deepEqual(capturedAuditDetails, {
    message: 'Staff Alyssa Ramos marked Canvas Tote Bag as with the guard',
    post_title: 'Canvas Tote Bag',
    post_id: 42,
    item_id: 'item-1',
    old_custody_status: 'untracked',
    new_custody_status: 'with_guard',
  });
});

test('updatePostCustodyStatus rejects found items that are neither claimed nor untracked', async () => {
  const fakeSupabase = {
    from(table: string) {
      assert.equal(table, 'post_public_view');

      return {
        select(columns: string) {
          assert.equal(
            columns,
            'post_id, item_id, item_name, poster_id, item_type, post_status, item_status, custody_status'
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
                      item_id: 'item-1',
                      item_name: 'Canvas Tote Bag',
                      poster_id: 'user-1',
                      item_type: 'found',
                      post_status: 'accepted',
                      item_status: 'unclaimed',
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
  } as never;

  await assert.rejects(
    () =>
      updatePostCustodyStatus(
        {
          post_id: 42,
          custody_status: 'claimed_by_student',
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
      assert.equal(error.message, 'Only claimed found items or untracked found items can update custody status');
      return true;
    }
  );
});

test('notifyGuardForCustodyFollowUp creates an in-app notification for the accepted guard', async () => {
  let capturedNotificationPayload: Record<string, unknown> | null = null;
  let capturedAuditDetails: Record<string, unknown> | null = null;

  const fakeSupabase = {
    from(table: string) {
      if (table === 'post_public_view') {
        return {
          select(columns: string) {
            assert.equal(
              columns,
              'post_id, item_id, item_name, poster_id, item_type, post_status, custody_status'
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
                        item_id: 'item-1',
                        item_name: 'Canvas Tote Bag',
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
                        user_name: 'Alyssa Ramos',
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
              'custody_attempt_id, post_id, item_id, poster_id, guard_post_id, handover_image_id, attempt_number, number_of_attempts, status, decision_by_guard_id, decision_at, closed_at, created_at, office_received_by_staff_id, office_received_at, investigation_opened_by, investigation_opened_at'
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
                    created_at: '2026-05-14T08:55:00.000Z',
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
    description:
      'Please review the accepted custody handover and coordinate delivery to the Security Office.',
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
    message: 'Staff Alyssa Ramos requested guard follow-up for Canvas Tote Bag',
    post_title: 'Canvas Tote Bag',
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
      created_at: '2026-05-12T10:45:00.000Z',
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
      created_at: '2026-05-11T11:45:00.000Z',
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
            if (columns === 'user_id, user_type, email') {
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
            }

            assert.equal(columns, 'user_id, user_name');
            return {
              eq(column: string, value: string) {
                assert.equal(column, 'user_id');
                assert.equal(value, 'staff-automation-1');
                return {
                  async single() {
                    return {
                      data: {
                        user_id: 'staff-automation-1',
                        user_name: 'Automated Custody',
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

      if (table === 'post_public_view') {
        return {
          select(columns: string) {
            assert.equal(columns, 'item_name');

            return {
              eq(column: string, value: number) {
                assert.equal(column, 'post_id');
                assert.ok(value === 42 || value === 43);

                return {
                  async single() {
                    return {
                      data: {
                        item_name: value === 42 ? 'Canvas Tote Bag' : 'Silver Water Bottle',
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
              'custody_attempt_id, post_id, item_id, poster_id, guard_post_id, handover_image_id, attempt_number, number_of_attempts, status, decision_by_guard_id, decision_at, closed_at, created_at, office_received_by_staff_id, office_received_at, investigation_opened_by, investigation_opened_at'
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
                assert.ok(column === 'office_received_at' || column === 'investigation_opened_at');
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

      if (table === 'item_table') {
        return {
          update(values: Record<string, unknown>) {
            assert.deepEqual(values, {
              custody_status: 'under_investigation',
            });

            return {
              in(column: string, value: string[]) {
                assert.equal(column, 'item_id');
                assert.deepEqual(value, ['item-1', 'item-2']);
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
  assert.deepEqual(auditDetails[0], {
    message: 'Staff Automated Custody auto-opened a custody investigation for Canvas Tote Bag',
    post_title: 'Canvas Tote Bag',
    post_id: 42,
    item_id: 'item-1',
    custody_attempt_id: 'attempt-1',
    decision_at: '2026-05-12T11:00:00.000Z',
    threshold_hours: 48,
  });
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
