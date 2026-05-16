import { FastifyInstance } from 'fastify';
import { requireStaff } from '../middleware/auth.js';
import { sendEmail } from '../services/email.js';

interface SendEmailBody {
  to: string;
  subject: string;
  html: string;
  senderUuid: string;
  from?: string;
}

interface EmailRouteOptions {
  services?: {
    sendEmail?: typeof sendEmail;
  };
}

export default async function emailRoutes(server: FastifyInstance, options: EmailRouteOptions = {}) {
  const dispatchEmail = options.services?.sendEmail ?? sendEmail;

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

      return dispatchEmail({ to, subject, html, senderUuid, from });
    }
  );
}
