import { FastifyInstance } from 'fastify';
import { getSupabaseClient } from '../services/supabase.js';
import { requireAuth, requireStaff } from '../middleware/auth.js';
import {
  FraudReportCreateRequest,
  FraudReportListResponse,
  FraudReportResolveRequest,
} from '../types/fraud-reports.js';
import logger from '../utils/logger.js';
import { parsePagination } from '../utils/pagination.js';
import { logAudit, getUserName } from '../utils/audit-logger.js';

export default async function fraudReportsRoutes(server: FastifyInstance) {
  // GET /fraud-reports/check-duplicates - Check for duplicate reports
  server.get<{
    Querystring: {
      post_id: string;
      user_id: string;
      concern?: string;
    };
  }>(
    '/check-duplicates',
    {
      preHandler: [requireAuth],
    },
    async (request) => {
      const supabase = getSupabaseClient();
      const { post_id, user_id, concern } = request.query;

      const postIdNum = parseInt(post_id, 10);

      // Check if the same user already reported this post
      let selfQuery = supabase
        .from('fraud_reports_table')
        .select('report_id', { count: 'exact', head: true })
        .eq('post_id', postIdNum)
        .eq('reported_by', user_id);

      if (concern) {
        selfQuery = selfQuery.eq('reason_for_reporting', concern);
      }

      const { count: selfCount, error: selfError } = await selfQuery;

      if (selfError) {
        logger.error({ error: selfError, post_id, user_id }, 'Failed to check self duplicates');
        throw new Error('Failed to check duplicates');
      }

      // Check if other users have reported this post
      let othersQuery = supabase
        .from('fraud_reports_table')
        .select('report_id', { count: 'exact', head: true })
        .eq('post_id', postIdNum)
        .neq('reported_by', user_id);

      if (concern) {
        othersQuery = othersQuery.eq('reason_for_reporting', concern);
      }

      const { count: othersCount, error: othersError } = await othersQuery;

      if (othersError) {
        logger.error({ error: othersError, post_id, user_id }, 'Failed to check others duplicates');
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
        throw new Error('Unauthorized');
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
        throw new Error(error.message || 'Failed to create fraud report');
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
        throw new Error('Fraud report not found');
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
        throw new Error('Fraud report not found');
      }

      return { report_status: data.report_status };
    }
  );

  // PUT /fraud-reports/:id/status - Update status (changed from PATCH for consistency)
  server.put<{
    Params: { id: string };
    Body: {
      status: string;
      processed_by_staff_id?: string;
    };
  }>(
    '/:id/status',
    {
      preHandler: [requireStaff],
    },
    async (request) => {
      const supabase = getSupabaseClient();
      const reportId = request.params.id;
      const { status, processed_by_staff_id } = request.body;
      const staffId = request.user?.user_id;

      // Get report details for audit log
      const { data: reportData } = await supabase
        .from('fraud_reports_public_v')
        .select('post_id, report_status')
        .eq('report_id', reportId)
        .single();

      const updateData: any = { report_status: status };
      if (processed_by_staff_id) {
        updateData.processed_by_staff_id = processed_by_staff_id;
      }

      const { error } = await supabase
        .from('fraud_reports_table')
        .update(updateData)
        .eq('report_id', reportId);

      if (error) {
        logger.error({ error, reportId }, 'Failed to update fraud report status');
        throw new Error(error.message || 'Failed to update status');
      }

      // Log to audit trail
      if (staffId && reportData) {
        const staffName = await getUserName(staffId);

        let actionType = '';
        let message = '';

        if (status === 'resolved') {
          actionType = 'fraud_report_resolved';
          message = `${staffName} resolved fraud report ${reportId}`;
        } else if (status === 'rejected') {
          actionType = 'fraud_report_rejected';
          message = `${staffName} rejected fraud report ${reportId}`;
        } else if (status === 'open' || status === 'under_review') {
          actionType = 'fraud_report_marked_open';
          message = `${staffName} marked fraud report ${reportId} as ${status}`;
        } else {
          actionType = 'fraud_report_status_changed';
          message = `${staffName} changed fraud report status to ${status}`;
        }

        await logAudit({
          userId: staffId,
          actionType,
          details: {
            message,
            report_id: reportId,
            post_id: reportData.post_id?.toString(),
            old_status: reportData.report_status,
            new_status: status,
            timestamp: new Date().toISOString(),
          },
          recordId: reportId,
        });
      }

      logger.info({ reportId, status, processed_by_staff_id }, 'Fraud report status updated');
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

      // Get report details for audit log
      const { data: reportData } = await supabase
        .from('fraud_reports_public_v')
        .select('post_id')
        .eq('report_id', reportId)
        .single();

      const { data, error } = await supabase.rpc('resolve_fraud_report', {
        p_report_id: reportId,
        p_delete_claim: delete_claim || false,
      });

      if (error) {
        logger.error({ error, reportId }, 'Failed to resolve fraud report');
        throw new Error(error.message || 'Failed to resolve fraud report');
      }

      // Log to audit trail
      if (staffId) {
        const staffName = await getUserName(staffId);

        await logAudit({
          userId: staffId,
          actionType: 'fraud_report_resolved',
          details: {
            message: `${staffName} resolved fraud report ${reportId}${delete_claim ? ' and deleted the claim' : ''}`,
            report_id: reportId,
            post_id: reportData?.post_id?.toString(),
            delete_claim: delete_claim || false,
            resolved_at: new Date().toISOString(),
          },
          recordId: reportId,
        });
      }

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

      const { error } = await supabase
        .from('fraud_reports_table')
        .delete()
        .eq('report_id', reportId);

      if (error) {
        logger.error({ error, reportId }, 'Failed to delete fraud report');
        throw new Error(error.message || 'Failed to delete fraud report');
      }

      logger.info({ reportId }, 'Fraud report deleted');
      return { success: true };
    }
  );
}
