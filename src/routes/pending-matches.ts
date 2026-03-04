import { FastifyInstance } from 'fastify';
import { getSupabaseClient } from '../services/supabase.js';
import { requireStaff } from '../middleware/auth.js';
import logger from '../utils/logger.js';
import { parsePagination } from '../utils/pagination.js';

interface PendingMatchCreateRequest {
  post_id: number;
  poster_id: string;
  status: string;
  is_retriable: boolean;
  failed_reason?: string;
}

export default async function pendingMatchesRoutes(server: FastifyInstance) {
  // POST /pending-matches - Add to pending match retry queue
  server.post<{ Body: PendingMatchCreateRequest }>(
    '/',
    {
      preHandler: [requireStaff],
      schema: {
        body: {
          type: 'object',
          required: ['post_id', 'poster_id', 'status', 'is_retriable'],
          properties: {
            post_id: { type: 'number' },
            poster_id: { type: 'string', minLength: 1 },
            status: { type: 'string', minLength: 1 },
            is_retriable: { type: 'boolean' },
            failed_reason: { type: 'string' },
          },
          additionalProperties: false,
        },
      },
    },
    async (request) => {
      const supabase = getSupabaseClient();
      const body = request.body;

      const { data, error } = await supabase
        .from('pending_match')
        .insert({
          post_id: body.post_id,
          poster_id: body.poster_id,
          status: body.status,
          is_retriable: body.is_retriable,
          failed_reason: body.failed_reason || null,
        })
        .select('id')
        .single();

      if (error) {
        logger.error({ error }, 'Failed to create pending match');
        throw new Error(error.message || 'Failed to create pending match');
      }

      logger.info({ pendingMatchId: data.id }, 'Pending match created');
      return { success: true, id: data.id };
    }
  );

  // GET /pending-matches - List pending matches
  server.get<{
    Querystring: {
      limit?: string;
      offset?: string;
      status?: string;
    };
  }>(
    '/',
    {
      preHandler: [requireStaff],
      schema: {
        querystring: {
          type: 'object',
          properties: {
            limit: { type: 'string' },
            offset: { type: 'string' },
            status: { type: 'string' },
          },
        },
      },
    },
    async (request) => {
      const supabase = getSupabaseClient();
      const { limit, offset, status } = request.query;

      const { limit: limitNum, offset: offsetNum } = parsePagination(limit, offset);

      let query = supabase
        .from('pending_match')
        .select('*')
        .order('created_at', { ascending: false })
        .range(offsetNum, offsetNum + limitNum - 1);

      if (status) {
        query = query.eq('status', status);
      }

      const { data, error } = await query;

      if (error) {
        logger.error({ error }, 'Failed to fetch pending matches');
        throw new Error('Failed to fetch pending matches');
      }

      return { pending_matches: data || [], count: data?.length };
    }
  );

  // PUT /pending-matches/:id/status - Update pending match status
  server.put<{
    Params: { id: string };
    Body: { status: string };
  }>(
    '/:id/status',
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
        body: {
          type: 'object',
          required: ['status'],
          properties: {
            status: { type: 'string', minLength: 1 },
          },
          additionalProperties: false,
        },
      },
    },
    async (request) => {
      const supabase = getSupabaseClient();
      const matchId = request.params.id;
      const { status } = request.body;

      const { error } = await supabase
        .from('pending_match')
        .update({ status })
        .eq('id', matchId);

      if (error) {
        logger.error({ error, matchId }, 'Failed to update pending match status');
        throw new Error(error.message || 'Failed to update status');
      }

      logger.info({ matchId, status }, 'Pending match status updated');
      return { success: true };
    }
  );
}
