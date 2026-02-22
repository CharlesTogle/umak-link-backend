import { FastifyInstance } from 'fastify';
import { getSupabaseClient } from '../services/supabase.js';
import { requireAuth, requireStaff } from '../middleware/auth.js';
import { SearchItemsRequest, SearchItemsStaffRequest } from '../types/search.js';
import logger from '../utils/logger.js';

interface MatchMissingItemRequest {
  post_id: string;
}

interface MatchResult {
  success: boolean;
  matches: any[];
  missing_post?: any;
  total_matches?: number;
}

export default async function searchRoutes(server: FastifyInstance) {
  // POST /search/items - User search
  server.post<{ Body: SearchItemsRequest }>(
    '/items',
    {
      preHandler: [requireAuth],
    },
    async (request) => {
      const supabase = getSupabaseClient();
      const body = request.body;

      const { data, error } = await supabase.rpc('search_items_fts', {
        search_query: body.query,
        search_limit: body.limit || 50,
        last_seen_date_param: body.last_seen_date,
        category_param: body.category,
        location_last_seen_param: body.location_last_seen,
        claim_from_param: body.claim_from,
        claim_to_param: body.claim_to,
        item_status_param: body.item_status,
        sort_param: body.sort || 'submission_date',
        sort_direction_param: body.sort_direction || 'desc',
      });

      if (error) {
        logger.error({ error }, 'Search failed');
        throw new Error(error.message || 'Search failed');
      }

      return { results: data || [] };
    }
  );

  // POST /search/items/staff - Staff search
  server.post<{ Body: SearchItemsStaffRequest }>(
    '/items/staff',
    {
      preHandler: [requireStaff],
    },
    async (request) => {
      const supabase = getSupabaseClient();
      const body = request.body;

      const { data, error } = await supabase.rpc('search_items_fts_staff', {
        search_query: body.query,
        search_limit: body.limit || 50,
        last_seen_date_param: body.last_seen_date,
        category_param: body.category,
        location_last_seen_param: body.location_last_seen,
        claim_from_param: body.claim_from,
        claim_to_param: body.claim_to,
        item_status_param: body.item_status,
        sort_param: body.sort || 'submission_date',
        sort_direction_param: body.sort_direction || 'desc',
      });

      if (error) {
        logger.error({ error }, 'Staff search failed');
        throw new Error(error.message || 'Search failed');
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
        search_query: searchQuery,
        search_limit: 20,
        last_seen_date_param: null,
        category_param: itemData.category ? [itemData.category] : null,
        location_last_seen_param: null,
        claim_from_param: null,
        claim_to_param: null,
        item_status_param: ['unclaimed'],
        sort_param: 'accepted_on_date',
        sort_direction_param: 'desc',
      });

      if (searchError) {
        logger.error({ error: searchError }, 'Failed to search for matches');
        return { success: false, matches: [] };
      }

      // Filter out the missing post itself and only include found items
      const filteredMatches = (matches || []).filter(
        (match: any) => match.post_id !== parseInt(post_id) && match.item_type === 'found'
      );

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
