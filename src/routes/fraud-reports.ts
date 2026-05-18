import { FastifyInstance } from 'fastify';
import { getSupabaseClient } from '../services/supabase.js';
import { requireAuth, requireStaff } from '../middleware/auth.js';
import {
  FraudReportCreateRequest,
  FraudReportListResponse,
  FraudReportResolveRequest,
  FraudReportStatus,
} from '../types/fraud-reports.js';
import logger from '../utils/logger.js';
import { parsePagination } from '../utils/pagination.js';
import { logAudit, getUserName } from '../utils/audit-logger.js';
import { createHttpError, normalizeUpstreamError } from '../utils/http-error.js';
import { getFraudReportStatusAuditEntry } from '../utils/fraud-report-audit.js';

export default async function fraudReportsRoutes(server: FastifyInstance) {
  // GET /fraud-reports/check-duplicates - Check for duplicate reports
  server.get<{
    Querystring: {
      post_id: string;
      user_id?: string;
      concern?: string;
    };
  }>(
    '/check-duplicates',
    {
      preHandler: [requireAuth],
    },
    async (request) => {
      const supabase = getSupabaseClient();
      const { post_id, concern } = request.query;
      const reporterId = request.user?.user_id;

      if (!reporterId) {
        throw createHttpError('Unauthorized', 401);
      }

      const postIdNum = parseInt(post_id, 10);

      // Check if the same user already reported this post
      let selfQuery = supabase
        .from('fraud_reports_table')
        .select('report_id', { count: 'exact', head: true })
        .eq('post_id', postIdNum)
        .eq('reported_by', reporterId);

      if (concern) {
        selfQuery = selfQuery.eq('reason_for_reporting', concern);
      }

      const { count: selfCount, error: selfError } = await selfQuery;

      if (selfError) {
        logger.error({ error: selfError, post_id, reporterId }, 'Failed to check self duplicates');
        throw new Error('Failed to check duplicates');
      }

      // Check if other users have reported this post
      let othersQuery = supabase
        .from('fraud_reports_table')
        .select('report_id', { count: 'exact', head: true })
        .eq('post_id', postIdNum)
        .neq('reported_by', reporterId);

      if (concern) {
        othersQuery = othersQuery.eq('reason_for_reporting', concern);
      }

      const { count: othersCount, error: othersError } = await othersQuery;

      if (othersError) {
        logger.error({ error: othersError, post_id, reporterId }, 'Failed to check others duplicates');
        throw new Error('Failed to check duplicates');
      }

      return {
        has_duplicate_self: (selfCount || 0) > 0,
        has_duplicate_others: (othersCount || 0) > 0,
      };
    }
  );

  // POST /fraud-reports - Create fraud report
  server.post<{ Body: FraudReportCreateRequest }>(
    '/',
    {
      preHandler: [requireAuth],
      schema: {
        body: {
          type: 'object',
          required: ['post_id', 'reason'],
          properties: {
            post_id: { type: 'number' },
            reason: { type: 'string', minLength: 1 },
            proof_image_url: { type: ['string', 'null'] },
            reported_by: { type: ['string', 'null'] },
            claim_id: { type: ['string', 'null'] },
            claimer_name: { type: ['string', 'null'] },
            claimer_school_email: { type: ['string', 'null'] },
            claimer_contact_num: { type: ['string', 'null'] },
            claimed_at: { type: ['string', 'null'] },
            claim_processed_by_staff_id: { type: ['string', 'null'] },
          },
          additionalProperties: false,
        },
      },
    },
    async (request) => {
      const supabase = getSupabaseClient();
      const body = request.body;
      const reporterId = request.user?.user_id;

      if (!reporterId) {
        throw createHttpError('Unauthorized', 401);
      }

      const { data, error } = await supabase.rpc('create_or_get_fraud_report', {
        p_post_id: body.post_id,
        p_reason: body.reason,
        p_proof_image_url: body.proof_image_url,
        p_reported_by: reporterId,
        p_claim_id: body.claim_id,
        p_claimer_name: body.claimer_name,
        p_claimer_school_email: body.claimer_school_email,
        p_claimer_contact_num: body.claimer_contact_num,
        p_claimed_at: body.claimed_at,
        p_claim_processed_by_staff_id: body.claim_processed_by_staff_id,
      });

      if (error) {
        logger.error({ error }, 'Failed to create fraud report');
        throw normalizeUpstreamError(error, {
          statusCode: 500,
          message: 'Failed to create fraud report',
          code: 'FRAUD_REPORT_CREATE_FAILED',
        });
      }

      logger.info({ reportId: data }, 'Fraud report created');
      return { success: true, report_id: data };
    }
  );

  // GET /fraud-reports/:id - Get single fraud report detail
  server.get<{ Params: { id: string } }>(
    '/:id',
    {
      preHandler: [requireStaff],
    },
    async (request) => {
      const supabase = getSupabaseClient();
      const reportId = request.params.id;

      const { data: report, error } = await supabase
        .from('fraud_reports_public_v')
        .select('*')
        .eq('report_id', reportId)
        .single();

      if (error || !report) {
        logger.error({ error, reportId }, 'Failed to fetch fraud report');
        throw createHttpError('Fraud report not found', 404);
      }

      return report;
    }
  );

  // GET /fraud-reports - List fraud reports with pagination and filtering
  server.get<{
    Querystring: {
      limit?: string;
      offset?: string;
      exclude?: string; // Comma-separated IDs to exclude
      ids?: string; // Comma-separated IDs to fetch specific reports
      sort?: 'asc' | 'desc';
    };
  }>(
    '/',
    {
      preHandler: [requireStaff],
    },
    async (request): Promise<FraudReportListResponse> => {
      const supabase = getSupabaseClient();
      const { limit, offset, exclude, ids, sort } = request.query;

      const { limit: limitNum, offset: offsetNum } = parsePagination(limit, offset);
      const sortDirection = sort === 'asc';

      let query = supabase
        .from('fraud_reports_public_v')
        .select('*')
        .order('date_reported', { ascending: sortDirection });

      // Filter by specific IDs if provided
      if (ids) {
        const idArray = ids.split(',').map((id) => id.trim());
        query = query.in('report_id', idArray);
      } else {
        // Apply exclude filter if provided (and not using ids filter)
        if (exclude) {
          const excludeArray = exclude.split(',').map((id) => id.trim());
          query = query.not('report_id', 'in', `(${excludeArray.join(',')})`);
        }

        // Apply pagination
        query = query.range(offsetNum, offsetNum + limitNum - 1);
      }

      const { data: reports, error } = await query;

      if (error) {
        logger.error({ error }, 'Failed to fetch fraud reports');
        throw new Error('Failed to fetch fraud reports');
      }

      return { reports: reports || [], count: reports?.length };
    }
  );

  // GET /fraud-reports/:id/status - Get fraud report status
  server.get<{ Params: { id: string } }>(
    '/:id/status',
    {
      preHandler: [requireStaff],
    },
    async (request) => {
      const supabase = getSupabaseClient();
      const reportId = request.params.id;

      const { data, error } = await supabase
        .from('fraud_reports_table')
        .select('report_status')
        .eq('report_id', reportId)
        .single();

      if (error || !data) {
        logger.error({ error, reportId }, 'Failed to fetch fraud report status');
        throw createHttpError('Fraud report not found', 404);
      }

      return { report_status: data.report_status };
    }
  );

  // PUT /fraud-reports/:id/status - Update status (changed from PATCH for consistency)
  server.put<{
    Params: { id: string };
    Body: {
      status: FraudReportStatus;
      processed_by_staff_id?: string;
    };
  }>(
    '/:id/status',
    {
      preHandler: [requireStaff],
      schema: {
        body: {
          type: 'object',
          required: ['status'],
          properties: {
            status: {
              type: 'string',
              enum: ['under_review', 'verified', 'rejected', 'resolved', 'open'],
            },
            processed_by_staff_id: { type: 'string' },
          },
          additionalProperties: false,
        },
      },
    },
    async (request) => {
      const supabase = getSupabaseClient();
      const reportId = request.params.id;
      const { status } = request.body;
      const staffId = request.user?.user_id;

      if (!staffId) {
        throw createHttpError('Unauthorized', 401);
      }

      // Get report details for audit log
      const { data: reportData, error: reportError } = await supabase
        .from('fraud_reports_public_v')
        .select('post_id, report_status, item_name, claimer_name, claimer_school_email, reporter_name, fraud_reviewer_id')
        .eq('report_id', reportId)
        .single();

      if (reportError || !reportData) {
        logger.error({ error: reportError, reportId }, 'Failed to fetch fraud report before status update');
        throw createHttpError('Fraud report not found', 404);
      }

      if (status === 'open' && reportData.report_status !== 'under_review') {
        throw createHttpError('Only reports under review can be opened', 400);
      }

      if (status === 'rejected' && reportData.report_status !== 'under_review') {
        throw createHttpError('Only reports under review can be rejected', 400);
      }

      const updateData: { report_status: FraudReportStatus; processed_by_staff_id?: string } = {
        report_status: status,
      };

      if (status === 'open' || status === 'rejected') {
        updateData.processed_by_staff_id = staffId;
      }

      const { error } = await supabase
        .from('fraud_reports_table')
        .update(updateData)
        .eq('report_id', reportId);

      if (error) {
        logger.error({ error, reportId }, 'Failed to update fraud report status');
        throw normalizeUpstreamError(error, {
          statusCode: 500,
          message: 'Failed to update fraud report status',
          code: 'FRAUD_REPORT_STATUS_UPDATE_FAILED',
        });
      }

      if (status === 'rejected') {
        const { error: restorePostError } = await supabase
          .from('post_table')
          .update({ status: 'accepted' })
          .eq('post_id', reportData.post_id);

        if (restorePostError) {
          logger.error({ error: restorePostError, reportId }, 'Failed to restore post status after fraud report rejection');
          throw normalizeUpstreamError(restorePostError, {
            statusCode: 500,
            message: 'Failed to restore post status',
            code: 'FRAUD_REPORT_POST_RESTORE_FAILED',
          });
        }
      }

      // Log to audit trail
      const staffName = await getUserName(staffId);
      const timestamp = new Date().toISOString();
      const deleteClaim = false;
      const { actionType, message } = getFraudReportStatusAuditEntry({
        staffName,
        reportId,
        status,
        reportTitle: reportData.item_name,
      });

      await logAudit({
        userId: staffId,
        actionType,
        details: {
          message,
          report_id: reportId,
          report_title: reportData.item_name ?? null,
          post_id: reportData.post_id?.toString(),
          old_status: reportData.report_status,
          new_status: status,
          delete_claim: status === 'resolved' ? deleteClaim : undefined,
          resolved_at: status === 'resolved' ? timestamp : undefined,
          timestamp,
        },
        recordId: reportId,
      });

      logger.info({ reportId, status, staffId }, 'Fraud report status updated');
      return { success: true };
    }
  );

  // POST /fraud-reports/:id/resolve - Resolve fraud report
  server.post<{ Params: { id: string }; Body: FraudReportResolveRequest }>(
    '/:id/resolve',
    {
      preHandler: [requireStaff],
    },
    async (request) => {
      const supabase = getSupabaseClient();
      const reportId = request.params.id;
      const { delete_claim } = request.body;
      const staffId = request.user?.user_id;

      if (!staffId) {
        throw createHttpError('Unauthorized', 401);
      }

      // Get report details for audit log
      const { data: reportData, error: reportError } = await supabase
        .from('fraud_reports_public_v')
        .select('post_id, report_status, fraud_reviewer_id')
        .eq('report_id', reportId)
        .single();

      if (reportError || !reportData) {
        logger.error({ error: reportError, reportId }, 'Failed to fetch fraud report before resolving');
        throw createHttpError('Fraud report not found', 404);
      }

      if (reportData.report_status !== 'open') {
        throw createHttpError('Only open fraud reports can be closed', 400);
      }

      if (reportData.fraud_reviewer_id !== staffId) {
        throw createHttpError('Only the staff member who opened this report can close it', 403);
      }

      const { data, error } = await supabase.rpc('resolve_fraud_report', {
        p_report_id: reportId,
        p_delete_claim: delete_claim || false,
        p_processed_by_staff_id: staffId,
      });

      if (error) {
        logger.error({ error, reportId }, 'Failed to resolve fraud report');
        throw normalizeUpstreamError(error, {
          statusCode: 500,
          message: 'Failed to resolve fraud report',
          code: 'FRAUD_REPORT_RESOLVE_FAILED',
        });
      }

      if (Array.isArray(data) && data[0] && data[0].success === false) {
        throw createHttpError(data[0].message || 'Failed to resolve fraud report', 400);
      }

      // Log to audit trail
      const staffName = await getUserName(staffId);

      await logAudit({
        userId: staffId,
        actionType: 'fraud_report_resolved',
        details: {
          message: delete_claim
            ? `${staffName} resolved fraud report ${reportId} and removed the linked claim`
            : `${staffName} resolved fraud report ${reportId}`,
          report_id: reportId,
          post_id: reportData.post_id?.toString(),
          delete_claim: delete_claim || false,
          resolved_at: new Date().toISOString(),
        },
        recordId: reportId,
      });

      logger.info({ reportId }, 'Fraud report resolved');
      return { success: true, data };
    }
  );

  // DELETE /fraud-reports/:id - Delete fraud report
  server.delete<{ Params: { id: string } }>(
    '/:id',
    {
      preHandler: [requireStaff],
    },
    async (request) => {
      const supabase = getSupabaseClient();
      const reportId = request.params.id;
      const staffId = request.user?.user_id;

      if (!staffId) {
        throw createHttpError('Unauthorized', 401);
      }

      const { data: reportData, error: reportError } = await supabase
        .from('fraud_reports_public_v')
        .select('post_id, report_status')
        .eq('report_id', reportId)
        .single();

      if (reportError || !reportData) {
        logger.error({ error: reportError, reportId }, 'Failed to fetch fraud report before deletion');
        throw createHttpError('Fraud report not found', 404);
      }

      if (reportData.report_status !== 'rejected') {
        throw createHttpError('Only rejected fraud reports can be deleted', 400);
      }

      const { error } = await supabase
        .from('fraud_reports_table')
        .delete()
        .eq('report_id', reportId);

      if (error) {
        logger.error({ error, reportId }, 'Failed to delete fraud report');
        throw normalizeUpstreamError(error, {
          statusCode: 500,
          message: 'Failed to delete fraud report',
          code: 'FRAUD_REPORT_DELETE_FAILED',
        });
      }

      const staffName = await getUserName(staffId);

      await logAudit({
        userId: staffId,
        actionType: 'fraud_report_deleted',
        details: {
          message: `${staffName} deleted fraud report ${reportId}`,
          report_id: reportId,
          post_id: reportData.post_id?.toString(),
          deleted_at: new Date().toISOString(),
        },
        recordId: reportId,
      });

      logger.info({ reportId }, 'Fraud report deleted');
      return { success: true };
    }
  );
}
