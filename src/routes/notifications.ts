import { FastifyInstance } from 'fastify';
import { getSupabaseClient } from '../services/supabase.js';
import { createNotification } from '../services/notifications.js';
import { requireAuth, requireStaff } from '../middleware/auth.js';
import { SendNotificationRequest, NotificationRecord } from '../types/notifications.js';
import logger from '../utils/logger.js';

type SupabaseErrorLike = {
  code?: string;
  message?: string;
  details?: string | null;
  hint?: string | null;
};

function isMissingColumnError(error: unknown, column: string): boolean {
  const typed = error as SupabaseErrorLike | null;
  if (!typed) return false;
  return typed.code === 'PGRST204' && typeof typed.message === 'string' && typed.message.includes(`'${column}'`);
}

function normalizeNotificationId(value: string): string | number {
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}

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
      const notificationId = await createNotification({
        ...request.body,
        sent_by: request.user?.user_id ?? null,
      });

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

      let response = await supabase
        .from('notification_view')
        .select('*')
        .eq('sent_to', userId)
        .order('created_at', { ascending: false });

      if (response.error && isMissingColumnError(response.error, 'sent_to')) {
        response = await supabase
          .from('notification_view')
          .select('*')
          .eq('user_id', userId)
          .order('created_at', { ascending: false });
      }

      if (response.error) {
        logger.error({ error: response.error, userId }, 'Failed to fetch notifications');
        throw new Error('Failed to fetch notifications');
      }

      const notifications: NotificationRecord[] = (response.data || []).map((row: Record<string, unknown>) => ({
        notification_id: row.notification_id as string | number,
        user_id: (row.user_id as string | null) ?? (row.sent_to as string | null) ?? userId ?? '',
        title: String(row.title ?? ''),
        body: String(row.body ?? row.description ?? ''),
        description: (row.description as string | null) ?? null,
        sent_to: (row.sent_to as string | null) ?? (row.user_id as string | null) ?? null,
        sent_by: (row.sent_by as string | null) ?? null,
        type: String(row.type ?? 'info'),
        data: (row.data as Record<string, unknown> | null) ?? null,
        is_read: Boolean(row.is_read),
        created_at: String(row.created_at ?? ''),
        image_url: (row.image_url as string | null) ?? null,
      }));

      return { notifications };
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

      let countQuery = await supabase
        .from('notification_table')
        .select('*', { count: 'exact', head: true })
        .eq('sent_to', userId)
        .eq('is_read', false);

      if (countQuery.error && isMissingColumnError(countQuery.error, 'sent_to')) {
        countQuery = await supabase
          .from('notification_table')
          .select('*', { count: 'exact', head: true })
          .eq('user_id', userId)
          .eq('is_read', false);
      }

      if (countQuery.error) {
        logger.error({ userId, error: countQuery.error }, 'Failed to count notifications');
        return { unread_count: 0 };
      }

      return { unread_count: countQuery.count || 0 };
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
      const notificationId = normalizeNotificationId(request.params.id);

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
      const notificationId = normalizeNotificationId(request.params.id);

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
