import { FastifyInstance } from 'fastify';
import { Resend } from 'resend';
import { requireStaff } from '../middleware/auth.js';
import logger from '../utils/logger.js';
import { DEFAULT_TIMEOUT_MS, withTimeout } from '../utils/timeout.js';

const resend = new Resend(process.env.RESEND_API_KEY);

interface SendEmailBody {
  to: string;
  subject: string;
  html: string;
  senderUuid: string;
  from?: string;
}

export default async function emailRoutes(server: FastifyInstance) {
  // POST /email/send - Send an email via Resend
  server.post<{ Body: SendEmailBody }>(
    '/send',
    {
      preHandler: [requireStaff],
    },
    async (request) => {
      const { to, subject, html, senderUuid, from } = request.body;

      if (!to || !subject || !html || !senderUuid) {
        throw new Error('Missing required fields: to, subject, html, senderUuid');
      }

      try {
        const { data, error } = await withTimeout(
          resend.emails.send({
            from: from || process.env.RESEND_FROM_EMAIL || 'UMak LINK <noreply@umaklink.com>',
            to: [to],
            subject,
            html,
          }),
          DEFAULT_TIMEOUT_MS,
          'Resend send'
        );

        if (error) {
          logger.error({ error, to, senderUuid }, 'Failed to send email via Resend');
          return {
            success: false,
            error: error.message || 'Failed to send email',
          };
        }

        logger.info({ to, senderUuid, emailId: data?.id }, 'Email sent successfully');
        return {
          success: true,
          message: 'Email sent successfully',
          to,
        };
      } catch (err) {
        logger.error({ error: err, to, senderUuid }, 'Exception sending email');
        return {
          success: false,
          error: err instanceof Error ? err.message : 'Unknown error occurred',
        };
      }
    }
  );
}
