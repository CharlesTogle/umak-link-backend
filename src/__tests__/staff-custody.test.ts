import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import jwt from 'jsonwebtoken';
import staffCustodyRoutes, { StaffCustodyRouteServices } from '../routes/staff-custody.js';
import { setAuthSupabaseClientFactoryForTests } from '../middleware/auth.js';
import {
  NotifyGuardInput,
  OpenCustodyInvestigationInput,
  ReportPhysicalTakeInput,
  SecurityOfficeReceiptInput,
} from '../services/custody.js';
import {
  NotifyGuardRequest,
  PhysicalTakeReportRequest,
  StaffCustodyPostRequest,
} from '../types/custody.js';
import { UserType } from '../types/auth.js';

const JWT_SECRET = process.env.JWT_SECRET || 'test_secret_for_tests';

const completePostPayload: StaffCustodyPostRequest = {
  post_id: 42,
};

const completePhysicalTakePayload: PhysicalTakeReportRequest = {
  post_id: 42,
  guard_id: 'guard-1',
};

const completeNotifyGuardPayload: NotifyGuardRequest = {
  post_id: 42,
};

function createToken(userType: UserType, userId = 'staff-1', email = 'staff-1@umak.edu.ph'): string {
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

function createStaffAuthSupabase(userType: UserType, email: string) {
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

function createStaffCustodyServices(): StaffCustodyRouteServices {
  return {
    markPostReceivedInSecurityOffice: async () => ({
      post_id: 42,
      custody_attempt_id: 'attempt-1',
      custody_status: 'in_security_office',
      office_received_at: '2026-05-14T11:00:00.000Z',
    }),
    openCustodyInvestigation: async () => ({
      post_id: 42,
      custody_attempt_id: 'attempt-1',
      custody_status: 'under_investigation',
      investigation_opened_at: '2026-05-14T11:05:00.000Z',
    }),
    reportPhysicalTake: async () => ({
      post_id: 42,
      custody_attempt_id: 'attempt-1',
      guard_id: 'guard-1',
      custody_status: 'under_investigation',
      reported_at: '2026-05-14T11:10:00.000Z',
    }),
    notifyGuardForCustodyFollowUp: async () => ({
      post_id: 42,
      custody_attempt_id: 'attempt-1',
      guard_id: 'guard-1',
      notification_id: 'notification-1',
      notification_status: 'created',
      requested_at: '2026-05-14T11:15:00.000Z',
    }),
  };
}

for (const url of [
  '/staff/custody/security-office/receive',
  '/staff/custody/investigations/open',
  '/staff/custody/guards/notify',
] as const) {
  test(`POST ${url} missing post_id returns 400`, async () => {
    const app = Fastify();
    await app.register(staffCustodyRoutes, { prefix: '/staff' });

    const res = await app.inject({
      method: 'POST',
      url,
      payload: {},
    });

    assert.equal(res.statusCode, 400);
    await app.close();
  });

  test(`POST ${url} without auth returns 401`, async () => {
    const app = Fastify();
    await app.register(staffCustodyRoutes, { prefix: '/staff' });

    const res = await app.inject({
      method: 'POST',
      url,
      payload: completePostPayload,
    });

    assert.equal(res.statusCode, 401);
    await app.close();
  });

  test(`POST ${url} with malformed header returns 401`, async () => {
    const app = Fastify();
    await app.register(staffCustodyRoutes, { prefix: '/staff' });

    const res = await app.inject({
      method: 'POST',
      url,
      headers: {
        authorization: 'Token malformed',
      },
      payload: completePostPayload,
    });

    assert.equal(res.statusCode, 401);
    await app.close();
  });

  test(`POST ${url} with wrong auth token returns 401`, async () => {
    const app = Fastify();
    await app.register(staffCustodyRoutes, { prefix: '/staff' });

    const res = await app.inject({
      method: 'POST',
      url,
      headers: {
        authorization: 'Bearer not-a-jwt-token',
      },
      payload: completePostPayload,
    });

    assert.equal(res.statusCode, 401);
    await app.close();
  });
}

for (const missingField of ['post_id', 'guard_id'] as const) {
  test(`POST /staff/custody/physical-takes/report missing ${missingField} returns 400`, async () => {
    const app = Fastify();
    await app.register(staffCustodyRoutes, { prefix: '/staff' });

    const payload = { ...completePhysicalTakePayload } as Record<string, unknown>;
    delete payload[missingField];

    const res = await app.inject({
      method: 'POST',
      url: '/staff/custody/physical-takes/report',
      payload,
    });

    assert.equal(res.statusCode, 400);
    await app.close();
  });
}

for (const authCase of [
  {
    name: 'without auth',
    headers: undefined,
    expectedStatus: 401,
  },
  {
    name: 'with malformed header',
    headers: {
      authorization: 'Token malformed',
    },
    expectedStatus: 401,
  },
  {
    name: 'with wrong auth token',
    headers: {
      authorization: 'Bearer not-a-jwt-token',
    },
    expectedStatus: 401,
  },
] as const) {
  test(`POST /staff/custody/physical-takes/report ${authCase.name} returns ${authCase.expectedStatus}`, async () => {
    const app = Fastify();
    await app.register(staffCustodyRoutes, { prefix: '/staff' });

    const res = await app.inject({
      method: 'POST',
      url: '/staff/custody/physical-takes/report',
      headers: authCase.headers,
      payload: completePhysicalTakePayload,
    });

    assert.equal(res.statusCode, authCase.expectedStatus);
    await app.close();
  });
}

for (const config of [
  {
    url: '/staff/custody/security-office/receive',
    payload: completePostPayload,
  },
  {
    url: '/staff/custody/investigations/open',
    payload: completePostPayload,
  },
  {
    url: '/staff/custody/physical-takes/report',
    payload: completePhysicalTakePayload,
  },
  {
    url: '/staff/custody/guards/notify',
    payload: completeNotifyGuardPayload,
  },
] as const) {
  test(`POST ${config.url} rejects admin access with 403`, { concurrency: false }, async (t) => {
    const app = Fastify();
    await app.register(staffCustodyRoutes, { prefix: '/staff' });

    setAuthSupabaseClientFactoryForTests(() =>
      createStaffAuthSupabase('Admin', 'admin-1@umak.edu.ph')
    );
    t.after(() => setAuthSupabaseClientFactoryForTests(null));

    const res = await app.inject({
      method: 'POST',
      url: config.url,
      headers: {
        authorization: `Bearer ${createToken('Admin', 'admin-1', 'admin-1@umak.edu.ph')}`,
      },
      payload: config.payload,
    });

    assert.equal(res.statusCode, 403);
    await app.close();
  });
}

test('POST /staff/custody/security-office/receive passes the authenticated staff to the service', { concurrency: false }, async (t) => {
  const app = Fastify();
  let capturedInput: SecurityOfficeReceiptInput | null = null;
  const services: StaffCustodyRouteServices = {
    ...createStaffCustodyServices(),
    markPostReceivedInSecurityOffice: async (input) => {
      capturedInput = input;
      return {
        post_id: 42,
        custody_attempt_id: 'attempt-1',
        custody_status: 'in_security_office',
        office_received_at: '2026-05-14T11:00:00.000Z',
      };
    },
  };

  await app.register(staffCustodyRoutes, {
    prefix: '/staff',
    services,
  });

  setAuthSupabaseClientFactoryForTests(() =>
    createStaffAuthSupabase('Staff', 'staff-123@umak.edu.ph')
  );
  t.after(() => setAuthSupabaseClientFactoryForTests(null));

  const res = await app.inject({
    method: 'POST',
    url: '/staff/custody/security-office/receive',
    headers: {
      authorization: `Bearer ${createToken('Staff', 'staff-123', 'staff-123@umak.edu.ph')}`,
    },
    payload: completePostPayload,
  });

  assert.equal(res.statusCode, 200);
  assert.ok(capturedInput);
  const captured = capturedInput as SecurityOfficeReceiptInput;
  assert.equal(captured.post_id, completePostPayload.post_id);
  assert.equal(captured.actor.user_id, 'staff-123');
  assert.equal(captured.actor.user_type, 'Staff');
  assert.equal(captured.actor.email, 'staff-123@umak.edu.ph');

  await app.close();
});

test('POST /staff/custody/investigations/open passes the authenticated staff to the service', { concurrency: false }, async (t) => {
  const app = Fastify();
  let capturedInput: OpenCustodyInvestigationInput | null = null;
  const services: StaffCustodyRouteServices = {
    ...createStaffCustodyServices(),
    openCustodyInvestigation: async (input) => {
      capturedInput = input;
      return {
        post_id: 42,
        custody_attempt_id: 'attempt-1',
        custody_status: 'under_investigation',
        investigation_opened_at: '2026-05-14T11:05:00.000Z',
      };
    },
  };

  await app.register(staffCustodyRoutes, {
    prefix: '/staff',
    services,
  });

  setAuthSupabaseClientFactoryForTests(() =>
    createStaffAuthSupabase('Staff', 'staff-123@umak.edu.ph')
  );
  t.after(() => setAuthSupabaseClientFactoryForTests(null));

  const res = await app.inject({
    method: 'POST',
    url: '/staff/custody/investigations/open',
    headers: {
      authorization: `Bearer ${createToken('Staff', 'staff-123', 'staff-123@umak.edu.ph')}`,
    },
    payload: completePostPayload,
  });

  assert.equal(res.statusCode, 200);
  assert.ok(capturedInput);
  const captured = capturedInput as OpenCustodyInvestigationInput;
  assert.equal(captured.post_id, completePostPayload.post_id);
  assert.equal(captured.actor.user_id, 'staff-123');
  assert.equal(captured.actor.user_type, 'Staff');
  assert.equal(captured.actor.email, 'staff-123@umak.edu.ph');

  await app.close();
});

test('POST /staff/custody/physical-takes/report passes the authenticated staff to the service', { concurrency: false }, async (t) => {
  const app = Fastify();
  let capturedInput: ReportPhysicalTakeInput | null = null;
  const services: StaffCustodyRouteServices = {
    ...createStaffCustodyServices(),
    reportPhysicalTake: async (input) => {
      capturedInput = input;
      return {
        post_id: 42,
        custody_attempt_id: 'attempt-1',
        guard_id: 'guard-1',
        custody_status: 'under_investigation',
        reported_at: '2026-05-14T11:10:00.000Z',
      };
    },
  };

  await app.register(staffCustodyRoutes, {
    prefix: '/staff',
    services,
  });

  setAuthSupabaseClientFactoryForTests(() =>
    createStaffAuthSupabase('Staff', 'staff-123@umak.edu.ph')
  );
  t.after(() => setAuthSupabaseClientFactoryForTests(null));

  const res = await app.inject({
    method: 'POST',
    url: '/staff/custody/physical-takes/report',
    headers: {
      authorization: `Bearer ${createToken('Staff', 'staff-123', 'staff-123@umak.edu.ph')}`,
    },
    payload: completePhysicalTakePayload,
  });

  assert.equal(res.statusCode, 200);
  assert.ok(capturedInput);
  const captured = capturedInput as ReportPhysicalTakeInput;
  assert.equal(captured.post_id, completePhysicalTakePayload.post_id);
  assert.equal(captured.guard_id, completePhysicalTakePayload.guard_id);
  assert.equal(captured.actor.user_id, 'staff-123');
  assert.equal(captured.actor.user_type, 'Staff');
  assert.equal(captured.actor.email, 'staff-123@umak.edu.ph');

  await app.close();
});

test('POST /staff/custody/guards/notify passes the authenticated staff to the service', { concurrency: false }, async (t) => {
  const app = Fastify();
  let capturedInput: NotifyGuardInput | null = null;
  const services: StaffCustodyRouteServices = {
    ...createStaffCustodyServices(),
    notifyGuardForCustodyFollowUp: async (input) => {
      capturedInput = input;
      return {
        post_id: 42,
        custody_attempt_id: 'attempt-1',
        guard_id: 'guard-1',
        notification_id: 'notification-1',
        notification_status: 'created',
        requested_at: '2026-05-14T11:15:00.000Z',
      };
    },
  };

  await app.register(staffCustodyRoutes, {
    prefix: '/staff',
    services,
  });

  setAuthSupabaseClientFactoryForTests(() =>
    createStaffAuthSupabase('Staff', 'staff-123@umak.edu.ph')
  );
  t.after(() => setAuthSupabaseClientFactoryForTests(null));

  const res = await app.inject({
    method: 'POST',
    url: '/staff/custody/guards/notify',
    headers: {
      authorization: `Bearer ${createToken('Staff', 'staff-123', 'staff-123@umak.edu.ph')}`,
    },
    payload: completeNotifyGuardPayload,
  });

  assert.equal(res.statusCode, 200);
  assert.ok(capturedInput);
  const captured = capturedInput as NotifyGuardInput;
  assert.equal(captured.post_id, completeNotifyGuardPayload.post_id);
  assert.equal(captured.actor.user_id, 'staff-123');
  assert.equal(captured.actor.user_type, 'Staff');
  assert.equal(captured.actor.email, 'staff-123@umak.edu.ph');

  await app.close();
});
