import { FastifyInstance } from 'fastify';
import { getSupabaseClient } from '../services/supabase.js';
import { getGeminiService, RateLimitError } from '../services/gemini.js';
import { requireAuth, requireStaff } from '../middleware/auth.js';
import { SearchItemsRequest, SearchItemsStaffRequest } from '../types/search.js';
import logger from '../utils/logger.js';
import { logAudit, getUserName } from '../utils/audit-logger.js';

interface MatchMissingItemRequest {
  post_id: string;
}

interface MatchResult {
  success: boolean;
  matches: any[];
  missing_post?: any;
  total_matches?: number;
}

interface ReverseImageQueryBody {
  image_data_url: string;
  search_value?: string;
}

function isAbortLikeError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;

  const asRecord = error as Record<string, unknown>;
  const message = typeof asRecord.message === 'string' ? asRecord.message : '';
  const details = typeof asRecord.details === 'string' ? asRecord.details : '';
  const hint = typeof asRecord.hint === 'string' ? asRecord.hint : '';
  const code = typeof asRecord.code === 'string' ? asRecord.code : '';

  const combined = `${message} ${details} ${hint} ${code}`.toLowerCase();
  return combined.includes('abort') || combined.includes('timeout') || combined.includes('timed out');
}

function throwSearchError(error: unknown, fallbackMessage: string): never {
  if (isAbortLikeError(error)) {
    const timeoutError = new Error(
      'Search request timed out. Please try again or narrow your filters.'
    ) as Error & { statusCode?: number };
    timeoutError.statusCode = 504;
    throw timeoutError;
  }

  const internalError = new Error(fallbackMessage) as Error & { statusCode?: number };
  internalError.statusCode = 500;
  throw internalError;
}

function parseImageDataUrl(dataUrl: string): { mimeType: string; base64: string } {
  const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/);
  if (!match) {
    throw new Error('Invalid image_data_url');
  }

  return {
    mimeType: match[1],
    base64: match[2],
  };
}

export default async function searchRoutes(server: FastifyInstance) {
  // POST /search/image-query - Generate search query from an uploaded image
  server.post<{ Body: ReverseImageQueryBody }>(
    '/image-query',
    {
      preHandler: [requireStaff],
      schema: {
        body: {
          type: 'object',
          required: ['image_data_url'],
          properties: {
            image_data_url: { type: 'string', minLength: 1 },
            search_value: { type: 'string' },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      try {
        const { mimeType, base64 } = parseImageDataUrl(request.body.image_data_url);
        const gemini = getGeminiService();

        const searchQuery = await gemini.generateReverseImageSearchQuery({
          imageBase64: base64,
          mimeType,
          searchValue: request.body.search_value,
        });

        return {
          success: true,
          search_query: searchQuery,
        };
      } catch (error) {
        if (error instanceof RateLimitError) {
          return reply.status(429).send({
            success: false,
            error: 'rate_limit_exceeded',
            message: 'Image search is limited right now. Try again later.',
          });
        }

        if (error instanceof Error && error.message === 'Gemini service not configured') {
          return reply.status(503).send({
            success: false,
            error: 'ai_unavailable',
            message: 'Image search is unavailable right now.',
          });
        }

        logger.error({ error }, 'Failed to generate reverse image search query');
        return reply.status(500).send({
          success: false,
          error: 'image_query_failed',
          message: 'Failed to analyze image for search.',
        });
      }
    }
  );

  // POST /search/items - User search
  server.post<{ Body: SearchItemsRequest }>(
    '/items',
    {
      preHandler: [requireAuth],
      schema: {
        body: {
          type: 'object',
          required: ['query'],
          properties: {
            query: { type: 'string', minLength: 1 },
            limit: { type: 'number', minimum: 1, maximum: 100 },
            last_seen_date: { type: ['string', 'null'] },
            category: { type: ['array', 'null'], items: { type: 'string' } },
            location_last_seen: { type: ['string', 'null'] },
            claim_from: { type: ['string', 'null'] },
            claim_to: { type: ['string', 'null'] },
            item_status: {
              type: ['array', 'null'],
              items: { type: 'string', enum: ['claimed', 'unclaimed', 'discarded', 'returned', 'lost'] },
            },
            sort: { type: 'string', enum: ['submission_date'] },
            sort_direction: { type: 'string', enum: ['asc', 'desc'] },
          },
          additionalProperties: false,
        },
      },
    },
    async (request) => {
      const supabase = getSupabaseClient();
      const body = request.body;
      const requestedLimit = body.limit || 50;

      let { data, error } = await supabase.rpc('search_items_fts', {
        search_term: body.query,
        limit_count: requestedLimit,
        p_date: body.last_seen_date,
        p_category: body.category,
        p_location_last_seen: body.location_last_seen,
        p_claim_from: body.claim_from,
        p_claim_to: body.claim_to,
        p_item_status: body.item_status,
        p_limit: requestedLimit,
        p_sort: body.sort || 'submission_date',
        p_sort_direction: body.sort_direction || 'desc',
      });

      if (error && isAbortLikeError(error) && requestedLimit > 20) {
        logger.warn(
          { requestedLimit, retryLimit: 20 },
          'Search timed out, retrying with smaller limit'
        );

        const retry = await supabase.rpc('search_items_fts', {
          search_term: body.query,
          limit_count: 20,
          p_date: body.last_seen_date,
          p_category: body.category,
          p_location_last_seen: body.location_last_seen,
          p_claim_from: body.claim_from,
          p_claim_to: body.claim_to,
          p_item_status: body.item_status,
          p_limit: 20,
          p_sort: body.sort || 'submission_date',
          p_sort_direction: body.sort_direction || 'desc',
        });

        data = retry.data;
        error = retry.error;
      }

      if (error) {
        logger.error({ error }, 'Search failed');
        throwSearchError(error, error.message || 'Search failed');
      }

      return { results: data || [] };
    }
  );

  // POST /search/items/staff - Staff search
  server.post<{ Body: SearchItemsStaffRequest }>(
    '/items/staff',
    {
      preHandler: [requireStaff],
      schema: {
        body: {
          type: 'object',
          required: ['query'],
          properties: {
            query: { type: 'string', minLength: 1 },
            limit: { type: 'number', minimum: 1, maximum: 100 },
            last_seen_date: { type: ['string', 'null'] },
            category: { type: ['array', 'null'], items: { type: 'string' } },
            location_last_seen: { type: ['string', 'null'] },
            claim_from: { type: ['string', 'null'] },
            claim_to: { type: ['string', 'null'] },
            item_status: {
              type: ['array', 'null'],
              items: { type: 'string', enum: ['claimed', 'unclaimed', 'discarded', 'returned', 'lost'] },
            },
            sort: { type: 'string', enum: ['accepted_on_date', 'submission_date'] },
            sort_direction: { type: 'string', enum: ['asc', 'desc'] },
          },
          additionalProperties: false,
        },
      },
    },
    async (request) => {
      const supabase = getSupabaseClient();
      const body = request.body;
      const requestedLimit = body.limit || 50;

      let { data, error } = await supabase.rpc('search_items_fts_staff', {
        search_term: body.query,
        limit_count: requestedLimit,
        p_date: body.last_seen_date,
        p_category: body.category,
        p_location_last_seen: body.location_last_seen,
        p_claim_from: body.claim_from,
        p_claim_to: body.claim_to,
        p_item_status: body.item_status,
        p_limit: requestedLimit,
        p_sort: body.sort || 'submission_date',
        p_sort_direction: body.sort_direction || 'desc',
      });

      if (error && isAbortLikeError(error) && requestedLimit > 20) {
        logger.warn(
          { requestedLimit, retryLimit: 20 },
          'Staff search timed out, retrying with smaller limit'
        );

        const retry = await supabase.rpc('search_items_fts_staff', {
          search_term: body.query,
          limit_count: 20,
          p_date: body.last_seen_date,
          p_category: body.category,
          p_location_last_seen: body.location_last_seen,
          p_claim_from: body.claim_from,
          p_claim_to: body.claim_to,
          p_item_status: body.item_status,
          p_limit: 20,
          p_sort: body.sort || 'submission_date',
          p_sort_direction: body.sort_direction || 'desc',
        });

        data = retry.data;
        error = retry.error;
      }

      if (error) {
        logger.error({ error }, 'Staff search failed');
        throwSearchError(error, error.message || 'Search failed');
      }

      return { results: data || [] };
    }
  );

  // POST /search/match-missing-item - Find matches for a missing item
  server.post<{ Body: MatchMissingItemRequest }>(
    '/match-missing-item',
    {
      preHandler: [requireStaff],
    },
    async (request): Promise<MatchResult> => {
      const supabase = getSupabaseClient();
      const { post_id } = request.body;

      // Get the missing post details
      const { data: missingPost, error: postError } = await supabase
        .from('v_post_records_details')
        .select('*')
        .eq('post_id', post_id)
        .single();

      if (postError || !missingPost) {
        logger.error({ error: postError, post_id }, 'Failed to fetch missing post');
        return { success: false, matches: [] };
      }

      // Get the item details for matching
      const { data: itemData, error: itemError } = await supabase
        .from('item_table')
        .select('item_name, item_description, category, item_metadata')
        .eq('item_id', missingPost.item_id)
        .single();

      if (itemError || !itemData) {
        logger.error({ error: itemError, item_id: missingPost.item_id }, 'Failed to fetch item');
        return { success: false, matches: [] };
      }

      // Search for matching found items using full-text search
      const searchQuery = `${itemData.item_name || ''} ${itemData.item_description || ''}`.trim();

      if (!searchQuery) {
        return { success: true, matches: [], missing_post: missingPost, total_matches: 0 };
      }

      const { data: matches, error: searchError } = await supabase.rpc('search_items_fts_staff', {
        search_term: searchQuery,
        limit_count: 20,
        p_date: null,
        p_category: itemData.category ? [itemData.category] : null,
        p_location_last_seen: null,
        p_claim_from: null,
        p_claim_to: null,
        p_item_status: ['unclaimed'],
        p_limit: 20,
        p_sort: 'accepted_on_date',
        p_sort_direction: 'desc',
      });

      if (searchError) {
        logger.error({ error: searchError }, 'Failed to search for matches');
        return { success: false, matches: [] };
      }

      // Filter out the missing post itself and only include found items
      const filteredMatches = (matches || []).filter(
        (match: any) => match.post_id !== parseInt(post_id) && match.item_type === 'found'
      );

      // Log to audit trail
      const staffId = request.user?.user_id;
      if (staffId) {
        const staffName = await getUserName(staffId);
        const itemName = itemData.item_name || 'Unknown Item';

        await logAudit({
          userId: staffId,
          actionType: 'match_attempt',
          details: {
            message: `${staffName} initiated match generation for post ${itemName}`,
            post_id: post_id,
            item_name: itemName,
            matches_found: filteredMatches.length,
            timestamp: new Date().toISOString(),
          },
          recordId: post_id,
        });
      }

      logger.info({ post_id, matches_found: filteredMatches.length }, 'Match search completed');

      return {
        success: true,
        matches: filteredMatches,
        missing_post: missingPost,
        total_matches: filteredMatches.length,
      };
    }
  );
}
