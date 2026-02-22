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

  // GET /announcements - List announcements
  server.get(
    '/',
    {
      preHandler: [requireAuth],
    },
    async (): Promise<{ announcements: AnnouncementRecord[] }> => {
      const supabase = getSupabaseClient();

      const { data, error } = await supabase
        .from('global_announcements_table')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(50);

      if (error) {
        logger.error({ error }, 'Failed to fetch announcements');
        throw new Error('Failed to fetch announcements');
      }

      return { announcements: data || [] };
    }
  );
}
