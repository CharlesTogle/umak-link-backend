import { FastifyInstance } from 'fastify';
import { requireGuard } from '../middleware/auth.js';
import { decideCustodyAttempt, scanCustodySession } from '../services/custody.js';
import {
  GuardDecisionRequest,
  GuardDecisionResponse,
  GuardScanRequest,
  GuardScanResponse,
} from '../types/custody.js';
import { createHttpError } from '../utils/http-error.js';

export interface GuardRouteServices {
  scanCustodySession: typeof scanCustodySession;
  decideCustodyAttempt: typeof decideCustodyAttempt;
}

interface GuardRouteOptions {
  services?: GuardRouteServices;
}

const defaultServices: GuardRouteServices = {
  scanCustodySession,
  decideCustodyAttempt,
};

export default async function guardRoutes(
  server: FastifyInstance,
  options: GuardRouteOptions = {}
) {
  const services = options.services ?? defaultServices;

  server.post<{ Body: GuardScanRequest }>(
    '/custody/scan',
    {
      preHandler: [requireGuard],
      schema: {
        body: {
          type: 'object',
          required: ['qr_code_session_id', 'session_token'],
          properties: {
            qr_code_session_id: { type: 'string', minLength: 1 },
            session_token: { type: 'string', minLength: 1 },
          },
          additionalProperties: false,
        },
      },
    },
    async (request): Promise<GuardScanResponse> => {
      if (!request.user) {
        throw createHttpError('Unauthorized', 401);
      }

      return services.scanCustodySession({
        actor: request.user,
        ...request.body,
      });
    }
  );

  server.post<{
    Params: { custodyAttemptId: string };
    Body: GuardDecisionRequest;
  }>(
    '/custody/attempts/:custodyAttemptId/decision',
    {
      preHandler: [requireGuard],
      schema: {
        params: {
          type: 'object',
          required: ['custodyAttemptId'],
          properties: {
            custodyAttemptId: { type: 'string', minLength: 1 },
          },
        },
        body: {
          type: 'object',
          required: ['qr_code_session_id', 'decision'],
          properties: {
            qr_code_session_id: { type: 'string', minLength: 1 },
            decision: { type: 'string', enum: ['accepted', 'rejected'] },
            decision_reason: { type: 'string' },
          },
          additionalProperties: false,
        },
      },
    },
    async (request): Promise<GuardDecisionResponse> => {
      if (!request.user) {
        throw createHttpError('Unauthorized', 401);
      }

      return services.decideCustodyAttempt({
        actor: request.user,
        custody_attempt_id: request.params.custodyAttemptId,
        ...request.body,
      });
    }
  );
}
