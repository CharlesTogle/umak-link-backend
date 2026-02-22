import { FastifyInstance } from 'fastify';
import { getSupabaseClient } from '../services/supabase.js';
import { requireStaff } from '../middleware/auth.js';
import logger from '../utils/logger.js';

export default async function itemsRoutes(server: FastifyInstance) {
  // GET /items/:id - Get item details (staff only)
  server.get<{ Params: { id: string } }>(
    '/:id',
    {
      preHandler: [requireStaff],
    },
    async (request) => {
      const supabase = getSupabaseClient();
      const itemId = request.params.id;

      const { data: item, error } = await supabase
        .from('item_table')
        .select('*')
        .eq('item_id', itemId)
        .single();

      if (error || !item) {
        logger.error({ error, itemId }, 'Failed to fetch item');
        throw new Error('Item not found');
      }

      return item;
    }
  );

  // PUT /items/:id/metadata - Update item metadata (staff only)
  server.put<{
    Params: { id: string };
    Body: { item_metadata: Record<string, any> };
  }>(
    '/:id/metadata',
    {
      preHandler: [requireStaff],
    },
    async (request) => {
      const supabase = getSupabaseClient();
      const itemId = request.params.id;
      const { item_metadata } = request.body;

      const { error } = await supabase
        .from('item_table')
        .update({ item_metadata })
        .eq('item_id', itemId);

      if (error) {
        logger.error({ error, itemId }, 'Failed to update item metadata');
        throw new Error(error.message || 'Failed to update item metadata');
      }

      logger.info({ itemId }, 'Item metadata updated');
      return { success: true };
    }
  );
}
