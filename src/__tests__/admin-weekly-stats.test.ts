import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import jwt from 'jsonwebtoken';
import { setAuthSupabaseClientFactoryForTests } from '../middleware/auth.js';
import { errorHandler } from '../middleware/error-handler.js';
import adminRoutes, { AdminRouteServices } from '../routes/admin.js';
import { UserType } from '../types/auth.js';

const JWT_SECRET = process.env.JWT_SECRET || 'test_secret_for_tests';
const REAL_DATE = Date;

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

function freezeDate(isoTimestamp: string) {
  const frozenTime = new REAL_DATE(isoTimestamp).getTime();

  class FrozenDate extends REAL_DATE {
    constructor(
      ...args:
        | []
        | [string | number | Date]
        | [number, number, number, number?, number?, number?, number?]
    ) {
      if (args.length === 0) {
        super(frozenTime);
        return;
      }

      if (args.length === 1) {
        super(args[0]);
        return;
      }

      const [year, month, date, hours, minutes, seconds, ms] = args;
      super(year, month, date, hours, minutes, seconds, ms);
    }

    static now(): number {
      return frozenTime;
    }
  }

  globalThis.Date = FrozenDate as DateConstructor;

  return () => {
    globalThis.Date = REAL_DATE;
  };
}

test('GET /admin/stats/weekly returns weekly series from one RPC call', { concurrency: false }, async (t) => {
  const restoreDate = freezeDate('2026-05-18T10:00:00.000+08:00');
  const app = Fastify();
  app.setErrorHandler(errorHandler);

  const rpcCalls: Array<{ functionName: string; args: Record<string, unknown> | undefined }> = [];
  const services: AdminRouteServices = {
    getSupabaseClient: () =>
      ({
        from() {
          throw new Error('Unexpected table query in weekly stats route');
        },
        async rpc(functionName: string, args?: Record<string, unknown>) {
          rpcCalls.push({ functionName, args });

          return {
            data: [
              {
                week_start: '2026-03-01',
                missing_count: 1,
                found_count: 0,
                reports_count: 0,
                pending_count: 2,
              },
              {
                week_start: '2026-03-08',
                missing_count: 0,
                found_count: 1,
                reports_count: 1,
                pending_count: 0,
              },
              {
                week_start: '2026-03-15',
                missing_count: 2,
                found_count: 0,
                reports_count: 0,
                pending_count: 1,
              },
              {
                week_start: '2026-03-22',
                missing_count: 0,
                found_count: 2,
                reports_count: 0,
                pending_count: 0,
              },
              {
                week_start: '2026-03-29',
                missing_count: 1,
                found_count: 0,
                reports_count: 2,
                pending_count: 4,
              },
              {
                week_start: '2026-04-12',
                missing_count: 4,
                found_count: 2,
                reports_count: 1,
                pending_count: 3,
              },
              {
                week_start: '2026-04-19',
                missing_count: 0,
                found_count: 1,
                reports_count: 0,
                pending_count: 0,
              },
              {
                week_start: '2026-04-26',
                missing_count: 2,
                found_count: 0,
                reports_count: 0,
                pending_count: 1,
              },
              {
                week_start: '2026-05-03',
                missing_count: 0,
                found_count: 3,
                reports_count: 2,
                pending_count: 0,
              },
              {
                week_start: '2026-05-10',
                missing_count: 1,
                found_count: 1,
                reports_count: 0,
                pending_count: 2,
              },
              {
                week_start: '2026-05-17',
                missing_count: 0,
                found_count: 0,
                reports_count: 0,
                pending_count: 0,
              },
            ],
            error: null,
          };
        },
      }) as never,
  };

  await app.register(adminRoutes, {
    prefix: '/admin',
    services,
  });

  setAuthSupabaseClientFactoryForTests(() =>
    createAuthoritativeAuthSupabase('Admin', 'admin-1@umak.edu.ph')
  );

  t.after(async () => {
    restoreDate();
    setAuthSupabaseClientFactoryForTests(null);
    await app.close();
  });

  const response = await app.inject({
    method: 'GET',
    url: '/admin/stats/weekly',
    headers: {
      authorization: `Bearer ${createToken('Admin')}`,
    },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), {
    weeks: [
      'Mar 1',
      'Mar 8',
      'Mar 15',
      'Mar 22',
      'Mar 29',
      'Apr 5',
      'Apr 12',
      'Apr 19',
      'Apr 26',
      'May 3',
      'May 10',
      'May 17',
    ],
    series: {
      missing: [1, 0, 2, 0, 1, 0, 4, 0, 2, 0, 1, 0],
      found: [0, 1, 0, 2, 0, 0, 2, 1, 0, 3, 1, 0],
      reports: [0, 1, 0, 0, 2, 0, 1, 0, 0, 2, 0, 0],
      pending: [2, 0, 1, 0, 4, 0, 3, 0, 1, 0, 2, 0],
    },
  });
  assert.equal(rpcCalls.length, 1);
  assert.deepEqual(rpcCalls[0], {
    functionName: 'get_admin_weekly_stats',
    args: undefined,
  });
});
