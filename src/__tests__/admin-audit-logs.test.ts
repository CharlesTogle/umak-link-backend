import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import jwt from 'jsonwebtoken';
import { setAuthSupabaseClientFactoryForTests } from '../middleware/auth.js';
import { errorHandler } from '../middleware/error-handler.js';
import adminRoutes, { AdminRouteServices } from '../routes/admin.js';
import { UserType } from '../types/auth.js';

const JWT_SECRET = process.env.JWT_SECRET || 'test_secret_for_tests';

function createToken(
  userType: UserType,
  userId = 'admin-1',
  email = 'admin-1@umak.edu.ph'
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

test('GET /admin/audit-logs normalizes UTC timestamps for clients', async (t) => {
  const auditRows = [
    {
      log_id: 'audit-1',
      user_id: 'staff-1',
      user_name: 'Alexa Joanne Paula San Jose',
      email: 'asanjose@umak.edu.ph',
      profile_picture_url: null,
      action_type: 'claim_processed',
      details: {
        message: "Alexa Joanne Paula San Jose processed Rolan Jero Pinton's claim for Custom Keycaps Keyboard",
        timestamp: '2026-05-16T17:08:00.000Z',
      },
      // The view returns a UTC clock string without an offset.
      timestamp: '2026-05-16T17:08:00',
      // The raw view-local field is currently not trustworthy and should not be forwarded as-is.
      timestamp_local: '2026-05-16T09:08:00+00:00',
    },
  ];

  const services: AdminRouteServices = {
    getSupabaseClient: () =>
      ({
        from(table: string) {
          assert.equal(table, 'view_audit_logs_with_user_details');

          const query = {
            select(columns: string) {
              assert.equal(columns, '*');
              return query;
            },
            order(column: string, options: { ascending: boolean }) {
              assert.equal(column, 'timestamp');
              assert.deepEqual(options, { ascending: false });
              return query;
            },
            range(start: number, end: number) {
              assert.equal(start, 0);
              assert.equal(end, 19);
              return query;
            },
            not(column: string, operator: string, value: string) {
              assert.equal(column, 'action_type');
              assert.equal(operator, 'in');
              assert.match(value, /custody_attempt_created/);
              return {
                data: auditRows,
                error: null,
              };
            },
          };

          return query;
        },
        async rpc() {
          throw new Error('Unexpected rpc call');
        },
      }) as never,
  };

  const app = Fastify();
  app.setErrorHandler(errorHandler);

  await app.register(adminRoutes, {
    prefix: '/admin',
    services,
  });

  setAuthSupabaseClientFactoryForTests(() =>
    createAuthoritativeAuthSupabase('Admin', 'admin-1@umak.edu.ph')
  );

  t.after(async () => {
    setAuthSupabaseClientFactoryForTests(null);
    await app.close();
  });

  const response = await app.inject({
    method: 'GET',
    url: '/admin/audit-logs',
    headers: {
      authorization: `Bearer ${createToken('Admin')}`,
    },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), {
    logs: [
      {
        audit_id: 'audit-1',
        user_id: 'staff-1',
        action: 'claim_processed',
        table_name: 'audit_table',
        record_id: 'audit-1',
        changes: {
          message: "Alexa Joanne Paula San Jose processed Rolan Jero Pinton's claim for Custom Keycaps Keyboard",
          timestamp: '2026-05-16T17:08:00.000Z',
        },
        timestamp: '2026-05-16T17:08:00.000Z',
        timestamp_local: '2026-05-17T01:08:00+08:00',
        user_table: {
          user_id: 'staff-1',
          user_name: 'Alexa Joanne Paula San Jose',
          email: 'asanjose@umak.edu.ph',
          profile_picture_url: null,
        },
      },
    ],
  });
});
