import { FastifyInstance } from 'fastify';
import { requireAuth } from '../middleware/auth.js';
import { getGeminiService, RateLimitError } from '../services/gemini.js';
import logger from '../utils/logger.js';

interface AutofillBody {
  image_data_url: string;
  current_title?: string;
  current_description?: string;
  current_category?: string;
}

function parseImageDataUrl(dataUrl: string): { mimeType: string; base64: string } {
  const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/);
  if (!match) {
    throw new Error('Invalid image_data_url');
  }

  return {
    mimeType: match[1],
    base64: match[2],
  };
}

export default async function aiRoutes(server: FastifyInstance) {
  server.post<{ Body: AutofillBody }>(
    '/create-post-autofill',
    {
      preHandler: [requireAuth],
      schema: {
        body: {
          type: 'object',
          required: ['image_data_url'],
          properties: {
            image_data_url: { type: 'string', minLength: 1 },
            current_title: { type: 'string' },
            current_description: { type: 'string' },
            current_category: { type: 'string' },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      try {
        const { mimeType, base64 } = parseImageDataUrl(request.body.image_data_url);
        logger.info(
          {
            mimeType,
            base64Length: base64.length,
            hasTitle: !!request.body.current_title,
            hasDescription: !!request.body.current_description,
            hasCategory: !!request.body.current_category,
          },
          'create-post-autofill request received'
        );

        const gemini = getGeminiService();

        const content = await gemini.generateCreatePostAutofill({
          imageBase64: base64,
          mimeType,
          currentTitle: request.body.current_title,
          currentDescription: request.body.current_description,
          currentCategory: request.body.current_category,
        });

        logger.info({ content }, 'create-post-autofill succeeded');
        return { success: true, content };
      } catch (error) {
        if (error instanceof RateLimitError) {
          logger.warn('create-post-autofill rate limited');
          return reply.status(429).send({
            success: false,
            error: 'rate_limit_exceeded',
            message: 'Autogeneration is limited. Try again later.',
          });
        }

        if (error instanceof Error && error.message === 'Gemini service not configured') {
          logger.warn('create-post-autofill called but Gemini not configured');
          return reply.status(503).send({
            success: false,
            error: 'ai_unavailable',
            message: 'Gemini service is not configured.',
          });
        }

        const errObj = error as Record<string, unknown>;
        logger.error(
          {
            status: errObj?.status ?? errObj?.['statusCode'],
            statusText: errObj?.statusText,
            message: errObj?.message,
            stack: errObj?.stack,
          },
          'Failed to generate create-post autofill'
        );
        return reply.status(500).send({
          success: false,
          error: 'ai_generation_failed',
          message: 'Failed to generate autofill content.',
        });
      }
    }
  );
}
