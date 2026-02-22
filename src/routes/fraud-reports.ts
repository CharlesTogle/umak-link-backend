import { FastifyInstance } from 'fastify';
import { getSupabaseClient } from '../services/supabase.js';
import { requireAuth, requireStaff } from '../middleware/auth.js';
import {
  FraudReportCreateRequest,
  FraudReportListResponse,
  FraudReportResolveRequest,
} from '../types/fraud-reports.js';
import logger from '../utils/logger.js';

export default async function fraudReportsRoutes(server: FastifyInstance) {
  // POST /fraud-reports - Create fraud report
  server.post<{ Body: FraudReportCreateRequest }>(
    '/',
    {
      preHandler: [requireAuth],
    },
    async (request) => {
      const supabase = getSupabaseClient();
      const body = request.body;

      const { data, error } = await supabase.rpc('create_or_get_fraud_report', {
        p_post_id: body.post_id,
        p_reason: body.reason,
        p_proof_image_url: body.proof_image_url,
        p_reported_by: body.reported_by,
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

      const limitNum = Math.min(limit ? parseInt(limit, 10) : 20, 100);
      const offsetNum = offset ? parseInt(offset, 10) : 0;
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

      const { data, error } = await supabase.rpc('resolve_fraud_report', {
        p_report_id: reportId,
        p_delete_claim: delete_claim || false,
      });

      if (error) {
        logger.error({ error, reportId }, 'Failed to resolve fraud report');
        throw new Error(error.message || 'Failed to resolve fraud report');
      }

      logger.info({ reportId }, 'Fraud report resolved');
      return { success: true, data };
    }
  );
}
