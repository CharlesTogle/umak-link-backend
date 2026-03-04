import { FastifyInstance } from 'fastify';
import { requireAuth, requireStaff } from '../middleware/auth.js';
import {
  generateSignedUploadUrl,
  confirmUpload,
  deleteStorageObject,
} from '../services/storage.js';
import logger from '../utils/logger.js';

export default async function storageRoutes(server: FastifyInstance) {
  // POST /storage/upload-url - Generate signed upload URL
  server.post<{
    Body: {
      bucket: 'items' | 'profilePictures';
      fileName: string;
      contentType: string;
    };
  }>(
    '/upload-url',
    {
      preHandler: [requireAuth],
      schema: {
        body: {
          type: 'object',
          required: ['bucket', 'fileName', 'contentType'],
          properties: {
            bucket: { type: 'string', enum: ['items', 'profilePictures'] },
            fileName: { type: 'string', minLength: 1 },
            contentType: { type: 'string', minLength: 1 },
          },
          additionalProperties: false,
        },
      },
    },
    async (request) => {
      const { bucket, fileName, contentType } = request.body;

      const result = await generateSignedUploadUrl(bucket, fileName, contentType);

      logger.info({ bucket, fileName }, 'Signed upload URL generated');
      return result;
    }
  );

  // POST /storage/confirm-upload - Confirm upload completed
  server.post<{
    Body: {
      bucket: 'items' | 'profilePictures';
      objectPath: string;
    };
  }>(
    '/confirm-upload',
    {
      preHandler: [requireAuth],
      schema: {
        body: {
          type: 'object',
          required: ['bucket', 'objectPath'],
          properties: {
            bucket: { type: 'string', enum: ['items', 'profilePictures'] },
            objectPath: { type: 'string', minLength: 1 },
          },
          additionalProperties: false,
        },
      },
    },
    async (request) => {
      const { bucket, objectPath } = request.body;

      const result = await confirmUpload(bucket, objectPath);

      logger.info({ bucket, objectPath }, 'Upload confirmed');
      return result;
    }
  );

  // DELETE /storage/item - Delete storage object
  server.delete<{
    Body: {
      bucket: 'items' | 'profilePictures';
      objectPath: string;
    };
  }>(
    '/',
    {
      preHandler: [requireStaff],
      schema: {
        body: {
          type: 'object',
          required: ['bucket', 'objectPath'],
          properties: {
            bucket: { type: 'string', enum: ['items', 'profilePictures'] },
            objectPath: { type: 'string', minLength: 1 },
          },
          additionalProperties: false,
        },
      },
    },
    async (request) => {
      const { bucket, objectPath } = request.body;

      const success = await deleteStorageObject(bucket, objectPath);

      if (!success) {
        throw new Error('Failed to delete storage object');
      }

      logger.info({ bucket, objectPath }, 'Storage object deleted');
      return { success: true };
    }
  );
}
