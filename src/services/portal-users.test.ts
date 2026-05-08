import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getSupabaseClient } from './supabase.js';
import {
  DEFAULT_PORTAL_USER_TYPE,
  isAllowedPortalEmail,
  normalizePortalEmail,
  syncPortalUserOnSignIn,
  type PortalUserRecord,
} from './portal-users.js';

interface FakeDbError {
  code?: string;
  message?: string;
}

interface FakeSupabaseState {
  existingUser: PortalUserRecord | null;
  insertedUser: PortalUserRecord | null;
  updatedUser: PortalUserRecord | null;
  existingUserError?: FakeDbError | null;
  insertError?: FakeDbError | null;
  updateError?: FakeDbError | null;
}

interface FakeSupabaseCalls {
  filters: Array<{ column: string; value: string }>;
  inserts: Array<Record<string, unknown>>;
  updates: Array<Record<string, unknown>>;
}

function createPortalUser(overrides: Partial<PortalUserRecord> = {}): PortalUserRecord {
  return {
    user_id: '11111111-1111-1111-1111-111111111111',
    user_name: 'Test User',
    email: 'test@umak.edu.ph',
    profile_picture_url: null,
    user_type: 'User',
    notification_token: null,
    ...overrides,
  };
}

function createSupabaseMock(state: FakeSupabaseState): {
  calls: FakeSupabaseCalls;
  client: ReturnType<typeof getSupabaseClient>;
} {
  const calls: FakeSupabaseCalls = {
    filters: [],
    inserts: [],
    updates: [],
  };

  const client = {
    from(_table: string) {
      return {
        select(_columns: string) {
          return {
            eq(column: string, value: string) {
              calls.filters.push({ column, value });
              return {
                maybeSingle: async () => ({
                  data: state.existingUser,
                  error: state.existingUserError ?? null,
                }),
              };
            },
            single: async () => ({
              data: state.insertedUser,
              error: state.insertError ?? null,
            }),
          };
        },
        update(payload: Record<string, unknown>) {
          calls.updates.push(payload);
          return {
            eq(column: string, value: string) {
              calls.filters.push({ column, value });
              return {
                select(_columns: string) {
                  return {
                    single: async () => ({
                      data: state.updatedUser,
                      error: state.updateError ?? null,
                    }),
                  };
                },
              };
            },
          };
        },
        insert(payload: Record<string, unknown>) {
          calls.inserts.push(payload);
          return {
            select(_columns: string) {
              return {
                single: async () => ({
                  data: state.insertedUser,
                  error: state.insertError ?? null,
                }),
              };
            },
          };
        },
      };
    },
  };

  return {
    calls,
    client: client as unknown as ReturnType<typeof getSupabaseClient>,
  };
}

test('portal email checks only allow the @umak.edu.ph suffix', () => {
  assert.equal(normalizePortalEmail(' Staff.Member@UMAK.EDU.PH '), 'staff.member@umak.edu.ph');
  assert.equal(isAllowedPortalEmail(' Staff.Member@UMAK.EDU.PH '), true);
  assert.equal(isAllowedPortalEmail('staff.member@gmail.com'), false);
  assert.equal(isAllowedPortalEmail('staff.member@umak.edu.ph.evil.com'), false);
});

test('syncPortalUserOnSignIn inserts unknown users with the default User role', async () => {
  const insertedUser = createPortalUser({
    user_id: '22222222-2222-2222-2222-222222222222',
    user_name: 'New User',
    email: 'new.user@umak.edu.ph',
    user_type: 'User',
  });
  const { client, calls } = createSupabaseMock({
    existingUser: null,
    insertedUser,
    updatedUser: null,
  });
  const loginTimestamp = '2026-05-08T01:23:45.000Z';

  const result = await syncPortalUserOnSignIn(client, {
    email: ' New.User@UMAK.EDU.PH ',
    userName: 'New User',
    loginTimestamp,
  });

  assert.deepEqual(result, insertedUser);
  assert.deepEqual(calls.inserts, [
    {
      email: 'new.user@umak.edu.ph',
      user_name: 'New User',
      last_login: loginTimestamp,
      user_type: DEFAULT_PORTAL_USER_TYPE,
    },
  ]);
  assert.equal(calls.updates.length, 0);
});

test('syncPortalUserOnSignIn updates existing users without overwriting Staff/Admin roles', async () => {
  const existingUser = createPortalUser({
    user_id: '33333333-3333-3333-3333-333333333333',
    user_name: 'Existing Staff',
    email: 'staff.member@umak.edu.ph',
    user_type: 'Staff',
  });
  const updatedUser = createPortalUser({
    ...existingUser,
    user_name: 'Updated Staff',
  });
  const { client, calls } = createSupabaseMock({
    existingUser,
    insertedUser: null,
    updatedUser,
  });

  const result = await syncPortalUserOnSignIn(client, {
    email: 'staff.member@umak.edu.ph',
    userName: 'Updated Staff',
    loginTimestamp: '2026-05-08T01:23:45.000Z',
  });

  assert.deepEqual(result, updatedUser);
  assert.equal(calls.inserts.length, 0);
  assert.equal(calls.updates.length, 1);
  assert.equal('user_type' in calls.updates[0], false);
});

test('syncPortalUserOnSignIn preserves elevated roles after a concurrent first-login insert race', async () => {
  const updatedUser = createPortalUser({
    user_id: '44444444-4444-4444-4444-444444444444',
    user_name: 'Concurrent Staff',
    email: 'concurrent.staff@umak.edu.ph',
    user_type: 'Staff',
  });
  const { client, calls } = createSupabaseMock({
    existingUser: null,
    insertedUser: null,
    updatedUser,
    insertError: { code: '23505', message: 'duplicate key value violates unique constraint' },
  });

  const result = await syncPortalUserOnSignIn(client, {
    email: 'concurrent.staff@umak.edu.ph',
    userName: 'Concurrent Staff',
    loginTimestamp: '2026-05-08T01:23:45.000Z',
  });

  assert.deepEqual(result, updatedUser);
  assert.equal(calls.inserts.length, 1);
  assert.equal(calls.updates.length, 1);
  assert.equal('user_type' in calls.updates[0], false);
});
