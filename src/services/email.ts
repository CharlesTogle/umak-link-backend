import { Resend } from 'resend';
import logger from '../utils/logger.js';
import { GENERAL_TIMEOUT_MS, withTimeout } from '../utils/timeout.js';

export interface SendEmailPayload {
  to: string;
  subject: string;
  html: string;
  senderUuid: string;
  from?: string;
}

interface ResendEmailClient {
  emails: {
    send(payload: {
      from: string;
      to: string[];
      subject: string;
      html: string;
    }): Promise<{
      data?: {
        id?: string | null;
      } | null;
      error?: {
        message?: string | null;
      } | null;
    }>;
  };
}

type ResendClientFactory = (apiKey: string) => ResendEmailClient;

const defaultResendClientFactory: ResendClientFactory = (apiKey) => new Resend(apiKey);
let resendClientFactory: ResendClientFactory = defaultResendClientFactory;

export async function sendEmail(payload: SendEmailPayload): Promise<{
  success: boolean;
  error?: string;
  message?: string;
  to: string;
}> {
  const { to, subject, html, senderUuid, from } = payload;

  if (!process.env.RESEND_API_KEY) {
    logger.warn({ to, senderUuid }, 'RESEND_API_KEY is not configured');
    return {
      success: false,
      error: 'Email service is not configured',
      to,
    };
  }

  try {
    const resend = resendClientFactory(process.env.RESEND_API_KEY);
    const { data, error } = await withTimeout(
      resend.emails.send({
        from: from || process.env.RESEND_FROM_EMAIL || 'UMak-LINK <noreply@umaklink.com>',
        to: [to],
        subject,
        html,
      }),
      GENERAL_TIMEOUT_MS,
      'Resend send'
    );

    if (error) {
      logger.error({ error, to, senderUuid }, 'Failed to send email via Resend');
      return {
        success: false,
        error: error.message || 'Failed to send email',
        to,
      };
    }

    logger.info({ to, senderUuid, emailId: data?.id }, 'Email sent successfully');
    return {
      success: true,
      message: 'Email sent successfully',
      to,
    };
  } catch (error) {
    logger.error({ error, to, senderUuid }, 'Exception sending email');
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred',
      to,
    };
  }
}

export function setResendClientFactoryForTests(factory: ResendClientFactory | null): void {
  resendClientFactory = factory ?? defaultResendClientFactory;
}
