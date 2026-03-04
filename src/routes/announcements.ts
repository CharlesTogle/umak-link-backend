import { FastifyInstance } from 'fastify';
import { getSupabaseClient } from '../services/supabase.js';
import { sendGlobalAnnouncement } from '../services/notifications.js';
import { requireAuth, requireStaff } from '../middleware/auth.js';
import { SendGlobalAnnouncementRequest, AnnouncementRecord } from '../types/notifications.js';
import logger from '../utils/logger.js';

export default async function announcementsRoutes(server: FastifyInstance) {
  // POST /announcements/send - Send global announcement
  server.post<{ Body: SendGlobalAnnouncementRequest }>(
    '/send',
    {
      preHandler: [requireStaff],
      schema: {
        body: {
          type: 'object',
          required: ['user_id', 'message'],
          properties: {
            user_id: { type: 'string', minLength: 1 },
            message: { type: 'string', minLength: 1 },
            description: { type: ['string', 'null'] },
            image_url: { type: ['string', 'null'] },
          },
          additionalProperties: false,
        },
      },
    },
    async (request) => {
      const { user_id, message, description, image_url } = request.body;

      const success = await sendGlobalAnnouncement(message, description || null, image_url || null, user_id);

      if (!success) {
        throw new Error('Failed to send announcement');
      }

      logger.info({ senderId: user_id }, 'Global announcement sent');
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
