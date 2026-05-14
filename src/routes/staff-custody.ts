import { FastifyInstance } from 'fastify';
import { requireStaffOnly } from '../middleware/auth.js';
import {
  markPostReceivedInSecurityOffice,
  notifyGuardForCustodyFollowUp,
  openCustodyInvestigation,
  reportPhysicalTake,
} from '../services/custody.js';
import {
  NotifyGuardRequest,
  NotifyGuardResponse,
  OpenCustodyInvestigationResponse,
  PhysicalTakeReportRequest,
  PhysicalTakeReportResponse,
  SecurityOfficeReceiptResponse,
  StaffCustodyPostRequest,
} from '../types/custody.js';
import { createHttpError } from '../utils/http-error.js';

export interface StaffCustodyRouteServices {
  markPostReceivedInSecurityOffice: typeof markPostReceivedInSecurityOffice;
  openCustodyInvestigation: typeof openCustodyInvestigation;
  reportPhysicalTake: typeof reportPhysicalTake;
  notifyGuardForCustodyFollowUp: typeof notifyGuardForCustodyFollowUp;
}

interface StaffCustodyRouteOptions {
  services?: StaffCustodyRouteServices;
}

const defaultServices: StaffCustodyRouteServices = {
  markPostReceivedInSecurityOffice,
  openCustodyInvestigation,
  reportPhysicalTake,
  notifyGuardForCustodyFollowUp,
};

const postIdBodySchema = {
  type: 'object',
  required: ['post_id'],
  properties: {
    post_id: { type: 'number' },
  },
  additionalProperties: false,
} as const;

const postIdGuardIdBodySchema = {
  type: 'object',
  required: ['post_id', 'guard_id'],
  properties: {
    post_id: { type: 'number' },
    guard_id: { type: 'string', minLength: 1 },
  },
  additionalProperties: false,
} as const;

export default async function staffCustodyRoutes(
  server: FastifyInstance,
  options: StaffCustodyRouteOptions = {}
) {
  const services = options.services ?? defaultServices;

  server.post<{ Body: StaffCustodyPostRequest }>(
    '/custody/security-office/receive',
    {
      preHandler: [requireStaffOnly],
      schema: {
        body: postIdBodySchema,
      },
    },
    async (request): Promise<SecurityOfficeReceiptResponse> => {
      if (!request.user) {
        throw createHttpError('Unauthorized', 401);
      }

      return services.markPostReceivedInSecurityOffice({
        actor: request.user,
        ...request.body,
      });
    }
  );

  server.post<{ Body: StaffCustodyPostRequest }>(
    '/custody/investigations/open',
    {
      preHandler: [requireStaffOnly],
      schema: {
        body: postIdBodySchema,
      },
    },
    async (request): Promise<OpenCustodyInvestigationResponse> => {
      if (!request.user) {
        throw createHttpError('Unauthorized', 401);
      }

      return services.openCustodyInvestigation({
        actor: request.user,
        ...request.body,
      });
    }
  );

  server.post<{ Body: PhysicalTakeReportRequest }>(
    '/custody/physical-takes/report',
    {
      preHandler: [requireStaffOnly],
      schema: {
        body: postIdGuardIdBodySchema,
      },
    },
    async (request): Promise<PhysicalTakeReportResponse> => {
      if (!request.user) {
        throw createHttpError('Unauthorized', 401);
      }

      return services.reportPhysicalTake({
        actor: request.user,
        ...request.body,
      });
    }
  );

  server.post<{ Body: NotifyGuardRequest }>(
    '/custody/guards/notify',
    {
      preHandler: [requireStaffOnly],
      schema: {
        body: postIdBodySchema,
      },
    },
    async (request): Promise<NotifyGuardResponse> => {
      if (!request.user) {
        throw createHttpError('Unauthorized', 401);
      }

      return services.notifyGuardForCustodyFollowUp({
        actor: request.user,
        ...request.body,
      });
    }
  );
}
