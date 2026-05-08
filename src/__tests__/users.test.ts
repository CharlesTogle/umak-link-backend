import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchUsersWithCompatibleRpcSignature } from '../routes/users.js';

test('searchUsersWithCompatibleRpcSignature uses canonical RPC args first', async () => {
  const calls: Array<{ functionName: string; args: Record<string, unknown> }> = [];
  const fakeSupabase = {
    async rpc(functionName: string, args: Record<string, unknown>) {
      calls.push({ functionName, args });
      return {
        data: [
          {
            user_id: 'user-1',
            user_name: 'Alice',
            email: 'alice@umak.edu.ph',
            profile_picture_url: null,
            user_type: 'User' as const,
            notification_token: null,
          },
        ],
        error: null,
      };
    },
  };

  const result = await searchUsersWithCompatibleRpcSignature(
    fakeSupabase,
    'search_users_secure_staff',
    'alice'
  );

  assert.equal(result.error, null);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    functionName: 'search_users_secure_staff',
    args: {
      search_query: 'alice',
      search_limit: 20,
    },
  });
});

test('searchUsersWithCompatibleRpcSignature retries with legacy args on schema-cache signature mismatch', async () => {
  const calls: Array<{ functionName: string; args: Record<string, unknown> }> = [];
  const fakeSupabase = {
    async rpc(functionName: string, args: Record<string, unknown>) {
      calls.push({ functionName, args });

      if (calls.length === 1) {
        return {
          data: null,
          error: {
            code: 'PGRST202',
            message: 'Could not find function in schema cache',
            details: 'Searched for the function public.search_users_secure_staff with parameter search_term.',
          },
        };
      }

      return {
        data: [
          {
            user_id: 'user-2',
            user_name: 'Bob',
            email: 'bob@umak.edu.ph',
            profile_picture_url: null,
            user_type: 'User' as const,
            notification_token: null,
          },
        ],
        error: null,
      };
    },
  };

  const result = await searchUsersWithCompatibleRpcSignature(
    fakeSupabase,
    'search_users_secure_staff',
    'bob',
    5
  );

  assert.equal(result.error, null);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], {
    functionName: 'search_users_secure_staff',
    args: {
      search_query: 'bob',
      search_limit: 5,
    },
  });
  assert.deepEqual(calls[1], {
    functionName: 'search_users_secure_staff',
    args: {
      search_term: 'bob',
    },
  });
});

test('searchUsersWithCompatibleRpcSignature does not retry non-signature errors', async () => {
  const calls: Array<{ functionName: string; args: Record<string, unknown> }> = [];
  const fakeSupabase = {
    async rpc(functionName: string, args: Record<string, unknown>) {
      calls.push({ functionName, args });
      return {
        data: null,
        error: {
          code: '42501',
          message: 'permission denied for function search_users_secure_staff',
        },
      };
    },
  };

  const result = await searchUsersWithCompatibleRpcSignature(
    fakeSupabase,
    'search_users_secure_staff',
    'charlie'
  );

  assert.equal(result.error?.code, '42501');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    functionName: 'search_users_secure_staff',
    args: {
      search_query: 'charlie',
      search_limit: 20,
    },
  });
});
