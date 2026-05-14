import { FastifyInstance } from 'fastify';
import { requireAuth } from '../middleware/auth.js';
import {
  cancelCustodySession,
  createCustodyAttempt,
  getCustodySessionStatus,
  getStudentCustodyHistory,
  listGuardPosts,
  retryCustodySession,
} from '../services/custody.js';
import {
  CancelCustodySessionResponse,
  CreateCustodyAttemptRequest,
  CreateCustodyAttemptResponse,
  CustodySessionStatusResponse,
  GuardPostRecord,
  RetryCustodySessionRequest,
  RetryCustodySessionResponse,
  StudentCustodyHistoryResponse,
} from '../types/custody.js';
import { createHttpError } from '../utils/http-error.js';

export interface CustodyRouteServices {
  listGuardPosts: typeof listGuardPosts;
  createCustodyAttempt: typeof createCustodyAttempt;
  getCustodySessionStatus: typeof getCustodySessionStatus;
  retryCustodySession: typeof retryCustodySession;
  cancelCustodySession: typeof cancelCustodySession;
  getStudentCustodyHistory: typeof getStudentCustodyHistory;
}

interface CustodyRouteOptions {
  services?: CustodyRouteServices;
}

const defaultServices: CustodyRouteServices = {
  listGuardPosts,
  createCustodyAttempt,
  getCustodySessionStatus,
  retryCustodySession,
  cancelCustodySession,
  getStudentCustodyHistory,
};

export default async function custodyRoutes(
  server: FastifyInstance,
  options: CustodyRouteOptions = {}
) {
  const services = options.services ?? defaultServices;

  server.get(
    '/guard-posts',
    {
      preHandler: [requireAuth],
    },
    async (): Promise<{ guard_posts: GuardPostRecord[] }> => {
      return services.listGuardPosts();
    }
  );

  server.post<{ Body: CreateCustodyAttemptRequest }>(
    '/attempts',
    {
      preHandler: [requireAuth],
      schema: {
        body: {
          type: 'object',
          required: [
            'post_id',
            'guard_post_id',
            'handover_image_url',
            'handover_image_hash',
            'session_token',
          ],
          properties: {
            post_id: { type: 'number' },
            guard_post_id: { type: 'string', minLength: 1 },
            handover_image_url: { type: 'string', minLength: 1 },
            handover_image_hash: { type: 'string', minLength: 1 },
            session_token: { type: 'string', minLength: 1 },
          },
          additionalProperties: false,
        },
      },
    },
    async (request): Promise<CreateCustodyAttemptResponse> => {
      if (!request.user) {
        throw createHttpError('Unauthorized', 401);
      }

      return services.createCustodyAttempt({
        actor: request.user,
        ...request.body,
      });
    }
  );

  server.get<{ Params: { qrCodeSessionId: string } }>(
    '/sessions/:qrCodeSessionId/status',
    {
      preHandler: [requireAuth],
      schema: {
        params: {
          type: 'object',
          required: ['qrCodeSessionId'],
          properties: {
            qrCodeSessionId: { type: 'string', minLength: 1 },
          },
        },
      },
    },
    async (request): Promise<CustodySessionStatusResponse> => {
      if (!request.user) {
        throw createHttpError('Unauthorized', 401);
      }

      return services.getCustodySessionStatus({
        actor: request.user,
        qr_code_session_id: request.params.qrCodeSessionId,
      });
    }
  );

  server.post<{
    Params: { qrCodeSessionId: string };
    Body: RetryCustodySessionRequest;
  }>(
    '/sessions/:qrCodeSessionId/retry',
    {
      preHandler: [requireAuth],
      schema: {
        params: {
          type: 'object',
          required: ['qrCodeSessionId'],
          properties: {
            qrCodeSessionId: { type: 'string', minLength: 1 },
          },
        },
        body: {
          type: 'object',
          required: ['session_token'],
          properties: {
            session_token: { type: 'string', minLength: 1 },
          },
          additionalProperties: false,
        },
      },
    },
    async (request): Promise<RetryCustodySessionResponse> => {
      if (!request.user) {
        throw createHttpError('Unauthorized', 401);
      }

      return services.retryCustodySession({
        actor: request.user,
        qr_code_session_id: request.params.qrCodeSessionId,
        ...request.body,
      });
    }
  );

  server.post<{ Params: { qrCodeSessionId: string } }>(
    '/sessions/:qrCodeSessionId/cancel',
    {
      preHandler: [requireAuth],
      schema: {
        params: {
          type: 'object',
          required: ['qrCodeSessionId'],
          properties: {
            qrCodeSessionId: { type: 'string', minLength: 1 },
          },
        },
      },
    },
    async (request): Promise<CancelCustodySessionResponse> => {
      if (!request.user) {
        throw createHttpError('Unauthorized', 401);
      }

      return services.cancelCustodySession({
        actor: request.user,
        qr_code_session_id: request.params.qrCodeSessionId,
      });
    }
  );

  server.get<{ Params: { postId: string } }>(
    '/posts/:postId/history',
    {
      preHandler: [requireAuth],
      schema: {
        params: {
          type: 'object',
          required: ['postId'],
          properties: {
            postId: { type: 'string', pattern: '^[0-9]+$' },
          },
        },
      },
    },
    async (request): Promise<StudentCustodyHistoryResponse> => {
      if (!request.user) {
        throw createHttpError('Unauthorized', 401);
      }

      const postId = parseInt(request.params.postId, 10);
      if (!Number.isFinite(postId)) {
        throw createHttpError('Invalid postId', 400);
      }

      return services.getStudentCustodyHistory({
        actor: request.user,
        post_id: postId,
      });
    }
  );
}
