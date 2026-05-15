import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import jwt from 'jsonwebtoken';
import notificationsRoutes from '../routes/notifications.js';

const JWT_SECRET = process.env.JWT_SECRET || 'test_secret_for_tests';

function createToken(userId = 'user-1'): string {
  return jwt.sign(
    {
      user_id: userId,
      email: `${userId}@umak.edu.ph`,
      user_type: 'User',
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

  assert.equal(res.statusCode, 200);
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
