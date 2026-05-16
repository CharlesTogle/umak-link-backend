import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendEmail, setResendClientFactoryForTests } from '../services/email.js';

test('sendEmail calls resend.emails.send with the fraud report email payload when configured', async (t) => {
  const originalApiKey = process.env.RESEND_API_KEY;
  const originalFromEmail = process.env.RESEND_FROM_EMAIL;
  let capturedPayload: {
    from: string;
    to: string[];
    subject: string;
    html: string;
  } | null = null;

  process.env.RESEND_API_KEY = 'resend_test_key';
  process.env.RESEND_FROM_EMAIL = 'UMak-LINK <noreply@umaklink.com>';
  setResendClientFactoryForTests(() => ({
    emails: {
      send: async (payload) => {
        capturedPayload = payload;
        return {
          data: {
            id: 'email_test_123',
          },
          error: null,
        };
      },
    },
  }));

  t.after(() => {
    setResendClientFactoryForTests(null);

    if (originalApiKey === undefined) {
      delete process.env.RESEND_API_KEY;
    } else {
      process.env.RESEND_API_KEY = originalApiKey;
    }

    if (originalFromEmail === undefined) {
      delete process.env.RESEND_FROM_EMAIL;
    } else {
      process.env.RESEND_FROM_EMAIL = originalFromEmail;
    }
  });

  const result = await sendEmail({
    to: 'claimer@umak.edu.ph',
    subject: 'URGENT: Claim Verification Required - Black Wallet',
    html: '<p>Claim verification required.</p>',
    senderUuid: 'staff-1',
  });

  assert.deepEqual(capturedPayload, {
    from: 'UMak-LINK <noreply@umaklink.com>',
    to: ['claimer@umak.edu.ph'],
    subject: 'URGENT: Claim Verification Required - Black Wallet',
    html: '<p>Claim verification required.</p>',
  });
  assert.deepEqual(result, {
    success: true,
    message: 'Email sent successfully',
    to: 'claimer@umak.edu.ph',
  });
});
