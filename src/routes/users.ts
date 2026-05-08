import { FastifyInstance } from 'fastify';
import { getSupabaseClient } from '../services/supabase.js';
import { requireStaff } from '../middleware/auth.js';
import { UserSearchResponse } from '../types/auth.js';
import logger from '../utils/logger.js';

const DEFAULT_USER_SEARCH_LIMIT = 20;

type UserSearchRpcError = {
  code?: string;
  message: string;
  details?: string | null;
  hint?: string | null;
};

type UserSearchRpcResult = {
  data: UserSearchResponse['results'] | null;
  error: UserSearchRpcError | null;
};

type UserSearchRpcClient = {
  rpc(functionName: string, args: Record<string, unknown>): PromiseLike<UserSearchRpcResult>;
};

function isRpcSignatureMismatch(error: UserSearchRpcError | null): boolean {
  if (!error) return false;

  return (
    error.code === 'PGRST202' ||
    error.details?.includes('Searched for the function') === true ||
    error.message.includes('schema cache')
  );
}

export async function searchUsersWithCompatibleRpcSignature(
  supabase: UserSearchRpcClient,
  rpcFunction: 'search_users_secure' | 'search_users_secure_staff',
  query: string,
  limit = DEFAULT_USER_SEARCH_LIMIT
): Promise<UserSearchRpcResult> {
  const primaryAttempt = await supabase.rpc(rpcFunction, {
    search_query: query,
    search_limit: limit,
  });

  if (!primaryAttempt.error || !isRpcSignatureMismatch(primaryAttempt.error)) {
    return primaryAttempt;
  }

  logger.warn(
    { error: primaryAttempt.error, rpcFunction },
    'User search RPC signature mismatch, retrying with legacy search_term argument'
  );

  return supabase.rpc(rpcFunction, {
    search_term: query,
  });
}

export default async function usersRoutes(server: FastifyInstance) {
  // GET /users/:id - Get user profile (staff only)
  server.get<{ Params: { id: string } }>(
    '/:id',
    {
      preHandler: [requireStaff],
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', minLength: 1 },
          },
        },
      },
    },
    async (request) => {
      const supabase = getSupabaseClient();
      const userId = request.params.id;

      const { data: user, error } = await supabase
        .from('user_table')
        .select('user_id, user_name, email, profile_picture_url, user_type')
        .eq('user_id', userId)
        .single();

      if (error || !user) {
        logger.error({ error, userId }, 'Failed to fetch user');
        throw new Error('User not found');
      }

      return user;
    }
  );

  // GET /users/search - Search users (staff/admin only)
  server.get<{ Querystring: { query: string } }>(
    '/search',
    {
      preHandler: [requireStaff],
      schema: {
        querystring: {
          type: 'object',
          required: ['query'],
          properties: {
            query: { type: 'string', minLength: 1 },
          },
        },
      },
    },
    async (request): Promise<UserSearchResponse> => {
      const supabase = getSupabaseClient();
      const { query } = request.query;

      const rpcFunction =
        request.user?.user_type === 'Admin' ? 'search_users_secure' : 'search_users_secure_staff';

      const { data, error } = await searchUsersWithCompatibleRpcSignature(
        supabase,
        rpcFunction,
        query
      );

      if (error) {
        logger.error({ error }, 'User search failed');
        throw new Error(error.message || 'Search failed');
      }

      return { results: data || [] };
    }
  );
}
