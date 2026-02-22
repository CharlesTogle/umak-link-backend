import { FastifyInstance } from 'fastify';
import { getSupabaseClient } from '../services/supabase.js';
import { requireAuth, requireStaff } from '../middleware/auth.js';
import {
  CreatePostRequest,
  EditPostRequest,
  PostListResponse,
  PostRecord,
  UpdatePostStatusRequest,
  UpdateItemStatusRequest,
} from '../types/posts.js';
import logger from '../utils/logger.js';

export default async function postsRoutes(server: FastifyInstance) {
  // GET /posts - Comprehensive post listing with filtering
  server.get<{
    Querystring: {
      type?: 'public' | 'pending' | 'staff' | 'own';
      item_type?: 'found' | 'missing';
      status?: string;
      poster_id?: string;
      item_id?: string;
      linked_item_id?: string;
      post_ids?: string;
      exclude_ids?: string;
      limit?: string;
      offset?: string;
      include_count?: string;
      order_by?: 'submission_date' | 'accepted_on_date';
      order_direction?: 'asc' | 'desc';
    };
  }>('/', async (request): Promise<PostListResponse> => {
    const supabase = getSupabaseClient();
    const {
      type,
      item_type,
      status,
      poster_id,
      item_id,
      linked_item_id,
      post_ids,
      exclude_ids,
      limit = '20',
      offset = '0',
      include_count,
      order_by = 'submission_date',
      order_direction = 'desc',
    } = request.query;

    // Cap limit to prevent excessive data fetching
    const limitNum = Math.min(parseInt(limit, 10), 100);
    const offsetNum = parseInt(offset, 10);

    let query = supabase.from('post_public_view').select('*');

    // Apply filters based on type
    if (type === 'public') {
      query = query.eq('item_type', 'found').in('post_status', ['accepted', 'reported']);
    } else if (type === 'pending') {
      query = query.eq('post_status', 'pending');
    } else if (type === 'own' && poster_id) {
      query = query.eq('poster_id', poster_id);
    }

    // Apply additional filters
    if (item_type) {
      query = query.eq('item_type', item_type);
    }
    if (status) {
      query = query.eq('post_status', status);
    }
    if (poster_id && type !== 'own') {
      query = query.eq('poster_id', poster_id);
    }
    if (item_id) {
      query = query.eq('item_id', item_id);
    }
    if (linked_item_id) {
      // Need to query v_post_records_details for this
      const { data: linkedData, error: linkedError } = await supabase
        .from('v_post_records_details')
        .select('*')
        .eq('linked_lost_item_id', linked_item_id)
        .limit(limitNum)
        .range(offsetNum, offsetNum + limitNum - 1);

      if (linkedError) {
        logger.error({ error: linkedError }, 'Failed to fetch posts by linked item');
        throw new Error('Failed to fetch posts');
      }

      return { posts: linkedData || [], count: linkedData?.length };
    }

    // Handle post_ids filter
    if (post_ids) {
      const idsArray = post_ids.split(',');
      query = query.in('post_id', idsArray);
    }

    // Handle exclude_ids filter
    if (exclude_ids) {
      const excludeArray = exclude_ids.split(',');
      query = query.not('post_id', 'in', `(${excludeArray.join(',')})`);
    }

    // Apply ordering
    const ascending = order_direction === 'asc';
    query = query.order(order_by, { ascending });

    // Apply pagination
    query = query.range(offsetNum, offsetNum + limitNum - 1);

    const { data: posts, error } = await query;

    if (error) {
      logger.error({ error }, 'Failed to fetch posts');
      throw new Error('Failed to fetch posts');
    }

    // Get count if requested
    let totalCount: number | undefined;
    if (include_count === 'true') {
      let countQuery = supabase.from('post_public_view').select('*', { count: 'exact', head: true });

      if (type === 'public') {
        countQuery = countQuery.eq('item_type', 'found').in('post_status', ['accepted', 'reported']);
      } else if (type === 'pending') {
        countQuery = countQuery.eq('post_status', 'pending');
      } else if (type === 'own' && poster_id) {
        countQuery = countQuery.eq('poster_id', poster_id);
      }
      if (item_type) {
        countQuery = countQuery.eq('item_type', item_type);
      }
      if (status) {
        countQuery = countQuery.eq('post_status', status);
      }

      const { count, error: countError } = await countQuery;
      if (!countError) {
        totalCount = count || 0;
      }
    }

    return { posts: posts || [], count: totalCount || posts?.length };
  });

  // GET /posts/public - List all public posts (kept for backward compatibility)
  server.get('/public', async (): Promise<PostListResponse> => {
    const supabase = getSupabaseClient();

    const { data: posts, error } = await supabase
      .from('post_public_view')
      .select('*')
      .order('submission_date', { ascending: false });

    if (error) {
      logger.error({ error }, 'Failed to fetch posts');
      throw new Error('Failed to fetch posts');
    }

    return { posts: posts || [], count: posts?.length };
  });

  // GET /posts/count - Get total posts count with filters
  server.get<{
    Querystring: {
      type?: 'public' | 'pending' | 'staff' | 'own';
      item_type?: 'found' | 'missing';
      status?: string;
      poster_id?: string;
    };
  }>('/count', async (request) => {
    const supabase = getSupabaseClient();
    const { type, item_type, status, poster_id } = request.query;

    let query = supabase.from('post_public_view').select('*', { count: 'exact', head: true });

    if (type === 'public') {
      query = query.eq('item_type', 'found').in('post_status', ['accepted', 'reported']);
    } else if (type === 'pending') {
      query = query.eq('post_status', 'pending');
    } else if (type === 'own' && poster_id) {
      query = query.eq('poster_id', poster_id);
    }

    if (item_type) {
      query = query.eq('item_type', item_type);
    }
    if (status) {
      query = query.eq('post_status', status);
    }

    const { count, error } = await query;

    if (error) {
      logger.error({ error }, 'Failed to fetch post count');
      throw new Error('Failed to fetch post count');
    }

    return { count: count || 0 };
  });

  // GET /posts/by-item/:itemId - Get post by item ID
  server.get<{ Params: { itemId: string } }>('/by-item/:itemId', async (request) => {
    const supabase = getSupabaseClient();
    const itemId = request.params.itemId;

    const { data: post, error } = await supabase
      .from('post_public_view')
      .select('*')
      .eq('item_id', itemId)
      .single();

    if (error || !post) {
      logger.error({ error, itemId }, 'Failed to fetch post by item_id');
      throw new Error('Post not found');
    }

    return post;
  });

  // GET /posts/by-item-details/:itemId - Get post record by item ID (from details view)
  server.get<{ Params: { itemId: string } }>('/by-item-details/:itemId', async (request) => {
    const supabase = getSupabaseClient();
    const itemId = request.params.itemId;

    const { data: post, error } = await supabase
      .from('v_post_records_details')
      .select('*')
      .eq('item_id', itemId)
      .single();

    if (error || !post) {
      logger.error({ error, itemId }, 'Failed to fetch post record by item_id');
      throw new Error('Post not found');
    }

    return post;
  });

  // GET /posts/:id - Get single post detail
  server.get<{ Params: { id: string } }>('/:id', async (request): Promise<PostRecord> => {
    const supabase = getSupabaseClient();
    const postId = parseInt(request.params.id, 10);

    const { data: post, error } = await supabase
      .from('post_public_view')
      .select('*')
      .eq('post_id', postId)
      .single();

    if (error || !post) {
      logger.error({ error, postId }, 'Failed to fetch post');
      throw new Error('Post not found');
    }

    return post;
  });

  // GET /posts/:id/full - Get full post details (staff only)
  server.get<{ Params: { id: string } }>(
    '/:id/full',
    {
      preHandler: [requireStaff],
    },
    async (request) => {
      const supabase = getSupabaseClient();
      const postId = parseInt(request.params.id, 10);

      const { data: post, error } = await supabase
        .from('v_post_records_details')
        .select('*')
        .eq('post_id', postId)
        .single();

      if (error || !post) {
        logger.error({ error, postId }, 'Failed to fetch full post');
        throw new Error('Post not found');
      }

      return post;
    }
  );

  // POST /posts - Create new post
  server.post<{ Body: CreatePostRequest }>(
    '/',
    {
      preHandler: [requireAuth],
    },
    async (request) => {
      const supabase = getSupabaseClient();
      const body = request.body;

      const { data, error } = await supabase.rpc('create_post_with_item_date_time_location', {
        p_item_name: body.p_item_name,
        p_item_description: body.p_item_description,
        p_item_type: body.p_item_type,
        p_poster_id: body.p_poster_id,
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
    },
    async (request) => {
      const supabase = getSupabaseClient();
      const postId = parseInt(request.params.id, 10);
      const body = request.body;

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

  // PUT /posts/:id/status - Update post status
  server.put<{ Params: { id: string }; Body: UpdatePostStatusRequest }>(
    '/:id/status',
    {
      preHandler: [requireStaff],
    },
    async (request) => {
      const supabase = getSupabaseClient();
      const postId = parseInt(request.params.id, 10);
      const { status, rejection_reason } = request.body;

      const updateData: { post_status: string; rejection_reason?: string } = {
        post_status: status,
      };

      if (rejection_reason) {
        updateData.rejection_reason = rejection_reason;
      }

      const { error } = await supabase.from('post_table').update(updateData).eq('post_id', postId);

      if (error) {
        logger.error({ error, postId }, 'Failed to update post status');
        throw new Error(error.message || 'Failed to update post status');
      }

      logger.info({ postId, status }, 'Post status updated');
      return { success: true };
    }
  );

  // PUT /posts/:id/staff-assignment - Update accepted_by_staff_id
  server.put<{ Params: { id: string }; Body: { staff_id: string } }>(
    '/:id/staff-assignment',
    {
      preHandler: [requireStaff],
    },
    async (request) => {
      const supabase = getSupabaseClient();
      const postId = parseInt(request.params.id, 10);
      const { staff_id } = request.body;

      const { error } = await supabase
        .from('post_table')
        .update({ accepted_by_staff_id: staff_id })
        .eq('post_id', postId);

      if (error) {
        logger.error({ error, postId }, 'Failed to update staff assignment');
        throw new Error(error.message || 'Failed to update staff assignment');
      }

      logger.info({ postId, staff_id }, 'Post staff assignment updated');
      return { success: true };
    }
  );

  // GET /posts/user/:userId - Get user's posts (authenticated)
  server.get<{ Params: { userId: string } }>(
    '/user/:userId',
    {
      preHandler: [requireAuth],
    },
    async (request): Promise<PostListResponse> => {
      const supabase = getSupabaseClient();
      const userId = request.params.userId;

      // Ensure user can only fetch their own posts unless they're staff
      if (request.user?.user_id !== userId && request.user?.user_type === 'User') {
        throw new Error('Unauthorized');
      }

      const { data: posts, error } = await supabase
        .from('post_public_view')
        .select('*')
        .eq('poster_id', userId)
        .order('submission_date', { ascending: false });

      if (error) {
        logger.error({ error, userId }, 'Failed to fetch user posts');
        throw new Error('Failed to fetch posts');
      }

      return { posts: posts || [], count: posts?.length };
    }
  );

  // PUT /items/:id/status - Update item status
  server.put<{ Params: { id: string }; Body: UpdateItemStatusRequest }>(
    '/items/:id/status',
    {
      preHandler: [requireStaff],
    },
    async (request) => {
      const supabase = getSupabaseClient();
      const itemId = request.params.id;
      const { status } = request.body;

      const { error } = await supabase
        .from('item_table')
        .update({ item_status: status })
        .eq('item_id', itemId);

      if (error) {
        logger.error({ error, itemId }, 'Failed to update item status');
        throw new Error(error.message || 'Failed to update item status');
      }

      logger.info({ itemId, status }, 'Item status updated');
      return { success: true };
    }
  );

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
