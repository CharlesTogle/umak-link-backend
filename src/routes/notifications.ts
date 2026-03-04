import { FastifyInstance } from 'fastify';
import { getSupabaseClient } from '../services/supabase.js';
import { createNotification } from '../services/notifications.js';
import { requireAuth, requireStaff } from '../middleware/auth.js';
import { SendNotificationRequest, NotificationRecord } from '../types/notifications.js';
import logger from '../utils/logger.js';

export default async function notificationsRoutes(server: FastifyInstance) {
  // POST /notifications/send - Create and send notification
  server.post<{ Body: SendNotificationRequest }>(
    '/send',
    {
      preHandler: [requireStaff],
      schema: {
        body: {
          type: 'object',
          required: ['user_id', 'title', 'body', 'type'],
          properties: {
            user_id: { type: 'string', minLength: 1 },
            title: { type: 'string', minLength: 1 },
            body: { type: 'string', minLength: 1 },
            description: { type: ['string', 'null'] },
            type: { type: 'string', minLength: 1 },
            data: { type: 'object' },
            image_url: { type: ['string', 'null'] },
          },
          additionalProperties: false,
        },
      },
    },
    async (request) => {
      const notificationId = await createNotification(request.body);

      if (!notificationId) {
        throw new Error('Failed to create notification');
      }

      logger.info({ notificationId }, 'Notification sent');
      return { success: true, notification_id: notificationId };
    }
  );

  // GET /notifications - List user notifications
  server.get(
    '/',
    {
      preHandler: [requireAuth],
    },
    async (request): Promise<{ notifications: NotificationRecord[] }> => {
      const supabase = getSupabaseClient();
      const userId = request.user?.user_id;

      const { data, error } = await supabase
        .from('notification_view')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false });

      if (error) {
        logger.error({ error, userId }, 'Failed to fetch notifications');
        throw new Error('Failed to fetch notifications');
      }

      return { notifications: data || [] };
    }
  );

  // GET /notifications/count - Unread notification count
  server.get(
    '/count',
    {
      preHandler: [requireAuth],
    },
    async (request) => {
      const supabase = getSupabaseClient();
      const userId = request.user?.user_id;

      const { count, error } = await supabase
        .from('notification_table')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId)
        .eq('is_read', false);

      if (error) {
        logger.error({ error, userId }, 'Failed to count notifications');
        throw new Error('Failed to count notifications');
      }

      return { unread_count: count || 0 };
    }
  );

  // PATCH /notifications/:id/read - Mark as read
  server.patch<{ Params: { id: string } }>(
    '/:id/read',
    {
      preHandler: [requireAuth],
    },
    async (request) => {
      const supabase = getSupabaseClient();
      const notificationId = parseInt(request.params.id, 10);

      const { error } = await supabase
        .from('notification_table')
        .update({ is_read: true })
        .eq('notification_id', notificationId);

      if (error) {
        logger.error({ error, notificationId }, 'Failed to mark notification as read');
        throw new Error('Failed to update notification');
      }

      return { success: true };
    }
  );

  // DELETE /notifications/:id - Delete notification
  server.delete<{ Params: { id: string } }>(
    '/:id',
    {
      preHandler: [requireAuth],
    },
    async (request) => {
      const supabase = getSupabaseClient();
      const notificationId = parseInt(request.params.id, 10);

      const { error } = await supabase
        .from('notification_table')
        .delete()
        .eq('notification_id', notificationId);

      if (error) {
        logger.error({ error, notificationId }, 'Failed to delete notification');
        throw new Error('Failed to delete notification');
      }

      return { success: true };
    }
  );
}
