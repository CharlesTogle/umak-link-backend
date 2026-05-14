import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import custodyJobsRoutes, { CustodyJobsRouteServices } from '../routes/custody-jobs.js';

function createCustodyJobsServices(): CustodyJobsRouteServices {
  return {
    expireCustodySessions: async () => ({
      expired_count: 2,
    }),
    escalateStaleAcceptedCustodyAttempts: async () => ({
      escalated_count: 3,
    }),
  };
}

test('POST /jobs/custody/expire-sessions without authorization header returns 400', async () => {
  const app = Fastify();
  await app.register(custodyJobsRoutes, { prefix: '/jobs/custody' });

  const res = await app.inject({
    method: 'POST',
    url: '/jobs/custody/expire-sessions',
  });

  assert.equal(res.statusCode, 400);
  await app.close();
});

test('POST /jobs/custody/expire-sessions with malformed header returns 401', { concurrency: false }, async (t) => {
  const app = Fastify();
  await app.register(custodyJobsRoutes, { prefix: '/jobs/custody' });

  const previousSystemToken = process.env.SYSTEM_TOKEN;
  process.env.SYSTEM_TOKEN = 'system-token-1';
  t.after(() => {
    process.env.SYSTEM_TOKEN = previousSystemToken;
  });

  const res = await app.inject({
    method: 'POST',
    url: '/jobs/custody/expire-sessions',
    headers: {
      authorization: 'Token malformed',
    },
  });

  assert.equal(res.statusCode, 401);
  await app.close();
});

test('POST /jobs/custody/expire-sessions with wrong token returns 401', { concurrency: false }, async (t) => {
  const app = Fastify();
  await app.register(custodyJobsRoutes, { prefix: '/jobs/custody' });

  const previousSystemToken = process.env.SYSTEM_TOKEN;
  process.env.SYSTEM_TOKEN = 'system-token-1';
  t.after(() => {
    process.env.SYSTEM_TOKEN = previousSystemToken;
  });

  const res = await app.inject({
    method: 'POST',
    url: '/jobs/custody/expire-sessions',
    headers: {
      authorization: 'Bearer wrong-token',
    },
  });

  assert.equal(res.statusCode, 401);
  await app.close();
});

test('POST /jobs/custody/expire-sessions accepts the configured system token', { concurrency: false }, async (t) => {
  const app = Fastify();
  await app.register(custodyJobsRoutes, {
    prefix: '/jobs/custody',
    services: createCustodyJobsServices(),
  });

  const previousSystemToken = process.env.SYSTEM_TOKEN;
  process.env.SYSTEM_TOKEN = 'system-token-1';
  t.after(() => {
    process.env.SYSTEM_TOKEN = previousSystemToken;
  });

  const res = await app.inject({
    method: 'POST',
    url: '/jobs/custody/expire-sessions',
    headers: {
      authorization: 'Bearer system-token-1',
    },
  });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), {
    expired_count: 2,
  });

  await app.close();
});

test('POST /jobs/custody/escalate-stale-accepted without authorization header returns 400', async () => {
  const app = Fastify();
  await app.register(custodyJobsRoutes, { prefix: '/jobs/custody' });

  const res = await app.inject({
    method: 'POST',
    url: '/jobs/custody/escalate-stale-accepted',
  });

  assert.equal(res.statusCode, 400);
  await app.close();
});

test('POST /jobs/custody/escalate-stale-accepted with malformed header returns 401', { concurrency: false }, async (t) => {
  const app = Fastify();
  await app.register(custodyJobsRoutes, { prefix: '/jobs/custody' });

  const previousSystemToken = process.env.SYSTEM_TOKEN;
  process.env.SYSTEM_TOKEN = 'system-token-1';
  t.after(() => {
    process.env.SYSTEM_TOKEN = previousSystemToken;
  });

  const res = await app.inject({
    method: 'POST',
    url: '/jobs/custody/escalate-stale-accepted',
    headers: {
      authorization: 'Token malformed',
    },
  });

  assert.equal(res.statusCode, 401);
  await app.close();
});

test('POST /jobs/custody/escalate-stale-accepted with wrong token returns 401', { concurrency: false }, async (t) => {
  const app = Fastify();
  await app.register(custodyJobsRoutes, { prefix: '/jobs/custody' });

  const previousSystemToken = process.env.SYSTEM_TOKEN;
  process.env.SYSTEM_TOKEN = 'system-token-1';
  t.after(() => {
    process.env.SYSTEM_TOKEN = previousSystemToken;
  });

  const res = await app.inject({
    method: 'POST',
    url: '/jobs/custody/escalate-stale-accepted',
    headers: {
      authorization: 'Bearer wrong-token',
    },
  });

  assert.equal(res.statusCode, 401);
  await app.close();
});

test('POST /jobs/custody/escalate-stale-accepted accepts the configured system token', { concurrency: false }, async (t) => {
  const app = Fastify();
  await app.register(custodyJobsRoutes, {
    prefix: '/jobs/custody',
    services: createCustodyJobsServices(),
  });

  const previousSystemToken = process.env.SYSTEM_TOKEN;
  process.env.SYSTEM_TOKEN = 'system-token-1';
  t.after(() => {
    process.env.SYSTEM_TOKEN = previousSystemToken;
  });

  const res = await app.inject({
    method: 'POST',
    url: '/jobs/custody/escalate-stale-accepted',
    headers: {
      authorization: 'Bearer system-token-1',
    },
  });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), {
    escalated_count: 3,
  });

  await app.close();
});
