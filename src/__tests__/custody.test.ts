import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import jwt from 'jsonwebtoken';
import custodyRoutes, { CustodyRouteServices } from '../routes/custody.js';
import { CreateCustodyAttemptInput } from '../services/custody.js';
import { CreateCustodyAttemptRequest } from '../types/custody.js';
import { UserType } from '../types/auth.js';

const JWT_SECRET = process.env.JWT_SECRET || 'test_secret_for_tests';

const completeCreateAttemptPayload: CreateCustodyAttemptRequest = {
  post_id: 42,
  guard_post_id: 'guard-post-1',
  handover_image_url: 'https://example.com/handover.webp',
  handover_image_hash: 'handover-hash-1',
  session_token: 'live-qr-session-token',
};

function createToken(userType: UserType, userId = 'user-1', email = 'user-1@umak.edu.ph'): string {
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

function createCustodyServices(): CustodyRouteServices {
  return {
    listGuardPosts: async () => ({
      guard_posts: [
        {
          guard_post_id: 'guard-post-1',
          guard_post_name: 'Main Gate',
          location_id: 10,
          full_location_name: 'Main Building > Main Gate',
          is_active: true,
        },
      ],
    }),
    createCustodyAttempt: async () => ({
      custody_attempt_id: 'attempt-1',
      qr_code_session_id: 'session-1',
      attempt_status: 'open',
      qr_status: 'active',
      custody_status: 'handover_in_progress',
      expires_at: '2026-05-14T10:05:00.000Z',
    }),
    getCustodySessionStatus: async () => ({
      qr_code_session_id: 'session-1',
      custody_attempt_id: 'attempt-1',
      post_id: 42,
      item_id: 'item-1',
      qr_status: 'active',
      attempt_status: 'open',
      custody_status: 'handover_in_progress',
      expires_at: '2026-05-14T10:05:00.000Z',
      scanned_at: null,
      decision_at: null,
    }),
  };
}

for (const missingField of [
  'post_id',
  'guard_post_id',
  'handover_image_url',
  'handover_image_hash',
  'session_token',
] as const) {
  test(`POST /custody/attempts missing ${missingField} returns 400`, async () => {
    const app = Fastify();
    await app.register(custodyRoutes, { prefix: '/custody' });

    const payload = { ...completeCreateAttemptPayload } as Record<string, unknown>;
    delete payload[missingField];

    const res = await app.inject({
      method: 'POST',
      url: '/custody/attempts',
      payload,
    });

    assert.equal(res.statusCode, 400);
    await app.close();
  });
}

test('GET /custody/guard-posts without auth returns 401', async () => {
  const app = Fastify();
  await app.register(custodyRoutes, { prefix: '/custody' });

  const res = await app.inject({
    method: 'GET',
    url: '/custody/guard-posts',
  });

  assert.equal(res.statusCode, 401);
  await app.close();
});

test('GET /custody/guard-posts with malformed header returns 401', async () => {
  const app = Fastify();
  await app.register(custodyRoutes, { prefix: '/custody' });

  const res = await app.inject({
    method: 'GET',
    url: '/custody/guard-posts',
    headers: {
      authorization: 'Token not-a-bearer-token',
    },
  });

  assert.equal(res.statusCode, 401);
  await app.close();
});

test('GET /custody/guard-posts with wrong auth token returns 401', async () => {
  const app = Fastify();
  await app.register(custodyRoutes, { prefix: '/custody' });

  const res = await app.inject({
    method: 'GET',
    url: '/custody/guard-posts',
    headers: {
      authorization: 'Bearer not-a-jwt-token',
    },
  });

  assert.equal(res.statusCode, 401);
  await app.close();
});

test('GET /custody/guard-posts returns guard posts for authenticated users', async () => {
  const app = Fastify();
  await app.register(custodyRoutes, {
    prefix: '/custody',
    services: createCustodyServices(),
  });

  const res = await app.inject({
    method: 'GET',
    url: '/custody/guard-posts',
    headers: {
      authorization: `Bearer ${createToken('User')}`,
    },
  });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), {
    guard_posts: [
      {
        guard_post_id: 'guard-post-1',
        guard_post_name: 'Main Gate',
        location_id: 10,
        full_location_name: 'Main Building > Main Gate',
        is_active: true,
      },
    ],
  });

  await app.close();
});

test('POST /custody/attempts without auth returns 401', async () => {
  const app = Fastify();
  await app.register(custodyRoutes, { prefix: '/custody' });

  const res = await app.inject({
    method: 'POST',
    url: '/custody/attempts',
    payload: completeCreateAttemptPayload,
  });

  assert.equal(res.statusCode, 401);
  await app.close();
});

test('POST /custody/attempts with malformed header returns 401', async () => {
  const app = Fastify();
  await app.register(custodyRoutes, { prefix: '/custody' });

  const res = await app.inject({
    method: 'POST',
    url: '/custody/attempts',
    headers: {
      authorization: 'Token malformed',
    },
    payload: completeCreateAttemptPayload,
  });

  assert.equal(res.statusCode, 401);
  await app.close();
});

test('POST /custody/attempts with wrong auth token returns 401', async () => {
  const app = Fastify();
  await app.register(custodyRoutes, { prefix: '/custody' });

  const res = await app.inject({
    method: 'POST',
    url: '/custody/attempts',
    headers: {
      authorization: 'Bearer not-a-jwt-token',
    },
    payload: completeCreateAttemptPayload,
  });

  assert.equal(res.statusCode, 401);
  await app.close();
});

test('POST /custody/attempts passes the authenticated actor to the service', async () => {
  const app = Fastify();
  let capturedInput: CreateCustodyAttemptInput | null = null;
  const services: CustodyRouteServices = {
    ...createCustodyServices(),
    createCustodyAttempt: async (input) => {
      capturedInput = input;
      return {
        custody_attempt_id: 'attempt-1',
        qr_code_session_id: 'session-1',
        attempt_status: 'open',
        qr_status: 'active',
        custody_status: 'handover_in_progress',
        expires_at: '2026-05-14T10:05:00.000Z',
      };
    },
  };

  await app.register(custodyRoutes, {
    prefix: '/custody',
    services,
  });

  const res = await app.inject({
    method: 'POST',
    url: '/custody/attempts',
    headers: {
      authorization: `Bearer ${createToken('User', 'user-123', 'user-123@umak.edu.ph')}`,
    },
    payload: completeCreateAttemptPayload,
  });

  assert.equal(res.statusCode, 200);
  assert.ok(capturedInput);
  const captured = capturedInput as CreateCustodyAttemptInput;

  assert.equal(captured.post_id, completeCreateAttemptPayload.post_id);
  assert.equal(captured.guard_post_id, completeCreateAttemptPayload.guard_post_id);
  assert.equal(captured.handover_image_url, completeCreateAttemptPayload.handover_image_url);
  assert.equal(captured.handover_image_hash, completeCreateAttemptPayload.handover_image_hash);
  assert.equal(captured.session_token, completeCreateAttemptPayload.session_token);
  assert.equal(captured.actor.user_id, 'user-123');
  assert.equal(captured.actor.email, 'user-123@umak.edu.ph');
  assert.equal(captured.actor.user_type, 'User');

  await app.close();
});

test('GET /custody/sessions/:qrCodeSessionId/status without auth returns 401', async () => {
  const app = Fastify();
  await app.register(custodyRoutes, { prefix: '/custody' });

  const res = await app.inject({
    method: 'GET',
    url: '/custody/sessions/session-1/status',
  });

  assert.equal(res.statusCode, 401);
  await app.close();
});

test('GET /custody/sessions/:qrCodeSessionId/status with malformed header returns 401', async () => {
  const app = Fastify();
  await app.register(custodyRoutes, { prefix: '/custody' });

  const res = await app.inject({
    method: 'GET',
    url: '/custody/sessions/session-1/status',
    headers: {
      authorization: 'Token malformed',
    },
  });

  assert.equal(res.statusCode, 401);
  await app.close();
});

test('GET /custody/sessions/:qrCodeSessionId/status with wrong auth token returns 401', async () => {
  const app = Fastify();
  await app.register(custodyRoutes, { prefix: '/custody' });

  const res = await app.inject({
    method: 'GET',
    url: '/custody/sessions/session-1/status',
    headers: {
      authorization: 'Bearer invalid-jwt-token',
    },
  });

  assert.equal(res.statusCode, 401);
  await app.close();
});

test('GET /custody/sessions/:qrCodeSessionId/status returns the service response', async () => {
  const app = Fastify();
  await app.register(custodyRoutes, {
    prefix: '/custody',
    services: createCustodyServices(),
  });

  const res = await app.inject({
    method: 'GET',
    url: '/custody/sessions/session-1/status',
    headers: {
      authorization: `Bearer ${createToken('User')}`,
    },
  });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), {
    qr_code_session_id: 'session-1',
    custody_attempt_id: 'attempt-1',
    post_id: 42,
    item_id: 'item-1',
    qr_status: 'active',
    attempt_status: 'open',
    custody_status: 'handover_in_progress',
    expires_at: '2026-05-14T10:05:00.000Z',
    scanned_at: null,
    decision_at: null,
  });

  await app.close();
});
