import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import jwt from 'jsonwebtoken';
import guardRoutes, { GuardRouteServices } from '../routes/guard.js';
import { setAuthSupabaseClientFactoryForTests } from '../middleware/auth.js';
import { GuardDecisionInput, GuardScanInput } from '../services/custody.js';
import { GuardDecisionRequest, GuardScanRequest } from '../types/custody.js';
import { UserType } from '../types/auth.js';

const JWT_SECRET = process.env.JWT_SECRET || 'test_secret_for_tests';

const completeScanPayload: GuardScanRequest = {
  qr_code_session_id: 'session-1',
  session_token: 'live-qr-session-token',
};

const completeDecisionPayload: GuardDecisionRequest = {
  qr_code_session_id: 'session-1',
  decision: 'accepted',
  decision_reason: 'Validated handover',
};

function createToken(userType: UserType, userId = 'guard-1', email = 'guard-1@umak.edu.ph'): string {
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

function createGuardAuthSupabase(userType: UserType, email: string) {
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

function createGuardServices(): GuardRouteServices {
  return {
    scanCustodySession: async () => ({
      qr_code_session_id: 'session-1',
      custody_attempt_id: 'attempt-1',
      post_id: 42,
      item_id: 'item-1',
      item_name: 'Wallet',
      item_description: 'Black wallet',
      item_image_url: 'https://example.com/item.webp',
      handover_image_url: 'https://example.com/handover.webp',
      category: 'Accessories',
      last_seen_at: '2026-05-14T09:30:00.000Z',
      last_seen_location: 'Main Building > Lobby',
      submission_date: '2026-05-14T09:00:00.000Z',
      guard_post_id: 'guard-post-1',
      guard_post_name: 'Main Gate',
      attempt_number: 1,
      custody_status: 'handover_in_progress',
      qr_status: 'active',
      attempt_status: 'open',
    }),
    decideCustodyAttempt: async () => ({
      custody_attempt_id: 'attempt-1',
      qr_code_session_id: 'session-1',
      attempt_status: 'accepted',
      qr_status: 'accepted',
      custody_status: 'with_guard',
      decision_at: '2026-05-14T10:00:00.000Z',
    }),
  };
}

for (const missingField of ['qr_code_session_id', 'session_token'] as const) {
  test(`POST /guard/custody/scan missing ${missingField} returns 400`, async () => {
    const app = Fastify();
    await app.register(guardRoutes, { prefix: '/guard' });

    const payload = { ...completeScanPayload } as Record<string, unknown>;
    delete payload[missingField];

    const res = await app.inject({
      method: 'POST',
      url: '/guard/custody/scan',
      payload,
    });

    assert.equal(res.statusCode, 400);
    await app.close();
  });
}

for (const missingField of ['qr_code_session_id', 'decision'] as const) {
  test(`POST /guard/custody/attempts/:id/decision missing ${missingField} returns 400`, async () => {
    const app = Fastify();
    await app.register(guardRoutes, { prefix: '/guard' });

    const payload = { ...completeDecisionPayload } as Record<string, unknown>;
    delete payload[missingField];

    const res = await app.inject({
      method: 'POST',
      url: '/guard/custody/attempts/attempt-1/decision',
      payload,
    });

    assert.equal(res.statusCode, 400);
    await app.close();
  });
}

test('POST /guard/custody/scan without auth returns 401', async () => {
  const app = Fastify();
  await app.register(guardRoutes, { prefix: '/guard' });

  const res = await app.inject({
    method: 'POST',
    url: '/guard/custody/scan',
    payload: completeScanPayload,
  });

  assert.equal(res.statusCode, 401);
  await app.close();
});

test('POST /guard/custody/scan with malformed header returns 401', async () => {
  const app = Fastify();
  await app.register(guardRoutes, { prefix: '/guard' });

  const res = await app.inject({
    method: 'POST',
    url: '/guard/custody/scan',
    headers: {
      authorization: 'Token malformed',
    },
    payload: completeScanPayload,
  });

  assert.equal(res.statusCode, 401);
  await app.close();
});

test('POST /guard/custody/scan rejects staff access with 403', { concurrency: false }, async (t) => {
  const app = Fastify();
  await app.register(guardRoutes, { prefix: '/guard' });

  setAuthSupabaseClientFactoryForTests(() =>
    createGuardAuthSupabase('Staff', 'staff-1@umak.edu.ph')
  );
  t.after(() => setAuthSupabaseClientFactoryForTests(null));

  const res = await app.inject({
    method: 'POST',
    url: '/guard/custody/scan',
    headers: {
      authorization: `Bearer ${createToken('Staff', 'staff-1', 'staff-1@umak.edu.ph')}`,
    },
    payload: completeScanPayload,
  });

  assert.equal(res.statusCode, 403);
  await app.close();
});

test('POST /guard/custody/scan passes the authenticated guard to the service', { concurrency: false }, async (t) => {
  const app = Fastify();
  let capturedInput: GuardScanInput | null = null;
  const services: GuardRouteServices = {
    ...createGuardServices(),
    scanCustodySession: async (input) => {
      capturedInput = input;
      return {
        qr_code_session_id: 'session-1',
        custody_attempt_id: 'attempt-1',
        post_id: 42,
        item_id: 'item-1',
        item_name: 'Wallet',
        item_description: 'Black wallet',
        item_image_url: 'https://example.com/item.webp',
        handover_image_url: 'https://example.com/handover.webp',
        category: 'Accessories',
        last_seen_at: '2026-05-14T09:30:00.000Z',
        last_seen_location: 'Main Building > Lobby',
        submission_date: '2026-05-14T09:00:00.000Z',
        guard_post_id: 'guard-post-1',
        guard_post_name: 'Main Gate',
        attempt_number: 1,
        custody_status: 'handover_in_progress',
        qr_status: 'active',
        attempt_status: 'open',
      };
    },
  };

  await app.register(guardRoutes, {
    prefix: '/guard',
    services,
  });

  setAuthSupabaseClientFactoryForTests(() =>
    createGuardAuthSupabase('Guard', 'guard-123@umak.edu.ph')
  );
  t.after(() => setAuthSupabaseClientFactoryForTests(null));

  const res = await app.inject({
    method: 'POST',
    url: '/guard/custody/scan',
    headers: {
      authorization: `Bearer ${createToken('Guard', 'guard-123', 'guard-123@umak.edu.ph')}`,
    },
    payload: completeScanPayload,
  });

  assert.equal(res.statusCode, 200);
  assert.ok(capturedInput);
  const captured = capturedInput as GuardScanInput;

  assert.equal(captured.qr_code_session_id, completeScanPayload.qr_code_session_id);
  assert.equal(captured.session_token, completeScanPayload.session_token);
  assert.equal(captured.actor.user_id, 'guard-123');
  assert.equal(captured.actor.user_type, 'Guard');
  assert.equal(captured.actor.email, 'guard-123@umak.edu.ph');

  await app.close();
});

test('POST /guard/custody/attempts/:id/decision without auth returns 401', async () => {
  const app = Fastify();
  await app.register(guardRoutes, { prefix: '/guard' });

  const res = await app.inject({
    method: 'POST',
    url: '/guard/custody/attempts/attempt-1/decision',
    payload: completeDecisionPayload,
  });

  assert.equal(res.statusCode, 401);
  await app.close();
});

test('POST /guard/custody/attempts/:id/decision with malformed header returns 401', async () => {
  const app = Fastify();
  await app.register(guardRoutes, { prefix: '/guard' });

  const res = await app.inject({
    method: 'POST',
    url: '/guard/custody/attempts/attempt-1/decision',
    headers: {
      authorization: 'Token malformed',
    },
    payload: completeDecisionPayload,
  });

  assert.equal(res.statusCode, 401);
  await app.close();
});

test('POST /guard/custody/attempts/:id/decision rejects staff access with 403', { concurrency: false }, async (t) => {
  const app = Fastify();
  await app.register(guardRoutes, { prefix: '/guard' });

  setAuthSupabaseClientFactoryForTests(() =>
    createGuardAuthSupabase('Staff', 'staff-1@umak.edu.ph')
  );
  t.after(() => setAuthSupabaseClientFactoryForTests(null));

  const res = await app.inject({
    method: 'POST',
    url: '/guard/custody/attempts/attempt-1/decision',
    headers: {
      authorization: `Bearer ${createToken('Staff', 'staff-1', 'staff-1@umak.edu.ph')}`,
    },
    payload: completeDecisionPayload,
  });

  assert.equal(res.statusCode, 403);
  await app.close();
});

test('POST /guard/custody/attempts/:id/decision passes the guard actor and path id to the service', { concurrency: false }, async (t) => {
  const app = Fastify();
  let capturedInput: GuardDecisionInput | null = null;
  const services: GuardRouteServices = {
    ...createGuardServices(),
    decideCustodyAttempt: async (input) => {
      capturedInput = input;
      return {
        custody_attempt_id: 'attempt-1',
        qr_code_session_id: 'session-1',
        attempt_status: 'accepted',
        qr_status: 'accepted',
        custody_status: 'with_guard',
        decision_at: '2026-05-14T10:00:00.000Z',
      };
    },
  };

  await app.register(guardRoutes, {
    prefix: '/guard',
    services,
  });

  setAuthSupabaseClientFactoryForTests(() =>
    createGuardAuthSupabase('Guard', 'guard-123@umak.edu.ph')
  );
  t.after(() => setAuthSupabaseClientFactoryForTests(null));

  const res = await app.inject({
    method: 'POST',
    url: '/guard/custody/attempts/attempt-1/decision',
    headers: {
      authorization: `Bearer ${createToken('Guard', 'guard-123', 'guard-123@umak.edu.ph')}`,
    },
    payload: completeDecisionPayload,
  });

  assert.equal(res.statusCode, 200);
  assert.ok(capturedInput);
  const captured = capturedInput as GuardDecisionInput;

  assert.equal(captured.custody_attempt_id, 'attempt-1');
  assert.equal(captured.qr_code_session_id, completeDecisionPayload.qr_code_session_id);
  assert.equal(captured.decision, completeDecisionPayload.decision);
  assert.equal(captured.decision_reason, completeDecisionPayload.decision_reason);
  assert.equal(captured.actor.user_id, 'guard-123');
  assert.equal(captured.actor.user_type, 'Guard');
  assert.equal(captured.actor.email, 'guard-123@umak.edu.ph');

  await app.close();
});
