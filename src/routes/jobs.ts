import { FastifyInstance } from 'fastify';
import { getSupabaseClient } from '../services/supabase.js';
import { getGeminiService } from '../services/gemini.js';
import { GenerateMetadataBatchResponse, ProcessPendingMatchResponse } from '../types/notifications.js';
import logger from '../utils/logger.js';

// System token for scheduled jobs
const SYSTEM_TOKEN = process.env.SYSTEM_TOKEN;

function verifySystemToken(token: string | undefined): boolean {
  return Boolean(SYSTEM_TOKEN && token === `Bearer ${SYSTEM_TOKEN}`);
}

export default async function jobsRoutes(server: FastifyInstance) {
  // POST /jobs/metadata-batch - Generate metadata for pending items
  server.post('/metadata-batch', async (request): Promise<GenerateMetadataBatchResponse> => {
    if (!verifySystemToken(request.headers.authorization)) {
      throw new Error('Unauthorized');
    }

    const supabase = getSupabaseClient();
    const geminiService = getGeminiService();

    // Get items without metadata
    const { data: items, error } = await supabase
      .from('item_table')
      .select('item_id, item_name, item_description, category, item_type')
      .is('metadata', null)
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
          .update({ metadata })
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
  });

  // POST /jobs/pending-match - Match lost/found items
  server.post('/pending-match', async (request): Promise<ProcessPendingMatchResponse> => {
    if (!verifySystemToken(request.headers.authorization)) {
      throw new Error('Unauthorized');
    }

    const supabase = getSupabaseClient();

    // Implementation placeholder - actual matching logic would go here
    logger.info('Pending match job triggered');

    const { count } = await supabase
      .from('item_table')
      .select('*', { count: 'exact', head: true })
      .eq('item_status', 'unclaimed');

    return {
      total_pending: count || 0,
      processed: 0,
      failed: 0,
      remaining: count || 0,
      timed_out: false,
      rate_limit_stopped: false,
    };
  });
}
