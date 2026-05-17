import { FastifyInstance } from 'fastify';
import { getSupabaseClient } from '../services/supabase.js';
import { createNotification } from '../services/notifications.js';
import { getGeminiService, RateLimitError } from '../services/gemini.js';
import { GenerateMetadataBatchResponse, ProcessPendingMatchResponse } from '../types/notifications.js';
import { getAuthorizationHeader } from '../utils/http-headers.js';
import logger from '../utils/logger.js';
import { buildSearchQueryFromSource } from '../utils/search-metadata.js';

interface PendingMatchViewRow {
  id: number;
  post_id: number | null;
  poster_id: string | null;
  status: string | null;
  is_retriable: boolean | null;
  failed_reason: string | null;
  item_name: string | null;
  item_description: string | null;
  item_metadata: Record<string, unknown> | null;
  image_link: string | null;
}

const SYSTEM_TOKEN = process.env.SYSTEM_TOKEN;
const JOB_TIMEOUT_MS = 110000;
const MATCH_SEARCH_LIMIT = 10;

function verifySystemToken(token: string | undefined): boolean {
  return Boolean(SYSTEM_TOKEN && token === `Bearer ${SYSTEM_TOKEN}`);
}

function toNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function detectMimeType(contentType: string | null, imageUrl: string): string {
  const normalizedContentType = contentType?.split(';', 1)[0]?.trim().toLowerCase();
  if (normalizedContentType?.startsWith('image/')) {
    return normalizedContentType;
  }

  const lowerUrl = imageUrl.toLowerCase();
  if (lowerUrl.endsWith('.png')) return 'image/png';
  if (lowerUrl.endsWith('.webp')) return 'image/webp';
  if (lowerUrl.endsWith('.gif')) return 'image/gif';
  return 'image/jpeg';
}

async function fetchImageAsBase64(imageUrl: string): Promise<{ mimeType: string; imageBase64: string }> {
  const response = await fetch(imageUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch image: ${response.status} ${response.statusText}`);
  }

  const mimeType = detectMimeType(response.headers.get('content-type'), imageUrl);
  const arrayBuffer = await response.arrayBuffer();
  const imageBase64 = Buffer.from(arrayBuffer).toString('base64');
  return { mimeType, imageBase64 };
}

function isRateLimitLikeError(error: unknown): boolean {
  if (error instanceof RateLimitError) return true;
  if (!error || typeof error !== 'object') return false;

  const maybeError = error as Record<string, unknown>;
  const message = typeof maybeError.message === 'string' ? maybeError.message : '';
  const status = maybeError.status ?? maybeError.statusCode ?? maybeError.code;
  return status === 429 || /rate.?limit|resource_exhausted|429/i.test(message);
}

async function updatePendingMatch(matchId: number, updates: Record<string, unknown>): Promise<void> {
  const supabase = getSupabaseClient();
  const { error } = await supabase.from('pending_match').update(updates).eq('id', matchId);

  if (error) {
    logger.error({ error, matchId, updates }, 'Failed to update pending match');
  }
}

export default async function jobsRoutes(server: FastifyInstance) {
  // POST /jobs/metadata-batch - Generate metadata for pending items
  server.post(
    '/metadata-batch',
    {
      schema: {
        headers: {
          type: 'object',
          required: ['authorization'],
          properties: {
            authorization: { type: 'string', minLength: 1 },
          },
        },
      },
    },
    async (request): Promise<GenerateMetadataBatchResponse> => {
      if (!verifySystemToken(getAuthorizationHeader(request))) {
        throw new Error('Unauthorized');
      }

      const supabase = getSupabaseClient();
      const geminiService = getGeminiService();

      const { data: items, error } = await supabase
        .from('items_pending_metadata')
        .select('item_id, item_name, item_description, category, item_type')
        .limit(10);

      if (error) {
        logger.error({ error }, 'Failed to fetch items for metadata generation');
        throw new Error('Failed to fetch items');
      }

      const results = [];
      let succeeded = 0;
      let failed = 0;

      for (const item of items || []) {
        try {
          const metadata = await geminiService.generateMetadata({
            id: item.item_id,
            name: item.item_name,
            description: item.item_description,
            category: item.category,
            type: item.item_type,
          });

          await supabase
            .from('item_table')
            .update({ item_metadata: metadata })
            .eq('item_id', item.item_id);

          succeeded++;
          results.push({ item_id: item.item_id, success: true, error: null });
        } catch (error) {
          failed++;
          results.push({ item_id: item.item_id, success: false, error: String(error) });
          logger.error({ error, itemId: item.item_id }, 'Failed to generate metadata for item');
        }
      }

      logger.info({ processed: items?.length || 0, succeeded, failed }, 'Metadata batch processed');
      return { processed: items?.length || 0, succeeded, failed, results };
    }
  );

  async function processPendingMatchRecord(record: PendingMatchViewRow): Promise<void> {
    if (!record.post_id || !record.poster_id) {
      await updatePendingMatch(record.id, {
        status: 'failed',
        is_retriable: false,
        failed_reason: 'Pending match is missing post_id or poster_id',
      });
      throw new Error('Pending match is missing required identifiers');
    }

    const geminiService = getGeminiService();
    const searchSeed = buildSearchQueryFromSource({
      itemName: record.item_name,
      itemDescription: record.item_description,
      itemMetadata: record.item_metadata,
    });
    let searchQuery = searchSeed;

    if (record.image_link) {
      try {
        const { mimeType, imageBase64 } = await fetchImageAsBase64(record.image_link);
        const enhancedQuery = await geminiService.generateReverseImageSearchQuery({
          imageBase64,
          mimeType,
          searchValue: searchSeed,
        });

        if (enhancedQuery.trim().length > 0) {
          searchQuery = enhancedQuery;
        }
      } catch (error) {
        if (isRateLimitLikeError(error)) {
          await updatePendingMatch(record.id, {
            status: 'pending',
            is_retriable: true,
            failed_reason: error instanceof Error ? error.message : 'Rate limit exceeded',
          });
          throw new RateLimitError('Rate limit exceeded');
        }

        logger.warn(
          { error, matchId: record.id },
          'Image-assisted query generation failed; falling back to text search'
        );
      }
    }

    if (searchQuery.trim().length === 0) {
      await updatePendingMatch(record.id, {
        status: 'failed',
        is_retriable: false,
        failed_reason: 'No searchable item data available',
      });
      throw new Error('No searchable item data available');
    }

    const supabase = getSupabaseClient();
    const { data: searchResults, error: searchError } = await supabase.rpc('search_items_fts', {
      search_term: searchQuery,
      limit_count: MATCH_SEARCH_LIMIT,
      p_date: null,
      p_category: null,
      p_location_last_seen: null,
    });

    if (searchError) {
      await updatePendingMatch(record.id, {
        status: 'failed',
        is_retriable: false,
        failed_reason: `Search failed: ${searchError.message}`,
      });
      throw new Error(searchError.message || 'Search failed');
    }

    const matches = (searchResults || []).filter(
      (item: Record<string, unknown>) =>
        item.item_type === 'found' && String(item.post_id ?? '') !== String(record.post_id)
    );

    if (matches.length === 0) {
      await updatePendingMatch(record.id, {
        status: 'match_complete',
        failed_reason: null,
      });
      return;
    }

    const matchedPostIds = Array.from(
      new Set<string>(matches.map((item: Record<string, unknown>) => String(item.post_id ?? '')))
    ).filter((value) => value.length > 0);
    const count = matchedPostIds.length;
    const itemName = toNonEmptyString(record.item_name) ?? 'your missing item';
    const message = `We've found ${count} likely ${
      count === 1 ? 'item' : 'items'
    } similar to your missing ${itemName}. You can go to the Security Office behind the Oval to inspect.`;

    const notificationId = await createNotification({
      user_id: record.poster_id,
      title: 'Found Similar Items',
      body: message,
      description: message,
      type: 'match',
      data: {
        postId: String(record.post_id),
        match_count: count,
      },
    });

    if (!notificationId) {
      await updatePendingMatch(record.id, {
        status: 'failed',
        is_retriable: false,
        failed_reason: 'Failed to create match notification',
      });
      throw new Error('Failed to create match notification');
    }

    await updatePendingMatch(record.id, {
      status: 'match_complete',
      failed_reason: null,
    });
  }

  // POST /jobs/pending-match - Match lost/found items
  server.post(
    '/pending-match',
    {
      schema: {
        headers: {
          type: 'object',
          required: ['authorization'],
          properties: {
            authorization: { type: 'string', minLength: 1 },
          },
        },
      },
    },
    async (request): Promise<ProcessPendingMatchResponse> => {
      if (!verifySystemToken(getAuthorizationHeader(request))) {
        throw new Error('Unauthorized');
      }

      const supabase = getSupabaseClient();
      const { data: pendingMatches, error } = await supabase
        .from('pending_match_v')
        .select('*')
        .eq('status', 'pending')
        .eq('is_retriable', true);

      if (error) {
        logger.error({ error }, 'Failed to fetch pending matches');
        throw new Error('Failed to fetch pending matches');
      }

      let processed = 0;
      let failed = 0;
      let timedOut = false;
      let rateLimitStopped = false;
      const startTime = Date.now();

      for (const record of (pendingMatches || []) as PendingMatchViewRow[]) {
        if (Date.now() - startTime >= JOB_TIMEOUT_MS) {
          timedOut = true;
          break;
        }

        try {
          await processPendingMatchRecord(record);
          processed++;
        } catch (error) {
          if (error instanceof RateLimitError) {
            rateLimitStopped = true;
            break;
          }

          failed++;
          logger.error({ error, matchId: record.id }, 'Failed to process pending match');
        }
      }

      return {
        total_pending: pendingMatches?.length || 0,
        processed,
        failed,
        remaining: Math.max((pendingMatches?.length || 0) - processed - failed, 0),
        timed_out: timedOut,
        rate_limit_stopped: rateLimitStopped,
      };
    }
  );
}
