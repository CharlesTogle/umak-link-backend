import { FastifyInstance } from 'fastify';
import { getSupabaseClient } from '../../services/supabase.js';
import { isStaffOrAdmin, requireAuth, syncAuthoritativeUser } from '../../middleware/auth.js';
import { canGuardAccessClaimReview } from '../../services/claim-verification.js';
import type { CustodyStatus } from '../../types/custody.js';
import { PostListResponse, PostRecord } from '../../types/posts.js';
import { createHttpError } from '../../utils/http-error.js';
import logger from '../../utils/logger.js';
import { parsePagination } from '../../utils/pagination.js';

type SupabaseClientLike = ReturnType<typeof getSupabaseClient>;

interface AttemptCustodyStatusRow {
  post_id: number | string | null;
  attempt_number?: number | null;
  office_received_at?: string | null;
  investigation_opened_at?: string | null;
}

function canDeriveGuardCustodyStatus(custodyStatus: string | null | undefined): boolean {
  return (
    custodyStatus === null ||
    custodyStatus === undefined ||
    custodyStatus === 'untracked' ||
    custodyStatus === 'with_reporter' ||
    custodyStatus === 'handover_in_progress' ||
    custodyStatus === 'with_guard'
  );
}

function deriveGuardCustodyStatusFromAttempt(
  attempt: AttemptCustodyStatusRow | null | undefined
): CustodyStatus | null {
  if (!attempt) return null;
  if (attempt.investigation_opened_at) return 'under_investigation';
  if (attempt.office_received_at) return 'in_security_office';
  return null;
}

function normalizePostId(value: number | string | null | undefined): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    return Number.isNaN(parsed) ? null : parsed;
  }

  return null;
}

function normalizeClaimedCustodyStatus<T extends { item_status?: string | null; custody_status?: string | null }>(
  post: T
): T {
  if ((post.item_status ?? '').toLowerCase() !== 'claimed') {
    return post;
  }

  if (
    post.custody_status === 'claimed_by_student' ||
    post.custody_status === 'in_security_office' ||
    post.custody_status === 'under_investigation'
  ) {
    return post;
  }

  return {
    ...post,
    custody_status: 'claimed_by_student',
  };
}

function normalizeClaimedCustodyStatuses<T extends { item_status?: string | null; custody_status?: string | null }>(
  posts: T[]
): T[] {
  return posts.map((post) => normalizeClaimedCustodyStatus(post));
}

export interface PostsReadRouteOptions {
  getSupabase?: () => SupabaseClientLike;
  canGuardAccessClaimReview?: typeof canGuardAccessClaimReview;
}

function isNoRowsError(error: { code?: string } | null | undefined): boolean {
  return error?.code === 'PGRST116';
}

async function attachPosterProfileUrls<T extends { poster_id?: string | null }>(
  supabase: SupabaseClientLike,
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

async function getLatestAttemptCustodyStatuses(
  supabase: SupabaseClientLike,
  postIds: number[]
): Promise<Map<number, AttemptCustodyStatusRow>> {
  if (postIds.length === 0) return new Map();

  const { data, error } = await supabase
    .from('custody_attempt_table')
    .select('post_id, attempt_number, office_received_at, investigation_opened_at')
    .in('post_id', postIds)
    .order('attempt_number', { ascending: false });

  if (error || !data) {
    logger.error({ error, postIds }, 'Failed to derive custody statuses from latest attempts');
    return new Map();
  }

  const latestByPostId = new Map<number, AttemptCustodyStatusRow>();

  for (const row of data as AttemptCustodyStatusRow[]) {
    const postId = normalizePostId(row.post_id);
    if (!postId || latestByPostId.has(postId)) continue;
    latestByPostId.set(postId, row);
  }

  return latestByPostId;
}

async function attachDerivedGuardCustodyStatuses<
  T extends { post_id?: number | string | null; item_type?: string | null; custody_status?: string | null },
>(supabase: SupabaseClientLike, posts: T[]): Promise<T[]> {
  const postIds = Array.from(
    new Set(
      posts
        .filter((post) => post.item_type === 'found' && canDeriveGuardCustodyStatus(post.custody_status))
        .map((post) => normalizePostId(post.post_id))
        .filter((postId): postId is number => postId !== null)
    )
  );

  if (postIds.length === 0) return posts;

  const latestByPostId = await getLatestAttemptCustodyStatuses(supabase, postIds);

  return posts.map((post) => {
    if (post.item_type !== 'found' || !canDeriveGuardCustodyStatus(post.custody_status)) {
      return post;
    }

    const postId = normalizePostId(post.post_id);
    if (!postId) return post;

    const derivedCustodyStatus = deriveGuardCustodyStatusFromAttempt(latestByPostId.get(postId));
    if (!derivedCustodyStatus || derivedCustodyStatus === post.custody_status) {
      return post;
    }

    return {
      ...post,
      custody_status: derivedCustodyStatus,
    };
  });
}

async function getUnderInvestigationPostIds(supabase: SupabaseClientLike): Promise<number[]> {
  const [{ data: persistedPosts, error: persistedError }, { data: investigationAttempts, error: attemptError }] =
    await Promise.all([
      supabase.from('post_public_view').select('post_id').eq('custody_status', 'under_investigation'),
      supabase
        .from('custody_attempt_table')
        .select('post_id, attempt_number, office_received_at, investigation_opened_at')
        .not('investigation_opened_at', 'is', null)
        .order('attempt_number', { ascending: false }),
    ]);

  if (persistedError) {
    logger.error({ error: persistedError }, 'Failed to fetch persisted under-investigation posts');
    throw new Error('Failed to fetch posts');
  }

  if (attemptError) {
    logger.error({ error: attemptError }, 'Failed to derive under-investigation posts from custody attempts');
    throw new Error('Failed to fetch posts');
  }

  const postIds = new Set<number>(
    (persistedPosts ?? [])
      .map((post) => normalizePostId((post as { post_id?: number | string | null }).post_id))
      .filter((postId): postId is number => postId !== null)
  );

  const staleAttemptIds: number[] = [];
  const seenAttemptPostIds = new Set<number>();

  for (const attempt of (investigationAttempts ?? []) as AttemptCustodyStatusRow[]) {
    const postId = normalizePostId(attempt.post_id);
    if (!postId || seenAttemptPostIds.has(postId)) continue;
    seenAttemptPostIds.add(postId);

    const derivedCustodyStatus = deriveGuardCustodyStatusFromAttempt(attempt);
    if (derivedCustodyStatus === 'under_investigation') {
      staleAttemptIds.push(postId);
    }
  }

  if (staleAttemptIds.length === 0) {
    return Array.from(postIds);
  }

  const { data: stalePosts, error: stalePostsError } = await supabase
    .from('post_public_view')
    .select('post_id, item_type, custody_status')
    .in('post_id', staleAttemptIds);

  if (stalePostsError) {
    logger.error(
      { error: stalePostsError, postIds: staleAttemptIds },
      'Failed to fetch stale under-investigation post candidates'
    );
    throw new Error('Failed to fetch posts');
  }

  for (const post of stalePosts ?? []) {
    const typedPost = post as { post_id?: number | string | null; item_type?: string | null; custody_status?: string | null };
    const postId = normalizePostId(typedPost.post_id);
    if (!postId) continue;
    if (typedPost.item_type !== 'found') continue;
    if (!canDeriveGuardCustodyStatus(typedPost.custody_status)) continue;
    postIds.add(postId);
  }

  return Array.from(postIds);
}

async function getPostAccessRecord(supabase: SupabaseClientLike, postId: number) {
  const { data, error } = await supabase
    .from('post_public_view')
    .select('poster_id')
    .eq('post_id', postId)
    .single();

  if (error || !data) {
    logger.error({ error, postId }, 'Failed to fetch post access record');
    throw createHttpError('Post not found', 404);
  }

  return data;
}

async function attachAcceptedGuardDetails<
  T extends { post_id?: number | string | null; custody_status?: string | null },
>(
  supabase: SupabaseClientLike,
  post: T
): Promise<T & { accepted_by_guard_name?: string | null; accepted_by_guard_email?: string | null }> {
  if (post.custody_status !== 'with_guard') {
    return post;
  }

  const normalizedPostId =
    typeof post.post_id === 'string' ? Number.parseInt(post.post_id, 10) : post.post_id;

  if (!normalizedPostId || Number.isNaN(normalizedPostId)) {
    return {
      ...post,
      accepted_by_guard_name: null,
      accepted_by_guard_email: null,
    };
  }

  const { data: acceptedAttempt, error: acceptedAttemptError } = await supabase
    .from('custody_attempt_table')
    .select('decision_by_guard_id')
    .eq('post_id', normalizedPostId)
    .eq('status', 'accepted')
    .order('attempt_number', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (acceptedAttemptError && !isNoRowsError(acceptedAttemptError)) {
    logger.error(
      { error: acceptedAttemptError, postId: normalizedPostId },
      'Failed to fetch accepted guard for post details'
    );
    return {
      ...post,
      accepted_by_guard_name: null,
      accepted_by_guard_email: null,
    };
  }

  if (!acceptedAttempt?.decision_by_guard_id) {
    return {
      ...post,
      accepted_by_guard_name: null,
      accepted_by_guard_email: null,
    };
  }

  const { data: guardUser, error: guardUserError } = await supabase
    .from('user_table')
    .select('user_id, user_name, email')
    .eq('user_id', acceptedAttempt.decision_by_guard_id)
    .maybeSingle();

  if (guardUserError && !isNoRowsError(guardUserError)) {
    logger.error(
      {
        error: guardUserError,
        postId: normalizedPostId,
        guardUserId: acceptedAttempt.decision_by_guard_id,
      },
      'Failed to fetch accepted guard identity for post details'
    );
    return {
      ...post,
      accepted_by_guard_name: null,
      accepted_by_guard_email: null,
    };
  }

  return {
    ...post,
    accepted_by_guard_name: guardUser?.user_name ?? null,
    accepted_by_guard_email: guardUser?.email ?? null,
  };
}

export default async function postsReadRoutes(
  server: FastifyInstance,
  options: PostsReadRouteOptions = {}
) {
  const getSupabase = options.getSupabase ?? getSupabaseClient;
  const canGuardAccess = options.canGuardAccessClaimReview ?? canGuardAccessClaimReview;

  // GET /posts - Comprehensive post listing with filtering
  server.get<{
    Querystring: {
      type?: 'public' | 'pending' | 'staff' | 'own';
      item_type?: 'found' | 'missing';
      status?: string;
      item_status?: string;
      custody_status?: CustodyStatus;
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
    const supabase = getSupabase();
    const {
      type,
      item_type,
      status,
      item_status,
      custody_status,
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
    const underInvestigationPostIds =
      custody_status === 'under_investigation' ? await getUnderInvestigationPostIds(supabase) : null;

    let query = supabase.from('post_public_view').select('*');

    // Apply filters based on type
    if (type === 'public') {
      query = query
        .eq('item_type', 'found')
        .in('post_status', ['accepted', 'reported'])
        .eq('item_status', 'claimed');
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
    if (custody_status === 'under_investigation') {
      if (underInvestigationPostIds && underInvestigationPostIds.length > 0) {
        query = query.in('post_id', underInvestigationPostIds);
      } else {
        return { posts: [], count: 0 };
      }
    } else if (custody_status) {
      query = query.eq('custody_status', custody_status);
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

      const normalizedLinkedPosts = normalizeClaimedCustodyStatuses(linkedData || []);
      return { posts: normalizedLinkedPosts, count: normalizedLinkedPosts.length };
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
        countQuery = countQuery
          .eq('item_type', 'found')
          .in('post_status', ['accepted', 'reported'])
          .eq('item_status', 'claimed');
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
      if (custody_status === 'under_investigation') {
        if (underInvestigationPostIds && underInvestigationPostIds.length > 0) {
          countQuery = countQuery.in('post_id', underInvestigationPostIds);
        } else {
          totalCount = 0;
        }
      } else if (custody_status) {
        countQuery = countQuery.eq('custody_status', custody_status);
      }

      if (totalCount === undefined) {
        const { count, error: countError } = await countQuery;
        if (!countError) {
          totalCount = count || 0;
        }
      }
    }

    const enrichedPosts = await attachPosterProfileUrls(supabase, posts || []);
    const postsWithDerivedCustody = await attachDerivedGuardCustodyStatuses(supabase, enrichedPosts || []);
    const normalizedPosts = normalizeClaimedCustodyStatuses(postsWithDerivedCustody || []);
    const filteredPosts =
      custody_status === 'under_investigation'
        ? normalizedPosts.filter((post) => post.custody_status === 'under_investigation')
        : normalizedPosts;
    return { posts: filteredPosts, count: totalCount ?? filteredPosts.length };
  });

  // GET /posts/public - List all public posts (kept for backward compatibility)
  server.get('/public', async (): Promise<PostListResponse> => {
    const supabase = getSupabase();

    const { data: posts, error } = await supabase
      .from('post_public_view')
      .select('*')
      .eq('item_type', 'found')
      .in('post_status', ['accepted', 'reported'])
      .eq('item_status', 'claimed')
      .order('submission_date', { ascending: false });

    if (error) {
      logger.error({ error }, 'Failed to fetch posts');
      throw new Error('Failed to fetch posts');
    }

    const enrichedPosts = await attachPosterProfileUrls(supabase, posts || []);
    const postsWithDerivedCustody = await attachDerivedGuardCustodyStatuses(supabase, enrichedPosts || []);
    const normalizedPosts = normalizeClaimedCustodyStatuses(postsWithDerivedCustody || []);
    return { posts: normalizedPosts, count: normalizedPosts.length };
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
    const supabase = getSupabase();
    const { type, item_type, status, item_status, poster_id } = request.query;

    let query = supabase.from('post_public_view').select('*', { count: 'exact', head: true });

    if (type === 'public') {
      query = query
        .eq('item_type', 'found')
        .in('post_status', ['accepted', 'reported'])
        .eq('item_status', 'claimed');
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
    const supabase = getSupabase();
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
    const [withDerivedCustody] = await attachDerivedGuardCustodyStatuses(supabase, enriched ? [enriched] : [post]);
    return normalizeClaimedCustodyStatus(withDerivedCustody ?? enriched ?? post);
  });

  // GET /posts/by-item-details/:itemId - Get post record by item ID (from details view)
  server.get<{ Params: { itemId: string } }>('/by-item-details/:itemId', async (request) => {
    const supabase = getSupabase();
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
    const [withDerivedCustody] = await attachDerivedGuardCustodyStatuses(supabase, enriched ? [enriched] : [post]);
    return normalizeClaimedCustodyStatus(withDerivedCustody ?? enriched ?? post);
  });

  // GET /posts/:id - Get single post detail
  server.get<{ Params: { id: string } }>('/:id', async (request): Promise<PostRecord> => {
    const supabase = getSupabase();
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
    const [withDerivedCustody] = await attachDerivedGuardCustodyStatuses(supabase, enriched ? [enriched] : [post]);
    return normalizeClaimedCustodyStatus(withDerivedCustody ?? enriched ?? post);
  });

  // GET /posts/:id/full - Get full post details (staff/admin, post owner, or accepted guard)
  server.get<{ Params: { id: string } }>(
    '/:id/full',
    {
      preHandler: [requireAuth],
    },
    async (request) => {
      const supabase = getSupabase();
      const postId = parseInt(request.params.id, 10);

      if (!request.user) {
        throw createHttpError('Unauthorized', 401);
      }

      const isSynced = await syncAuthoritativeUser(request);
      if (!isSynced || !request.user) {
        throw createHttpError('Session validation failed', 401);
      }

      if (!isStaffOrAdmin(request.user.user_type)) {
        if (request.user.user_type === 'Guard') {
          const canAccess = await canGuardAccess(postId, request.user.user_id);
          if (!canAccess) {
            throw createHttpError('Forbidden', 403);
          }
        } else {
          const postAccessRecord = await getPostAccessRecord(supabase, postId);
          if (postAccessRecord.poster_id !== request.user.user_id) {
            throw createHttpError('Forbidden', 403);
          }
        }
      }

      const { data: post, error } = await supabase
        .from('v_post_records_details')
        .select('*')
        .eq('post_id', postId)
        .single();

      if (error || !post) {
        logger.error({ error, postId }, 'Failed to fetch full post');
        throw new Error('Post not found');
      }

      const [withDerivedCustody] = await attachDerivedGuardCustodyStatuses(supabase, post ? [post] : []);
      const normalizedPost = normalizeClaimedCustodyStatus(withDerivedCustody ?? post);
      return attachAcceptedGuardDetails(supabase, normalizedPost);
    }
  );

  // GET /posts/user/:userId - Get user's posts (authenticated)
  server.get<{ Params: { userId: string } }>(
    '/user/:userId',
    {
      preHandler: [requireAuth],
    },
    async (request): Promise<PostListResponse> => {
      const supabase = getSupabase();
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

      const postsWithDerivedCustody = await attachDerivedGuardCustodyStatuses(supabase, posts || []);
      const normalizedPosts = normalizeClaimedCustodyStatuses(postsWithDerivedCustody || []);
      return { posts: normalizedPosts, count: normalizedPosts.length };
    }
  );
}
