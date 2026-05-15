import { FastifyInstance } from 'fastify';
import {
  cancelClaimVerificationSession,
  createClaimVerificationSession,
  getClaimVerificationSessionStatus,
  joinClaimVerificationSession,
  retryClaimVerificationSession,
  scanClaimVerificationSession,
} from '../services/claim-verification.js';
import {
  requireAuth,
  requireGuardOrStaffOrAdmin,
} from '../middleware/auth.js';
import {
  CancelClaimVerificationSessionResponse,
  ClaimVerificationSessionStatusResponse,
  CreateClaimVerificationSessionRequest,
  CreateClaimVerificationSessionResponse,
  JoinClaimVerificationSessionRequest,
  JoinClaimVerificationSessionResponse,
  RetryClaimVerificationSessionRequest,
  RetryClaimVerificationSessionResponse,
  ScanClaimVerificationRequest,
  ScanClaimVerificationResponse,
} from '../types/claim-verification.js';
import { createHttpError } from '../utils/http-error.js';

export interface ClaimVerificationRouteServices {
  createClaimVerificationSession: typeof createClaimVerificationSession;
  joinClaimVerificationSession: typeof joinClaimVerificationSession;
  getClaimVerificationSessionStatus: typeof getClaimVerificationSessionStatus;
  retryClaimVerificationSession: typeof retryClaimVerificationSession;
  cancelClaimVerificationSession: typeof cancelClaimVerificationSession;
  scanClaimVerificationSession: typeof scanClaimVerificationSession;
}

interface ClaimVerificationRouteOptions {
  services?: ClaimVerificationRouteServices;
}

const defaultServices: ClaimVerificationRouteServices = {
  createClaimVerificationSession,
  joinClaimVerificationSession,
  getClaimVerificationSessionStatus,
  retryClaimVerificationSession,
  cancelClaimVerificationSession,
  scanClaimVerificationSession,
};

export default async function claimVerificationRoutes(
  server: FastifyInstance,
  options: ClaimVerificationRouteOptions = {}
) {
  const services = options.services ?? defaultServices;

  server.post<{ Body: CreateClaimVerificationSessionRequest }>(
    '/',
    {
      preHandler: [requireGuardOrStaffOrAdmin],
      schema: {
        body: {
          type: 'object',
          required: ['found_post_id'],
          properties: {
            found_post_id: { type: 'number' },
          },
          additionalProperties: false,
        },
      },
    },
    async (request): Promise<CreateClaimVerificationSessionResponse> => {
      if (!request.user) {
        throw createHttpError('Unauthorized', 401);
      }

      return services.createClaimVerificationSession({
        actor: request.user,
        ...request.body,
      });
    }
  );

  server.post<{ Body: JoinClaimVerificationSessionRequest }>(
    '/join',
    {
      preHandler: [requireAuth],
      schema: {
        body: {
          type: 'object',
          required: ['join_code', 'session_token'],
          properties: {
            join_code: { type: 'string', minLength: 1 },
            session_token: { type: 'string', minLength: 1 },
          },
          additionalProperties: false,
        },
      },
    },
    async (request): Promise<JoinClaimVerificationSessionResponse> => {
      if (!request.user) {
        throw createHttpError('Unauthorized', 401);
      }

      return services.joinClaimVerificationSession({
        actor: request.user,
        ...request.body,
      });
    }
  );

  server.get<{ Params: { claimVerificationSessionId: string } }>(
    '/:claimVerificationSessionId/status',
    {
      preHandler: [requireAuth],
      schema: {
        params: {
          type: 'object',
          required: ['claimVerificationSessionId'],
          properties: {
            claimVerificationSessionId: { type: 'string', minLength: 1 },
          },
        },
      },
    },
    async (request): Promise<ClaimVerificationSessionStatusResponse> => {
      if (!request.user) {
        throw createHttpError('Unauthorized', 401);
      }

      return services.getClaimVerificationSessionStatus({
        actor: request.user,
        claim_verification_session_id: request.params.claimVerificationSessionId,
      });
    }
  );

  server.post<{
    Params: { claimVerificationSessionId: string };
    Body: RetryClaimVerificationSessionRequest;
  }>(
    '/:claimVerificationSessionId/retry',
    {
      preHandler: [requireAuth],
      schema: {
        params: {
          type: 'object',
          required: ['claimVerificationSessionId'],
          properties: {
            claimVerificationSessionId: { type: 'string', minLength: 1 },
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
    async (request): Promise<RetryClaimVerificationSessionResponse> => {
      if (!request.user) {
        throw createHttpError('Unauthorized', 401);
      }

      return services.retryClaimVerificationSession({
        actor: request.user,
        claim_verification_session_id: request.params.claimVerificationSessionId,
        ...request.body,
      });
    }
  );

  server.post<{ Params: { claimVerificationSessionId: string } }>(
    '/:claimVerificationSessionId/cancel',
    {
      preHandler: [requireAuth],
      schema: {
        params: {
          type: 'object',
          required: ['claimVerificationSessionId'],
          properties: {
            claimVerificationSessionId: { type: 'string', minLength: 1 },
          },
        },
      },
    },
    async (request): Promise<CancelClaimVerificationSessionResponse> => {
      if (!request.user) {
        throw createHttpError('Unauthorized', 401);
      }

      return services.cancelClaimVerificationSession({
        actor: request.user,
        claim_verification_session_id: request.params.claimVerificationSessionId,
      });
    }
  );

  server.post<{ Body: ScanClaimVerificationRequest }>(
    '/scan',
    {
      preHandler: [requireGuardOrStaffOrAdmin],
      schema: {
        body: {
          type: 'object',
          required: ['claim_qr_session_id', 'session_token'],
          properties: {
            claim_qr_session_id: { type: 'string', minLength: 1 },
            session_token: { type: 'string', minLength: 1 },
          },
          additionalProperties: false,
        },
      },
    },
    async (request): Promise<ScanClaimVerificationResponse> => {
      if (!request.user) {
        throw createHttpError('Unauthorized', 401);
      }

      return services.scanClaimVerificationSession({
        actor: request.user,
        ...request.body,
      });
    }
  );
}
