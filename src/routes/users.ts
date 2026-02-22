import { FastifyInstance } from 'fastify';
import { getSupabaseClient } from '../services/supabase.js';
import { requireStaff } from '../middleware/auth.js';
import { UserSearchResponse } from '../types/auth.js';
import logger from '../utils/logger.js';

export default async function usersRoutes(server: FastifyInstance) {
  // GET /users/:id - Get user profile (staff only)
  server.get<{ Params: { id: string } }>(
    '/:id',
    {
      preHandler: [requireStaff],
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
    },
    async (request): Promise<UserSearchResponse> => {
      const supabase = getSupabaseClient();
      const { query } = request.query;

      const rpcFunction =
        request.user?.user_type === 'Admin' ? 'search_users_secure' : 'search_users_secure_staff';

      const { data, error } = await supabase.rpc(rpcFunction, {
        search_term: query,
      });

      if (error) {
        logger.error({ error }, 'User search failed');
        throw new Error(error.message || 'Search failed');
      }

      return { results: data || [] };
    }
  );
}
