import { FastifyInstance } from 'fastify';
import { getSupabaseClient } from '../../services/supabase.js';
import { requireAuth } from '../../middleware/auth.js';
import { CreatePostRequest, EditPostRequest } from '../../types/posts.js';
import logger from '../../utils/logger.js';

export default async function postsWriteRoutes(server: FastifyInstance) {
  // POST /posts - Create new post
  server.post<{ Body: CreatePostRequest }>(
    '/',
    {
      preHandler: [requireAuth],
      schema: {
        body: {
          type: 'object',
          required: ['p_item_name', 'p_item_type', 'p_image_hash', 'p_location_path'],
          properties: {
            p_item_name: { type: 'string', minLength: 1 },
            p_item_description: { type: 'string' },
            p_item_type: { type: 'string', enum: ['found', 'lost', 'missing'] },
            p_poster_id: { type: 'string' },
            p_image_hash: { type: 'string', minLength: 1 },
            p_category: { type: 'string' },
            p_date_day: { type: 'number' },
            p_date_month: { type: 'number' },
            p_date_year: { type: 'number' },
            p_time_hour: { type: 'number' },
            p_time_minute: { type: 'number' },
            p_location_path: {
              type: 'array',
              minItems: 1,
              items: {
                type: 'object',
                required: ['name', 'type'],
                properties: {
                  name: { type: 'string', minLength: 1 },
                  type: { type: 'string', minLength: 1 },
                },
              },
            },
            p_is_anonymous: { type: 'boolean' },
          },
          additionalProperties: false,
        },
      },
    },
    async (request) => {
      const supabase = getSupabaseClient();
      const body = request.body;
      const posterId = request.user?.user_id;

      if (!posterId) {
        throw new Error('Unauthorized');
      }

      const { data, error } = await supabase.rpc('create_post_with_item_date_time_location', {
        p_item_name: body.p_item_name,
        p_item_description: body.p_item_description,
        p_item_type: body.p_item_type,
        p_poster_id: posterId,
        p_image_hash: body.p_image_hash,
        p_category: body.p_category,
        p_date_day: body.p_date_day,
        p_date_month: body.p_date_month,
        p_date_year: body.p_date_year,
        p_time_hour: body.p_time_hour,
        p_time_minute: body.p_time_minute,
        p_location_path: body.p_location_path,
        p_is_anonymous: body.p_is_anonymous,
      });

      if (error) {
        logger.error({ error }, 'Failed to create post');
        throw new Error(error.message || 'Failed to create post');
      }

      logger.info({ postId: data }, 'Post created');
      return { post_id: data };
    }
  );

  // PUT /posts/:id - Edit post
  server.put<{ Params: { id: string }; Body: EditPostRequest }>(
    '/:id',
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
            p_category: { type: 'string' },
            p_date_day: { type: 'number' },
            p_date_month: { type: 'number' },
            p_date_year: { type: 'number' },
            p_time_hour: { type: 'number' },
            p_time_minute: { type: 'number' },
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
      const userId = request.user?.user_id;

      if (!userId) {
        throw new Error('Unauthorized');
      }

      if (request.user?.user_type === 'User') {
        const { data: postOwner, error: ownerError } = await supabase
          .from('post_table')
          .select('poster_id')
          .eq('post_id', postId)
          .single();

        if (ownerError || !postOwner) {
          logger.error({ error: ownerError, postId }, 'Failed to fetch post owner');
          throw new Error('Post not found');
        }

        if (postOwner.poster_id !== userId) {
          throw new Error('Unauthorized');
        }
      }

      const { data, error } = await supabase.rpc('edit_post_with_item_date_time_location', {
        p_post_id: postId,
        p_item_name: body.p_item_name,
        p_item_description: body.p_item_description,
        p_item_type: body.p_item_type,
        p_category: body.p_category,
        p_date_day: body.p_date_day,
        p_date_month: body.p_date_month,
        p_date_year: body.p_date_year,
        p_time_hour: body.p_time_hour,
        p_time_minute: body.p_time_minute,
        p_location_path: body.p_location_path,
        p_is_anonymous: body.p_is_anonymous,
      });

      if (error) {
        logger.error({ error, postId }, 'Failed to edit post');
        throw new Error(error.message || 'Failed to edit post');
      }

      logger.info({ postId }, 'Post edited');
      return { success: true, post_id: data };
    }
  );

  // DELETE /posts/:id - Delete post
  server.delete<{ Params: { id: string } }>(
    '/:id',
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
      },
    },
    async (request) => {
      const supabase = getSupabaseClient();
      const postId = parseInt(request.params.id, 10);

      const { error } = await supabase.rpc('delete_post_by_id', {
        p_post_id: postId,
      });

      if (error) {
        logger.error({ error, postId }, 'Failed to delete post');
        throw new Error(error.message || 'Failed to delete post');
      }

      logger.info({ postId }, 'Post deleted');
      return { success: true };
    }
  );
}
