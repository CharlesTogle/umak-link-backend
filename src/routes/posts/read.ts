import { FastifyInstance } from 'fastify';
import { getSupabaseClient } from '../../services/supabase.js';
import { requireAuth, requireStaff } from '../../middleware/auth.js';
import { PostListResponse, PostRecord } from '../../types/posts.js';
import logger from '../../utils/logger.js';
import { parsePagination } from '../../utils/pagination.js';

async function attachPosterProfileUrls<T extends { poster_id?: string | null }>(
  supabase: ReturnType<typeof getSupabaseClient>,
  posts: T[]
): Promise<Array<T & { poster_profile_picture_url?: string | null }>> {
  const posterIds = Array.from(
    new Set(posts.map((post) => post.poster_id).filter((id): id is string => Boolean(id)))
  );

  if (posterIds.length === 0) return posts;

  const { data, error } = await supabase
    .from('user_table')
    .select('user_id, profile_picture_url')
    .in('user_id', posterIds);

  if (error || !data) {
    logger.error({ error }, 'Failed to fetch poster profile pictures');
    return posts;
  }

  const profileMap = new Map(data.map((user) => [user.user_id, user.profile_picture_url]));

  return posts.map((post) => ({
    ...post,
    poster_profile_picture_url: post.poster_id ? profileMap.get(post.poster_id) ?? null : null,
  }));
}

export default async function postsReadRoutes(server: FastifyInstance) {
  // GET /posts - Comprehensive post listing with filtering
  server.get<{
    Querystring: {
      type?: 'public' | 'pending' | 'staff' | 'own';
      item_type?: 'found' | 'missing';
      status?: string;
      item_status?: string;
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
      item_status,
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

    const { limit: limitNum, offset: offsetNum } = parsePagination(limit, offset);

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
    if (item_status) {
      query = query.eq('item_status', item_status);
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
      if (item_status) {
        countQuery = countQuery.eq('item_status', item_status);
      }

      const { count, error: countError } = await countQuery;
      if (!countError) {
        totalCount = count || 0;
      }
    }

    const enrichedPosts = await attachPosterProfileUrls(supabase, posts || []);
    return { posts: enrichedPosts || [], count: totalCount || posts?.length };
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

    const enrichedPosts = await attachPosterProfileUrls(supabase, posts || []);
    return { posts: enrichedPosts || [], count: posts?.length };
  });

  // GET /posts/count - Get total posts count with filters
  server.get<{
    Querystring: {
      type?: 'public' | 'pending' | 'staff' | 'own';
      item_type?: 'found' | 'missing';
      status?: string;
      item_status?: string;
      poster_id?: string;
    };
  }>('/count', async (request) => {
    const supabase = getSupabaseClient();
    const { type, item_type, status, item_status, poster_id } = request.query;

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
    if (item_status) {
      query = query.eq('item_status', item_status);
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

    const [enriched] = await attachPosterProfileUrls(supabase, post ? [post] : []);
    return enriched ?? post;
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

    const [enriched] = await attachPosterProfileUrls(supabase, post ? [post] : []);
    return enriched ?? post;
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

    const [enriched] = await attachPosterProfileUrls(supabase, post ? [post] : []);
    return enriched ?? post;
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
}
