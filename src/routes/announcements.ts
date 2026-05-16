import { FastifyInstance } from 'fastify';
import { getSupabaseClient } from '../services/supabase.js';
import { sendGlobalAnnouncement } from '../services/notifications.js';
import { requireAdmin, requireAuth } from '../middleware/auth.js';
import { SendGlobalAnnouncementRequest, AnnouncementRecord } from '../types/notifications.js';
import { getUserName, logAudit } from '../utils/audit-logger.js';
import logger from '../utils/logger.js';

export default async function announcementsRoutes(server: FastifyInstance) {
  // POST /announcements/send - Send global announcement
  server.post<{ Body: SendGlobalAnnouncementRequest }>(
    '/send',
    {
      preHandler: [requireAdmin],
      schema: {
        body: {
          type: 'object',
          required: ['message'],
          properties: {
            message: { type: 'string', minLength: 1 },
            description: { type: ['string', 'null'] },
            image_url: { type: ['string', 'null'] },
          },
          additionalProperties: false,
        },
      },
    },
    async (request) => {
      const { message, description, image_url } = request.body;
      const senderId = request.user?.user_id;

      if (!senderId) {
        throw new Error('Unauthorized');
      }

      const announcement = await sendGlobalAnnouncement(
        message,
        description || null,
        image_url || null,
        senderId
      );

      if (!announcement) {
        throw new Error('Failed to send announcement');
      }

      const resolvedSenderName = await getUserName(senderId);
      const senderName = resolvedSenderName === 'Staff' ? 'Admin' : resolvedSenderName;

      await logAudit({
        userId: senderId,
        actionType: 'create_announcement',
        tableName: 'global_announcements_table',
        recordId: announcement.announcementId.toString(),
        details: {
          title: message,
          message: `${senderName} posted a global announcement: "${message}"`,
          description: description || null,
          timestamp: announcement.createdAt,
        },
      });

      logger.info({ senderId, announcementId: announcement.announcementId }, 'Global announcement sent');
      return { success: true };
    }
  );

  // GET /announcements - List announcements with pagination
  server.get<{
    Querystring: { limit?: number; offset?: number };
  }>(
    '/',
    {
      preHandler: [requireAuth],
      schema: {
        querystring: {
          type: 'object',
          properties: {
            limit: { type: 'number', minimum: 1, maximum: 100 },
            offset: { type: 'number', minimum: 0 },
          },
        },
      },
    },
    async (request): Promise<{ announcements: AnnouncementRecord[]; count: number }> => {
      const supabase = getSupabaseClient();
      const { limit = 30, offset = 0 } = request.query;

      const { data, count, error } = await supabase
        .from('global_announcement_view')
        .select('id, created_at, message, description, image_url', { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);

      if (error) {
        logger.error({ error }, 'Failed to fetch announcements');
        throw new Error('Failed to fetch announcements');
      }

      return { announcements: data || [], count: count || 0 };
    }
  );
}
