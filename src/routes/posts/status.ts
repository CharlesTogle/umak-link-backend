import { FastifyInstance } from 'fastify';
import { getSupabaseClient } from '../../services/supabase.js';
import { requireStaff } from '../../middleware/auth.js';
import { UpdatePostStatusRequest, UpdateItemStatusRequest } from '../../types/posts.js';
import logger from '../../utils/logger.js';
import { logAudit, getUserName } from '../../utils/audit-logger.js';
import { createHttpError, normalizeUpstreamError } from '../../utils/http-error.js';

type SupabaseClientLike = ReturnType<typeof getSupabaseClient>;

interface ItemStatusRouteRow {
  post_id: number;
  item_id: string;
  item_name: string | null;
  item_type: string | null;
  poster_id: string | null;
  item_status: string | null;
  custody_status: string | null;
}

interface DiscardFoundItemRow {
  post_id: number;
  item_id: string;
  item_name: string | null;
  previous_item_status: string | null;
  previous_custody_status: string | null;
  discarded_reason: string;
  discarded_at: string;
  item_discard_id: string;
  custody_record_id: string;
}

export interface PostsStatusRouteOptions {
  getSupabase?: () => SupabaseClientLike;
  auditLogger?: typeof logAudit;
  getAuditUserName?: typeof getUserName;
}

function normalizeDiscardReason(reason: string | undefined): string | null {
  if (typeof reason !== 'string') return null;
  const trimmedReason = reason.trim();
  return trimmedReason.length > 0 ? trimmedReason : null;
}

async function recomputeFoundItemCustodyStatus(
  supabase: SupabaseClientLike,
  postId: number,
  itemId: string
): Promise<string | null> {
  const { data, error } = await supabase.rpc('recompute_item_custody_status', {
    p_post_id: postId,
    p_item_id: itemId,
  });

  if (error) {
    logger.error({ error, postId, itemId }, 'Failed to recompute item custody status');
    throw normalizeUpstreamError(error, {
      statusCode: 500,
      message: 'Failed to update item custody status',
      code: 'ITEM_CUSTODY_STATUS_UPDATE_FAILED',
    });
  }

  return typeof data === 'string' ? data : null;
}

export default async function postsStatusRoutes(
  server: FastifyInstance,
  options: PostsStatusRouteOptions = {}
) {
  const getSupabase = options.getSupabase ?? getSupabaseClient;
  const auditLogger = options.auditLogger ?? logAudit;
  const getAuditUserName = options.getAuditUserName ?? getUserName;

  // PUT /posts/:id/status - Update post status
  server.put<{ Params: { id: string }; Body: UpdatePostStatusRequest }>(
    '/:id/status',
    {
      preHandler: [requireStaff],
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
          required: ['status'],
          properties: {
            status: {
              type: 'string',
              enum: ['pending', 'accepted', 'rejected', 'archived', 'deleted', 'reported', 'fraud'],
            },
            rejection_reason: { type: 'string' },
          },
          additionalProperties: false,
        },
      },
    },
    async (request) => {
      const supabase = getSupabase();
      const postId = parseInt(request.params.id, 10);
      const { status, rejection_reason } = request.body;
      const staffId = request.user?.user_id;

      // Get post details for audit log
      const { data: postData } = await supabase
        .from('post_public_view')
        .select('item_name, poster_name')
        .eq('post_id', postId)
        .single();

      const updateData: { status: string; rejection_reason: string | null } = {
        status,
        rejection_reason: status === 'rejected' ? rejection_reason ?? null : null,
      };

      const { error } = await supabase.from('post_table').update(updateData).eq('post_id', postId);

      if (error) {
        logger.error({ error, postId }, 'Failed to update post status');
        throw normalizeUpstreamError(error, {
          statusCode: 500,
          message: 'Failed to update post status',
          code: 'POST_STATUS_UPDATE_FAILED',
        });
      }

      // Log to audit trail
      if (staffId && postData) {
        const staffName = await getAuditUserName(staffId);
        const itemName = postData.item_name || 'Unknown Item';

        let actionType = '';
        let message = '';

        if (status === 'accepted') {
          actionType = 'post_accepted';
          message = `${staffName} accepted the post ${itemName}`;
        } else if (status === 'rejected') {
          actionType = 'post_rejected';
          message = `${staffName} rejected the post ${itemName}`;
        } else if (status === 'deleted') {
          actionType = 'post_deleted';
          message = `${staffName} deleted the post ${itemName}`;
        } else {
          actionType = 'post_status_changed';
          message = `${staffName} changed post status to ${status} for ${itemName}`;
        }

        await auditLogger({
          userId: staffId,
          actionType,
          details: {
            message,
            post_id: postId.toString(),
            item_name: itemName,
            new_status: status,
            rejection_reason: rejection_reason || undefined,
            timestamp: new Date().toISOString(),
          },
          recordId: postId.toString(),
        });
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
          required: ['staff_id'],
          properties: {
            staff_id: { type: 'string', minLength: 1 },
          },
          additionalProperties: false,
        },
      },
    },
    async (request) => {
      const supabase = getSupabase();
      const postId = parseInt(request.params.id, 10);
      const { staff_id } = request.body;

      const { error } = await supabase
        .from('post_table')
        .update({ accepted_by_staff_id: staff_id })
        .eq('post_id', postId);

      if (error) {
        logger.error({ error, postId }, 'Failed to update staff assignment');
        throw normalizeUpstreamError(error, {
          statusCode: 500,
          message: 'Failed to update staff assignment',
          code: 'POST_STAFF_ASSIGNMENT_FAILED',
        });
      }

      logger.info({ postId, staff_id }, 'Post staff assignment updated');
      return { success: true };
    }
  );

  // PUT /items/:id/status - Update item status
  server.put<{ Params: { id: string }; Body: UpdateItemStatusRequest }>(
    '/items/:id/status',
    {
      preHandler: [requireStaff],
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
          required: ['status'],
          properties: {
            status: { type: 'string', enum: ['claimed', 'unclaimed', 'discarded', 'returned', 'lost'] },
            discard_reason: { type: 'string' },
          },
          additionalProperties: false,
        },
      },
    },
    async (request) => {
      const supabase = getSupabase();
      const itemId = request.params.id;
      const { status, discard_reason } = request.body;
      const staffId = request.user?.user_id;
      const timestamp = new Date().toISOString();

      if (!staffId) {
        throw createHttpError('Unauthorized', 401);
      }

      // Get item details for audit log
      const { data: itemData, error: itemDataError } = await supabase
        .from('post_public_view')
        .select('post_id, item_id, item_name, item_type, poster_id, item_status, custody_status')
        .eq('item_id', itemId)
        .single();

      if (itemDataError || !itemData) {
        logger.error({ error: itemDataError, itemId }, 'Failed to fetch item status context');
        throw createHttpError('Item not found', 404);
      }

      const itemRow = itemData as ItemStatusRouteRow;
      const oldStatus = itemRow.item_status;
      const oldStatusNormalized = itemRow.item_status?.toLowerCase() ?? null;
      const oldCustodyStatus = itemRow.custody_status ?? null;
      const normalizedDiscardReason = normalizeDiscardReason(discard_reason);
      const isDiscardTransition =
        status === 'discarded' && oldStatusNormalized !== 'discarded';
      let newCustodyStatus: string | null | undefined;

      let discardedRecord: DiscardFoundItemRow | null = null;

      if (isDiscardTransition) {
        if (!normalizedDiscardReason) {
          throw createHttpError(
            'Discard reason is required when marking an item as discarded.',
            400
          );
        }

        if ((itemRow.item_type ?? '').toLowerCase() !== 'found') {
          throw createHttpError('Only found items can be discarded.', 409);
        }

        const { data, error } = await supabase.rpc('discard_found_item', {
          p_item_id: itemId,
          p_actor_user_id: staffId,
          p_discarded_reason: normalizedDiscardReason,
          p_occurred_at: timestamp,
        });

        if (error) {
          logger.error({ error, itemId }, 'Failed to discard found item');
          throw normalizeUpstreamError(error, {
            statusCode: 500,
            message: 'Failed to update item status',
            code: 'ITEM_STATUS_UPDATE_FAILED',
          });
        }

        discardedRecord = (Array.isArray(data) ? data[0] : data) as DiscardFoundItemRow | null;
        newCustodyStatus = 'discarded';
      } else {
        const { error } = await supabase
          .from('item_table')
          .update({ status })
          .eq('item_id', itemId);

        if (error) {
          logger.error({ error, itemId }, 'Failed to update item status');
          throw normalizeUpstreamError(error, {
            statusCode: 500,
            message: 'Failed to update item status',
            code: 'ITEM_STATUS_UPDATE_FAILED',
          });
        }

        if (
          (itemRow.item_type ?? '').toLowerCase() === 'found' &&
          oldStatusNormalized === 'discarded' &&
          status !== 'discarded'
        ) {
          newCustodyStatus = await recomputeFoundItemCustodyStatus(
            supabase,
            itemRow.post_id,
            itemId
          );
        }
      }

      // Log to audit trail
      if (itemData) {
        const staffName = await getAuditUserName(staffId);
        const itemName = itemRow.item_name || discardedRecord?.item_name || 'Unknown Item';
        const auditMessage =
          isDiscardTransition && normalizedDiscardReason
            ? `${staffName} changed item status from ${oldStatus} to ${status} for ${itemName}. Disposition: ${normalizedDiscardReason}`
            : `${staffName} changed item status from ${oldStatus} to ${status} for ${itemName}`;

        await auditLogger({
          userId: staffId,
          actionType: isDiscardTransition ? 'item_discarded' : 'item_status_changed',
          details: {
            message: auditMessage,
            item_id: itemId,
            post_id: itemRow.post_id,
            item_name: itemName,
            old_status: oldStatus,
            new_status: status,
            old_custody_status: oldCustodyStatus,
            new_custody_status: newCustodyStatus,
            discard_reason: isDiscardTransition ? normalizedDiscardReason ?? undefined : undefined,
            item_discard_id: discardedRecord?.item_discard_id,
            custody_record_id: discardedRecord?.custody_record_id,
            timestamp,
          },
          recordId: itemId,
        });
      }

      logger.info({ itemId, status }, 'Item status updated');
      return { success: true };
    }
  );
}
