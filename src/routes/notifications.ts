import { FastifyInstance } from 'fastify';
import { getSupabaseClient } from '../services/supabase.js';
import { createNotification } from '../services/notifications.js';
import { requireAuth, requireStaff } from '../middleware/auth.js';
import { SendNotificationRequest, NotificationRecord } from '../types/notifications.js';
import logger from '../utils/logger.js';
import { logAudit, getUserName } from '../utils/audit-logger.js';

type SupabaseErrorLike = {
  code?: string;
  message?: string;
  details?: string | null;
  hint?: string | null;
};

type UnreadNotificationRow = {
  notification_id: string | number;
  sent_to?: string | null;
  user_id?: string | null;
  sent_by?: string | null;
  type?: string | null;
};

type NotificationsRouteSupabaseClient = Pick<ReturnType<typeof getSupabaseClient>, 'from'>;

interface NotificationsRouteServices {
  getSupabaseClient: () => NotificationsRouteSupabaseClient;
}

interface NotificationsRouteOptions {
  services?: Partial<NotificationsRouteServices>;
}

const defaultServices: NotificationsRouteServices = {
  getSupabaseClient,
};

function isMissingColumnError(error: unknown, column: string): boolean {
  const typed = error as SupabaseErrorLike | null;
  if (!typed || typeof typed.message !== 'string') return false;

  const matchesColumn =
    typed.message.includes(`'${column}'`) ||
    typed.message.includes(`"${column}"`) ||
    typed.message.includes(`.${column}`) ||
    typed.message.includes(` ${column} `);

  return (typed.code === 'PGRST204' || typed.code === '42703') && matchesColumn;
}

function normalizeNotificationId(value: string): string | number {
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}

function createHttpError(message: string, statusCode: number): Error & { statusCode: number } {
  const error = new Error(message) as Error & { statusCode: number };
  error.statusCode = statusCode;
  return error;
}

function normalizeNotificationData(
  data: Record<string, unknown> | null | undefined
): Record<string, unknown> | null {
  if (!data) return null;

  return Object.fromEntries(
    Object.entries(data).map(([key, value]) => {
      if (key === 'postId' || key === 'post_id') {
        if (typeof value === 'string' || typeof value === 'number') {
          return [key, String(value)];
        }
      }

      if ((key === 'matched_post_ids' || key === 'post_ids') && Array.isArray(value)) {
        return [key, JSON.stringify(value.map((entry) => (entry == null ? '' : String(entry))))];
      }

      return [key, value];
    })
  );
}

function isSelfAuthoredAnnouncement(
  notification: Pick<NotificationRecord, 'type' | 'sent_by' | 'user_id'>
): boolean {
  const type = notification.type === 'announcement' ? 'global_announcement' : notification.type;
  return (
    (type === 'announcement' || type === 'global_announcement') &&
    Boolean(notification.sent_by) &&
    notification.sent_by === notification.user_id
  );
}

export default async function notificationsRoutes(
  server: FastifyInstance,
  options: NotificationsRouteOptions = {}
) {
  const services: NotificationsRouteServices = {
    ...defaultServices,
    ...options.services,
  };

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
      const staffId = request.user?.user_id;

      const notificationId = await createNotification({
        ...request.body,
        sent_by: staffId ?? null,
      });

      if (!notificationId) {
        throw new Error('Failed to create notification');
      }

      // Log to audit trail
      if (staffId) {
        const staffName = await getUserName(staffId);

        await logAudit({
          userId: staffId,
          actionType: 'notification_sent',
          details: {
            message: `${staffName} sent notification to user`,
            notification_id: notificationId.toString(),
            recipient_user_id: request.body.user_id,
            notification_title: request.body.title,
            notification_type: request.body.type,
            timestamp: new Date().toISOString(),
          },
          recordId: notificationId.toString(),
        });
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
      const supabase = services.getSupabaseClient();
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
        type:
          String(row.type ?? 'info') === 'announcement'
            ? 'global_announcement'
            : String(row.type ?? 'info'),
        data: normalizeNotificationData((row.data as Record<string, unknown> | null) ?? null),
        is_read: Boolean(row.is_read),
        created_at: String(row.created_at ?? ''),
        image_url: (row.image_url as string | null) ?? null,
      }));

      return {
        notifications: notifications.filter((notification) => !isSelfAuthoredAnnouncement(notification)),
      };
    }
  );

  // GET /notifications/count - Unread notification count
  server.get(
    '/count',
    {
      preHandler: [requireAuth],
    },
    async (request) => {
      const supabase = services.getSupabaseClient();
      const userId = request.user?.user_id;

      const primaryUnreadQuery = await supabase
        .from('notification_table')
        .select('notification_id, sent_to, sent_by, type')
        .eq('sent_to', userId)
        .eq('is_read', false);

      const unreadQuery =
        primaryUnreadQuery.error && isMissingColumnError(primaryUnreadQuery.error, 'sent_to')
          ? await supabase
          .from('notification_table')
          .select('notification_id, user_id, sent_by, type')
          .eq('user_id', userId)
          .eq('is_read', false)
          : primaryUnreadQuery;

      if (unreadQuery.error) {
        logger.error({ userId, error: unreadQuery.error }, 'Failed to count notifications');
        return { unread_count: 0 };
      }

      const unreadCount = ((unreadQuery.data || []) as UnreadNotificationRow[]).filter((row) => {
        const normalizedNotification: NotificationRecord = {
          notification_id: row.notification_id,
          user_id: row.user_id ?? row.sent_to ?? userId ?? '',
          title: "",
          body: "",
          description: null,
          sent_to: row.sent_to ?? row.user_id ?? null,
          sent_by: row.sent_by ?? null,
          type:
            String(row.type ?? "info") === "announcement"
              ? "global_announcement"
              : String(row.type ?? "info"),
          data: null,
          is_read: false,
          created_at: "",
          image_url: null,
        };

        return !isSelfAuthoredAnnouncement(normalizedNotification);
      }).length;

      return { unread_count: unreadCount };
    }
  );

  // PATCH /notifications/:id/read - Mark as read
  server.patch<{ Params: { id: string } }>(
    '/:id/read',
    {
      preHandler: [requireAuth],
    },
    async (request) => {
      const supabase = services.getSupabaseClient();
      const notificationId = normalizeNotificationId(request.params.id);
      const userId = request.user?.user_id;

      let updateQuery = await supabase
        .from('notification_table')
        .update({ is_read: true })
        .eq('notification_id', notificationId)
        .eq('sent_to', userId)
        .select('notification_id')
        .maybeSingle();

      if (updateQuery.error && isMissingColumnError(updateQuery.error, 'sent_to')) {
        updateQuery = await supabase
          .from('notification_table')
          .update({ is_read: true })
          .eq('notification_id', notificationId)
          .eq('user_id', userId)
          .select('notification_id')
          .maybeSingle();
      }

      if (updateQuery.error) {
        logger.error({ error: updateQuery.error, notificationId, userId }, 'Failed to mark notification as read');
        throw new Error('Failed to update notification');
      }

      if (!updateQuery.data) {
        throw createHttpError('Notification not found', 404);
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
      const supabase = services.getSupabaseClient();
      const notificationId = normalizeNotificationId(request.params.id);
      const userId = request.user?.user_id;

      let deleteQuery = await supabase
        .from('notification_table')
        .delete()
        .eq('notification_id', notificationId)
        .eq('sent_to', userId)
        .select('notification_id')
        .maybeSingle();

      if (deleteQuery.error && isMissingColumnError(deleteQuery.error, 'sent_to')) {
        deleteQuery = await supabase
          .from('notification_table')
          .delete()
          .eq('notification_id', notificationId)
          .eq('user_id', userId)
          .select('notification_id')
          .maybeSingle();
      }

      if (deleteQuery.error) {
        logger.error({ error: deleteQuery.error, notificationId, userId }, 'Failed to delete notification');
        throw new Error('Failed to delete notification');
      }

      if (!deleteQuery.data) {
        throw createHttpError('Notification not found', 404);
      }

      return { success: true };
    }
  );
}
