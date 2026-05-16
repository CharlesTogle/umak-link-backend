import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import jwt from 'jsonwebtoken';
import { setAuthSupabaseClientFactoryForTests } from '../middleware/auth.js';
import notificationsRoutes from '../routes/notifications.js';
import type { NotificationPayload } from '../services/notifications.js';
import type { AuditLogParams } from '../utils/audit-logger.js';

const JWT_SECRET = process.env.JWT_SECRET || 'test_secret_for_tests';

function createToken(userId = 'user-1', userType: 'User' | 'Staff' = 'User'): string {
  return jwt.sign(
    {
      user_id: userId,
      email: `${userId}@umak.edu.ph`,
      user_type: userType,
    },
    JWT_SECRET,
    { algorithm: 'HS256' }
  );
}

function createUnreadCountResponse(mode: 'canonical' | 'legacy42703') {
  const canonicalRows = [
    {
      notification_id: 'notification-1',
      sent_to: 'user-1',
      sent_by: 'staff-1',
      type: 'info',
    },
    {
      notification_id: 'notification-2',
      sent_to: 'user-1',
      sent_by: 'user-1',
      type: 'announcement',
    },
  ];

  const legacyRows = [
    {
      notification_id: 'notification-legacy',
      user_id: 'user-1',
      sent_by: 'staff-1',
      type: 'info',
    },
  ];

  return {
    from(table: string) {
      assert.equal(table, 'notification_table');

      return {
        select(columns: string) {
          if (columns === 'notification_id, sent_to, sent_by, type') {
            return {
              eq(column: string, value: unknown) {
                assert.equal(column, 'sent_to');
                assert.equal(value, 'user-1');

                return {
                  async eq(nextColumn: string, nextValue: unknown) {
                    assert.equal(nextColumn, 'is_read');
                    assert.equal(nextValue, false);

                    if (mode === 'legacy42703') {
                      return {
                        data: null,
                        error: {
                          code: '42703',
                          message: 'column notification_table.sent_to does not exist',
                        },
                      };
                    }

                    return {
                      data: canonicalRows,
                      error: null,
                    };
                  },
                };
              },
            };
          }

          if (columns === 'notification_id, user_id, sent_by, type') {
            return {
              eq(column: string, value: unknown) {
                assert.equal(column, 'user_id');
                assert.equal(value, 'user-1');

                return {
                  async eq(nextColumn: string, nextValue: unknown) {
                    assert.equal(nextColumn, 'is_read');
                    assert.equal(nextValue, false);

                    return {
                      data: legacyRows,
                      error: null,
                    };
                  },
                };
              },
            };
          }

          assert.fail(`Unexpected notification_table select: ${columns}`);
        },
      };
    },
  } as never;
}

function createAuthoritativeAuthSupabase(
  userType: 'User' | 'Staff' | 'Admin' | 'Guard',
  email: string
) {
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

test('GET /notifications/count uses sent_to on canonical notification_table schemas', async () => {
  const app = Fastify();
  await app.register(notificationsRoutes, {
    prefix: '/notifications',
    services: {
      getSupabaseClient: () => createUnreadCountResponse('canonical'),
    },
  });

  const res = await app.inject({
    method: 'GET',
    url: '/notifications/count',
    headers: {
      authorization: `Bearer ${createToken()}`,
    },
  });

  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json(), { unread_count: 1 });
  await app.close();
});

test('GET /notifications/count falls back to user_id when sent_to is missing with a 42703 error', async () => {
  const app = Fastify();
  await app.register(notificationsRoutes, {
    prefix: '/notifications',
    services: {
      getSupabaseClient: () => createUnreadCountResponse('legacy42703'),
    },
  });

  const res = await app.inject({
    method: 'GET',
    url: '/notifications/count',
    headers: {
      authorization: `Bearer ${createToken()}`,
    },
  });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { unread_count: 1 });
  await app.close();
});

test('POST /notifications/send writes recipient name and content into the audit log', async (t) => {
  let capturedNotificationPayload: Record<string, unknown> | null = null;
  let capturedAuditDetails: Record<string, unknown> = {};

  setAuthSupabaseClientFactoryForTests(() =>
    createAuthoritativeAuthSupabase('Staff', 'staff-1@umak.edu.ph')
  );
  t.after(() => setAuthSupabaseClientFactoryForTests(null));

  const app = Fastify();
  await app.register(notificationsRoutes, {
    prefix: '/notifications',
    services: {
      getSupabaseClient: () =>
        ({
          from(table: string) {
            assert.equal(table, 'user_table');

            return {
              select(columns: string) {
                assert.equal(columns, 'user_name, email');

                return {
                  eq(column: string, value: unknown) {
                    assert.equal(column, 'user_id');
                    assert.equal(value, 'student-1');

                    return {
                      async single() {
                        return {
                          data: {
                            user_name: 'Juan Dela Cruz',
                            email: 'juan.delacruz@umak.edu.ph',
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
        }) as never,
      createNotification: async (payload: NotificationPayload) => {
        capturedNotificationPayload = payload as unknown as Record<string, unknown>;
        return 'notification-123';
      },
      getUserName: async (userId: string) => {
        assert.equal(userId, 'staff-1');
        return 'Charles Nathaniel Togle';
      },
      logAudit: async (params: AuditLogParams) => {
        capturedAuditDetails = params.details;
      },
    },
  });

  const res = await app.inject({
    method: 'POST',
    url: '/notifications/send',
    headers: {
      authorization: `Bearer ${createToken('staff-1', 'Staff')}`,
    },
    payload: {
      user_id: 'student-1',
      title: 'Post Accepted',
      body: 'Your post has been accepted.',
      type: 'accept',
    },
  });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { success: true, notification_id: 'notification-123' });
  assert.deepEqual(capturedNotificationPayload, {
    user_id: 'student-1',
    title: 'Post Accepted',
    body: 'Your post has been accepted.',
    type: 'accept',
    sent_by: 'staff-1',
  });
  assert.equal(capturedAuditDetails?.message, 'Charles Nathaniel Togle sent "Post Accepted" to Juan Dela Cruz');
  assert.equal(capturedAuditDetails?.notification_id, 'notification-123');
  assert.equal(capturedAuditDetails?.notification_type, 'accept');
  assert.equal(capturedAuditDetails?.recipient_name, 'Juan Dela Cruz');
  assert.equal(capturedAuditDetails?.recipient_user_id, 'student-1');
  assert.equal(capturedAuditDetails?.notification_title, 'Post Accepted');
  assert.equal(capturedAuditDetails?.content, 'Your post has been accepted.');
  assert.equal(typeof capturedAuditDetails?.timestamp, 'string');
  await app.close();
});
