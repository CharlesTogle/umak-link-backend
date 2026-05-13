import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { expireCustodySessions } from '../services/custody.js';
import { ExpireCustodySessionsResponse } from '../types/custody.js';
import { extractBearerToken, getAuthorizationHeader } from '../utils/http-headers.js';

export interface CustodyJobsRouteServices {
  expireCustodySessions: typeof expireCustodySessions;
}

interface CustodyJobsRouteOptions {
  services?: CustodyJobsRouteServices;
}

const defaultServices: CustodyJobsRouteServices = {
  expireCustodySessions,
};

function verifySystemToken(request: FastifyRequest): boolean {
  const expectedToken = process.env.SYSTEM_TOKEN;
  const token = extractBearerToken(getAuthorizationHeader(request));
  return Boolean(expectedToken && token === expectedToken);
}

function replyUnauthorized(reply: FastifyReply): void {
  reply.status(401).send({
    error: 'Unauthorized',
    message: 'Invalid system token',
  });
}

export default async function custodyJobsRoutes(
  server: FastifyInstance,
  options: CustodyJobsRouteOptions = {}
) {
  const services = options.services ?? defaultServices;

  server.post(
    '/expire-sessions',
    {
      schema: {
        headers: {
          type: 'object',
          required: ['authorization'],
          properties: {
            authorization: { type: 'string', minLength: 1 },
          },
        },
      },
    },
    async (request, reply): Promise<ExpireCustodySessionsResponse | void> => {
      if (!verifySystemToken(request)) {
        replyUnauthorized(reply);
        return;
      }

      return services.expireCustodySessions();
    }
  );
}
