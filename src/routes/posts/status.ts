import { FastifyInstance } from 'fastify';
import { getSupabaseClient } from '../../services/supabase.js';
import { requireStaff } from '../../middleware/auth.js';
import { UpdatePostStatusRequest, UpdateItemStatusRequest } from '../../types/posts.js';
import logger from '../../utils/logger.js';
import { logAudit, getUserName } from '../../utils/audit-logger.js';

export default async function postsStatusRoutes(server: FastifyInstance) {
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
      const supabase = getSupabaseClient();
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
        throw new Error(error.message || 'Failed to update post status');
      }

      // Log to audit trail
      if (staffId && postData) {
        const staffName = await getUserName(staffId);
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

        await logAudit({
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
          },
          additionalProperties: false,
        },
      },
    },
    async (request) => {
      const supabase = getSupabaseClient();
      const itemId = request.params.id;
      const { status } = request.body;
      const staffId = request.user?.user_id;

      // Get item details for audit log
      const { data: itemData } = await supabase
        .from('item_table')
        .select('item_name, item_status')
        .eq('item_id', itemId)
        .single();

      const oldStatus = itemData?.item_status;

      const { error } = await supabase
        .from('item_table')
        .update({ item_status: status })
        .eq('item_id', itemId);

      if (error) {
        logger.error({ error, itemId }, 'Failed to update item status');
        throw new Error(error.message || 'Failed to update item status');
      }

      // Log to audit trail
      if (staffId && itemData) {
        const staffName = await getUserName(staffId);
        const itemName = itemData.item_name || 'Unknown Item';

        await logAudit({
          userId: staffId,
          actionType: 'item_status_changed',
          details: {
            message: `${staffName} changed item status from ${oldStatus} to ${status} for ${itemName}`,
            item_id: itemId,
            item_name: itemName,
            old_status: oldStatus,
            new_status: status,
            timestamp: new Date().toISOString(),
          },
          recordId: itemId,
        });
      }

      logger.info({ itemId, status }, 'Item status updated');
      return { success: true };
    }
  );
}
