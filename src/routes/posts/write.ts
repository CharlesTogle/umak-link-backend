import { FastifyInstance } from 'fastify';
import { getSupabaseClient } from '../../services/supabase.js';
import { requireAuth } from '../../middleware/auth.js';
import { CreatePostRequest, EditPostRequest } from '../../types/posts.js';
import logger from '../../utils/logger.js';
import { logAudit, getUserName } from '../../utils/audit-logger.js';

type SupabaseClientLike = ReturnType<typeof getSupabaseClient>;

function createHttpError(message: string, statusCode: number): Error & { statusCode: number } {
  const error = new Error(message) as Error & { statusCode: number };
  error.statusCode = statusCode;
  return error;
}

function buildPlaceholderImageHash(params: { posterId: string; itemType: string; itemName: string }) {
  return `no-image:${params.posterId}:${params.itemType}:${params.itemName.trim().toLowerCase()}`;
}

async function getPostAccessRecord(supabase: ReturnType<typeof getSupabaseClient>, postId: number) {
  const { data, error } = await supabase
    .from('post_public_view')
    .select('poster_id, post_status, item_status, item_id, item_name, poster_name')
    .eq('post_id', postId)
    .single();

  if (error || !data) {
    logger.error({ error, postId }, 'Failed to fetch post access record');
    throw createHttpError('Post not found', 404);
  }

  return data;
}

function resolveCreatedPostId(data: unknown): number {
  if (typeof data === 'number' && Number.isFinite(data)) {
    return data;
  }

  if (Array.isArray(data) && data.length > 0) {
    const candidate = data[0] as { out_post_id?: unknown } | undefined;
    if (typeof candidate?.out_post_id === 'number' && Number.isFinite(candidate.out_post_id)) {
      return candidate.out_post_id;
    }
  }

  if (data && typeof data === 'object') {
    const candidate = data as { out_post_id?: unknown; post_id?: unknown };
    if (typeof candidate.out_post_id === 'number' && Number.isFinite(candidate.out_post_id)) {
      return candidate.out_post_id;
    }

    if (typeof candidate.post_id === 'number' && Number.isFinite(candidate.post_id)) {
      return candidate.post_id;
    }
  }

  throw new Error('Unexpected create_post_with_item_date_time_location response');
}

async function syncFoundPostCustodyStatus(
  supabase: SupabaseClientLike,
  params: {
    postId: number;
    actorUserId: string;
    actorUserType: string;
  }
): Promise<void> {
  const { postId, actorUserId, actorUserType } = params;
  const { data: postRecord, error: postError } = await supabase
    .from('post_public_view')
    .select('post_id, item_id, item_type')
    .eq('post_id', postId)
    .single();

  if (postError || !postRecord) {
    logger.error({ error: postError, postId }, 'Failed to fetch post for initial custody status sync');
    throw new Error('Failed to create post');
  }

  if (postRecord.item_type !== 'found') {
    return;
  }

  if (actorUserType === 'Staff') {
    const officeReceivedAt = new Date().toISOString();
    const { error: insertError } = await supabase.from('custody_record_table').insert({
      post_id: postId,
      item_id: postRecord.item_id,
      custody_attempt_id: null,
      qr_code_session_id: null,
      guard_post_id: null,
      actor_user_id: actorUserId,
      record_type: 'security_office_received',
      visible_to_poster: true,
      details: {
        source: 'staff_created_post',
      },
      occurred_at: officeReceivedAt,
    });

    if (insertError) {
      logger.error(
        { error: insertError, postId, itemId: postRecord.item_id, actorUserId },
        'Failed to create initial security office custody record for staff-created found post'
      );
      throw new Error('Failed to create post');
    }

    return;
  }

  const { error: recomputeError } = await supabase.rpc('recompute_item_custody_status', {
    p_post_id: postId,
    p_item_id: postRecord.item_id,
  });

  if (recomputeError) {
    logger.error(
      { error: recomputeError, postId, itemId: postRecord.item_id },
      'Failed to sync initial custody status for found post'
    );
    throw new Error('Failed to create post');
  }
}

function assertUserOwnsPost(post: { poster_id: string | null }, userId: string) {
  if (post.poster_id !== userId) {
    throw createHttpError('Unauthorized', 403);
  }
}

function assertUserCanEditPost(post: { post_status: string | null }) {
  if (post.post_status !== 'pending') {
    throw createHttpError('Users can only edit pending posts', 403);
  }
}

function assertUserCanDeletePost(post: { post_status: string | null; item_status: string | null }) {
  const canDelete =
    post.item_status === 'unclaimed' ||
    post.item_status === 'lost' ||
    post.post_status === 'pending' ||
    post.post_status === 'rejected';

  if (!canDelete || post.post_status === 'accepted') {
    throw createHttpError('Users can only delete pending or rejected posts with unclaimed or lost items', 403);
  }
}

export interface PostsWriteRouteOptions {
  getSupabase?: () => SupabaseClientLike;
}

export default async function postsWriteRoutes(
  server: FastifyInstance,
  options: PostsWriteRouteOptions = {}
) {
  const getSupabase = options.getSupabase ?? getSupabaseClient;

  // POST /posts - Create new post
  server.post<{ Body: CreatePostRequest }>(
    '/',
    {
      preHandler: [requireAuth],
      schema: {
        body: {
          type: 'object',
          required: [
            'p_item_name',
            'p_item_type',
            'p_image_link',
            'p_last_seen_date',
            'p_last_seen_hours',
            'p_last_seen_minutes',
            'p_location_path',
          ],
          properties: {
            p_item_name: { type: 'string', minLength: 1 },
            p_item_description: { type: 'string' },
            p_item_type: { type: 'string', enum: ['found', 'lost', 'missing'] },
            p_poster_id: { type: 'string' },
            p_image_hash: { type: ['string', 'null'] },
            p_image_link: { type: 'string', minLength: 1 },
            p_category: { type: 'string' },
            p_last_seen_date: { type: 'string', minLength: 1 },
            p_last_seen_hours: { type: 'number' },
            p_last_seen_minutes: { type: 'number' },
            p_item_status: {
              type: 'string',
              enum: ['claimed', 'unclaimed', 'discarded', 'returned', 'lost'],
            },
            p_post_status: {
              type: 'string',
              enum: ['pending', 'accepted', 'rejected', 'archived', 'deleted', 'reported', 'fraud'],
            },
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
      const supabase = getSupabase();
      const body = request.body;
      const posterId = request.user?.user_id;

      if (!posterId) {
        throw createHttpError('Unauthorized', 401);
      }

      const imageHash =
        typeof body.p_image_hash === 'string' && body.p_image_hash.trim().length > 0
          ? body.p_image_hash
          : buildPlaceholderImageHash({
              posterId,
              itemType: body.p_item_type,
              itemName: body.p_item_name,
            });
      const itemStatus =
        body.p_item_status ?? (body.p_item_type === 'found' ? 'unclaimed' : 'lost');
      const postStatus = body.p_post_status ?? 'pending';

      const { data, error } = await supabase.rpc('create_post_with_item_date_time_location', {
        p_item_name: body.p_item_name,
        p_item_description: body.p_item_description,
        p_item_type: body.p_item_type,
        p_poster_id: posterId,
        p_image_hash: imageHash,
        p_image_link: body.p_image_link,
        p_category: body.p_category,
        p_last_seen_date: body.p_last_seen_date,
        p_last_seen_hours: body.p_last_seen_hours,
        p_last_seen_minutes: body.p_last_seen_minutes,
        p_item_status: itemStatus,
        p_post_status: postStatus,
        p_location_path: body.p_location_path,
        p_is_anonymous: body.p_is_anonymous,
      });

      if (error) {
        logger.error({ error }, 'Failed to create post');
        throw new Error(error.message || 'Failed to create post');
      }

      const postId = resolveCreatedPostId(data);
      if (body.p_item_type === 'found') {
        await syncFoundPostCustodyStatus(supabase, {
          postId,
          actorUserId: posterId,
          actorUserType: request.user?.user_type ?? 'User',
        });
      }

      logger.info({ postId }, 'Post created');
      return { post_id: postId };
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
      const supabase = getSupabase();
      const postId = parseInt(request.params.id, 10);
      const body = request.body;
      const userId = request.user?.user_id;

      if (!userId) {
        throw createHttpError('Unauthorized', 401);
      }

      if (request.user?.user_type === 'User') {
        const postRecord = await getPostAccessRecord(supabase, postId);
        assertUserOwnsPost(postRecord, userId);
        assertUserCanEditPost(postRecord);
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
      const supabase = getSupabase();
      const postId = parseInt(request.params.id, 10);
      const userId = request.user?.user_id;

      if (!userId) {
        throw createHttpError('Unauthorized', 401);
      }

      const postRecord = await getPostAccessRecord(supabase, postId);

      if (request.user?.user_type === 'User') {
        assertUserOwnsPost(postRecord, userId);
        assertUserCanDeletePost(postRecord);
      }

      // Get post details before deletion for audit log
      const postData = postRecord;

      const { error } = await supabase.rpc('delete_post_by_id', {
        p_post_id: postId,
      });

      if (error) {
        logger.error({ error, postId }, 'Failed to delete post');
        throw new Error(error.message || 'Failed to delete post');
      }

      // Log to audit trail if deleted by staff
      if (userId && request.user?.user_type && ['Staff', 'Admin'].includes(request.user.user_type)) {
        const staffName = await getUserName(userId);
        const itemName = postData?.item_name || 'Unknown Item';

        await logAudit({
          userId,
          actionType: 'post_deleted',
          details: {
            message: `${staffName} deleted the post ${itemName}`,
            post_id: postId.toString(),
            item_name: itemName,
            deleted_at: new Date().toISOString(),
          },
          recordId: postId.toString(),
        });
      }

      logger.info({ postId }, 'Post deleted');
      return { success: true };
    }
  );
}
