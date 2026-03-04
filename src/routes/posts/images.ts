import { FastifyInstance } from 'fastify';
import { getSupabaseClient } from '../../services/supabase.js';
import { requireAuth } from '../../middleware/auth.js';
import { EditPostRequest } from '../../types/posts.js';
import logger from '../../utils/logger.js';

export default async function postsImageRoutes(server: FastifyInstance) {
  // PUT /posts/:id/edit-with-image - Edit post with image replacement
  server.put<{
    Params: { id: string };
    Body: EditPostRequest & {
      p_image_hash?: string;
      p_image_link?: string;
      p_post_status?: string;
      p_item_status?: string;
    };
  }>(
    '/:id/edit-with-image',
    {
      preHandler: [requireAuth],
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
          properties: {
            p_item_name: { type: 'string' },
            p_item_description: { type: 'string' },
            p_item_type: { type: 'string', enum: ['found', 'lost', 'missing'] },
            p_image_hash: { type: 'string' },
            p_image_link: { type: 'string' },
            p_last_seen_date: { type: 'string' },
            p_last_seen_hours: { type: 'number' },
            p_last_seen_minutes: { type: 'number' },
            p_location_path: {
              type: 'array',
              items: {
                type: 'object',
                required: ['name', 'type'],
                properties: {
                  name: { type: 'string', minLength: 1 },
                  type: { type: 'string', minLength: 1 },
                },
              },
            },
            p_item_status: { type: 'string' },
            p_category: { type: 'string' },
            p_post_status: { type: 'string' },
            p_is_anonymous: { type: 'boolean' },
          },
          additionalProperties: false,
        },
      },
    },
    async (request) => {
      const supabase = getSupabaseClient();
      const postId = parseInt(request.params.id, 10);
      const body = request.body;

      // First, get the old image link to delete later
      const { data: postRecord, error: fetchError } = await supabase
        .from('post_table')
        .select('item_id')
        .eq('post_id', postId)
        .single();

      if (fetchError || !postRecord) {
        logger.error({ error: fetchError, postId }, 'Failed to fetch post for edit');
        throw new Error('Post not found');
      }

      const { data: itemRecord, error: itemError } = await supabase
        .from('item_table')
        .select('image_id')
        .eq('item_id', postRecord.item_id)
        .single();

      if (itemError || !itemRecord) {
        logger.error({ error: itemError, postId }, 'Failed to fetch item for edit');
        throw new Error('Item not found');
      }

      const { data: oldImageData } = await supabase
        .from('item_image_table')
        .select('image_link')
        .eq('item_image_id', itemRecord.image_id)
        .single();

      // Call the RPC to edit the post
      const { data, error } = await supabase.rpc('edit_post_with_item_date_time_location', {
        p_post_id: postId,
        p_item_name: body.p_item_name,
        p_item_description: body.p_item_description,
        p_item_type: body.p_item_type,
        p_image_hash: body.p_image_hash,
        p_image_link: body.p_image_link,
        p_last_seen_date: body.p_last_seen_date,
        p_last_seen_hours: body.p_last_seen_hours,
        p_last_seen_minutes: body.p_last_seen_minutes,
        p_location_path: body.p_location_path,
        p_item_status: body.p_item_status || (body.p_item_type === 'found' ? 'unclaimed' : 'lost'),
        p_category: body.p_category,
        p_post_status: body.p_post_status || 'pending',
        p_is_anonymous: body.p_is_anonymous,
      });

      if (error) {
        logger.error({ error, postId }, 'Failed to edit post with image');
        throw new Error(error.message || 'Failed to edit post');
      }

      // Delete old image from storage if we have a new one
      if (oldImageData?.image_link && body.p_image_link) {
        const urlParts = oldImageData.image_link.split('/storage/v1/object/public/items/');
        if (urlParts.length > 1) {
          const oldImagePath = urlParts[1];
          const { error: deleteError } = await supabase.storage
            .from('items')
            .remove([oldImagePath]);

          if (deleteError) {
            // Log but don't fail the edit
            logger.warn({ deleteError, oldImagePath }, 'Failed to delete old image');
          } else {
            logger.info({ oldImagePath }, 'Old image deleted');
          }
        }
      }

      logger.info({ postId }, 'Post edited with image');
      return { success: true, post_id: data };
    }
  );
}
