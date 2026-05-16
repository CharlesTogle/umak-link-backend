import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import jwt from 'jsonwebtoken';
import emailRoutes from '../routes/email.js';
import { setAuthSupabaseClientFactoryForTests } from '../middleware/auth.js';
import type { SendEmailPayload } from '../services/email.js';

const JWT_SECRET = process.env.JWT_SECRET || 'test_secret_for_tests';

function createToken(userId = 'staff-1', userType: 'Staff' | 'Admin' = 'Staff'): string {
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

function createAuthoritativeAuthSupabase(userType: 'Staff' | 'Admin', email: string) {
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

test('POST /email/send dispatches the email payload for staff-authenticated requests', async (t) => {
  let capturedPayload: Record<string, unknown> | null = null;

  setAuthSupabaseClientFactoryForTests(() =>
    createAuthoritativeAuthSupabase('Staff', 'staff-1@umak.edu.ph')
  );
  t.after(() => setAuthSupabaseClientFactoryForTests(null));

  const app = Fastify();
  await app.register(emailRoutes, {
    prefix: '/email',
    services: {
      sendEmail: async (payload: SendEmailPayload) => {
        capturedPayload = {
          to: payload.to,
          subject: payload.subject,
          html: payload.html,
          senderUuid: payload.senderUuid,
          from: payload.from,
        };
        return {
          success: true,
          message: 'Email sent successfully',
          to: payload.to,
        };
      },
    },
  });

  const res = await app.inject({
    method: 'POST',
    url: '/email/send',
    headers: {
      authorization: `Bearer ${createToken()}`,
    },
    payload: {
      to: 'claimer@umak.edu.ph',
      subject: 'Fraud Report Opened - Black Wallet',
      html: '<p>Test email body</p>',
      senderUuid: 'staff-1',
    },
  });

  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json(), {
    success: true,
    message: 'Email sent successfully',
    to: 'claimer@umak.edu.ph',
  });
  assert.deepEqual(capturedPayload, {
    to: 'claimer@umak.edu.ph',
    subject: 'Fraud Report Opened - Black Wallet',
    html: '<p>Test email body</p>',
    senderUuid: 'staff-1',
    from: undefined,
  });

  await app.close();
});
