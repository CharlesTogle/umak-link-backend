import { FastifyInstance } from 'fastify';
import { getSupabaseClient } from '../services/supabase.js';
import { requireAdmin, requireStaff } from '../middleware/auth.js';
import { DashboardStats } from '../types/search.js';
import logger from '../utils/logger.js';
import { parsePagination } from '../utils/pagination.js';

export default async function adminRoutes(server: FastifyInstance) {
  // GET /admin/users - List users with filters
  server.get<{
    Querystring: {
      user_type?: string;
    };
  }>(
    '/users',
    {
      preHandler: [requireAdmin],
      schema: {
        querystring: {
          type: 'object',
          properties: {
            user_type: { type: 'string' },
          },
        },
      },
    },
    async (request) => {
      const supabase = getSupabaseClient();
      const { user_type } = request.query;

      let query = supabase
        .from('user_table')
        .select('user_id, user_name, email, profile_picture_url, user_type');

      // Filter by user types if provided (comma-separated)
      if (user_type) {
        const types = user_type.split(',').map((t) => t.trim());
        query = query.in('user_type', types);
      }

      const { data, error } = await query.order('user_name');

      if (error) {
        logger.error({ error }, 'Failed to fetch users');
        throw new Error('Failed to fetch users');
      }

      return { users: data || [] };
    }
  );

  // PUT /admin/users/:id/role - Update user role
  server.put<{
    Params: { id: string };
    Body: {
      role: 'User' | 'Staff' | 'Admin';
      previous_role?: 'User' | 'Staff' | 'Admin';
    };
  }>(
    '/users/:id/role',
    {
      preHandler: [requireAdmin],
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', minLength: 1 },
          },
        },
        body: {
          type: 'object',
          required: ['role'],
          properties: {
            role: { type: 'string', enum: ['User', 'Staff', 'Admin'] },
            previous_role: { type: 'string', enum: ['User', 'Staff', 'Admin'] },
          },
          additionalProperties: false,
        },
      },
    },
    async (request) => {
      const supabase = getSupabaseClient();
      const userId = request.params.id;
      const { role, previous_role } = request.body;

      // Build the update query
      let query = supabase.from('user_table').update({ user_type: role }).eq('user_id', userId);

      // If previous_role is 'User', ensure we only promote regular users
      if (previous_role === 'User') {
        query = query.eq('user_type', 'User');
      }

      const { error } = await query;

      if (error) {
        logger.error({ error, userId, role }, 'Failed to update user role');
        throw new Error('Failed to update user role');
      }

      logger.info({ userId, role }, 'User role updated');
      return { success: true };
    }
  );

  // GET /admin/dashboard-stats - Dashboard statistics
  server.get(
    '/dashboard-stats',
    {
      preHandler: [requireAdmin],
    },
    async (): Promise<DashboardStats> => {
      const supabase = getSupabaseClient();

      const { data, error } = await supabase.rpc('get_dashboard_stats');

      if (error) {
        logger.error({ error }, 'Failed to fetch dashboard stats');
        throw new Error('Failed to fetch dashboard stats');
      }

      return data || {
        pending_verifications: 0,
        pending_fraud_reports: 0,
        claimed_count: 0,
        unclaimed_count: 0,
        to_review_count: 0,
        lost_count: 0,
        returned_count: 0,
        reported_count: 0,
      };
    }
  );

  // POST /audit-logs - Insert audit log
  server.post<{
    Body: {
      user_id: string;
      action: string;
      table_name: string;
      record_id: string;
      changes: Record<string, unknown>;
    };
  }>(
    '/audit-logs',
    {
      preHandler: [requireStaff],
      schema: {
        body: {
          type: 'object',
          required: ['user_id', 'action', 'table_name', 'record_id', 'changes'],
          properties: {
            user_id: { type: 'string', minLength: 1 },
            action: { type: 'string', minLength: 1 },
            table_name: { type: 'string', minLength: 1 },
            record_id: { type: 'string', minLength: 1 },
            changes: { type: 'object' },
          },
          additionalProperties: false,
        },
      },
    },
    async (request) => {
      const supabase = getSupabaseClient();
      const { user_id, action, table_name, record_id, changes } = request.body;

      const { data, error } = await supabase.rpc('insert_audit_log', {
        p_user_id: user_id,
        p_action: action,
        p_table_name: table_name,
        p_record_id: record_id,
        p_changes: changes,
      });

      if (error) {
        logger.error({ error }, 'Failed to insert audit log');
        throw new Error('Failed to insert audit log');
      }

      return { success: true, audit_id: data };
    }
  );

  // GET /audit-logs - List audit logs
  server.get(
    '/audit-logs',
    {
      preHandler: [requireAdmin],
      schema: {
        querystring: {
          type: 'object',
          properties: {
            limit: { type: 'number', minimum: 1, maximum: 100 },
            offset: { type: 'number', minimum: 0 },
          },
        },
      },
    },
    async (request) => {
      const supabase = getSupabaseClient();
      const { limit = 20, offset = 0 } = request.query as { limit?: number; offset?: number };
      const { limit: limitNum, offset: offsetNum } = parsePagination(limit, offset);

      const { data, error } = await supabase
        .from('audit_table')
        .select('*, user_table(*)')
        .order('timestamp', { ascending: false })
        .range(offsetNum, offsetNum + limitNum - 1);

      if (error) {
        logger.error({ error }, 'Failed to fetch audit logs');
        throw new Error('Failed to fetch audit logs');
      }

      return { logs: data || [] };
    }
  );

  // GET /audit-logs/:id - Get single audit log
  server.get<{ Params: { id: string } }>(
    '/audit-logs/:id',
    {
      preHandler: [requireAdmin],
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', minLength: 1 },
          },
        },
      },
    },
    async (request) => {
      const supabase = getSupabaseClient();
      const logId = request.params.id;

      const { data, error } = await supabase
        .from('audit_table')
        .select('*, user_table(*)')
        .eq('audit_id', logId)
        .single();

      if (error || !data) {
        logger.error({ error, logId }, 'Failed to fetch audit log');
        throw new Error('Audit log not found');
      }

      return data;
    }
  );

  // GET /audit-logs/user/:userId - Get audit logs for a user
  server.get<{ Params: { userId: string } }>(
    '/audit-logs/user/:userId',
    {
      preHandler: [requireStaff],
      schema: {
        params: {
          type: 'object',
          required: ['userId'],
          properties: {
            userId: { type: 'string', minLength: 1 },
          },
        },
        querystring: {
          type: 'object',
          properties: {
            limit: { type: 'number', minimum: 1, maximum: 100 },
            offset: { type: 'number', minimum: 0 },
          },
        },
      },
    },
    async (request) => {
      const supabase = getSupabaseClient();
      const userId = request.params.userId;
      const { limit = 20, offset = 0 } = request.query as { limit?: number; offset?: number };
      const { limit: limitNum, offset: offsetNum } = parsePagination(limit, offset);

      const { data, error } = await supabase
        .from('audit_table')
        .select('*, user_table(*)')
        .eq('user_id', userId)
        .order('timestamp', { ascending: false })
        .range(offsetNum, offsetNum + limitNum - 1);

      if (error) {
        logger.error({ error, userId }, 'Failed to fetch user audit logs');
        throw new Error('Failed to fetch audit logs');
      }

      return { logs: data || [] };
    }
  );

  // GET /audit-logs/action/:actionType - Get audit logs by action type
  server.get<{ Params: { actionType: string } }>(
    '/audit-logs/action/:actionType',
    {
      preHandler: [requireAdmin],
      schema: {
        params: {
          type: 'object',
          required: ['actionType'],
          properties: {
            actionType: { type: 'string', minLength: 1 },
          },
        },
        querystring: {
          type: 'object',
          properties: {
            limit: { type: 'number', minimum: 1, maximum: 100 },
            offset: { type: 'number', minimum: 0 },
          },
        },
      },
    },
    async (request) => {
      const supabase = getSupabaseClient();
      const actionType = request.params.actionType;
      const { limit = 20, offset = 0 } = request.query as { limit?: number; offset?: number };
      const { limit: limitNum, offset: offsetNum } = parsePagination(limit, offset);

      const { data, error } = await supabase
        .from('audit_table')
        .select('*, user_table(*)')
        .eq('action', actionType)
        .order('timestamp', { ascending: false })
        .range(offsetNum, offsetNum + limitNum - 1);

      if (error) {
        logger.error({ error, actionType }, 'Failed to fetch audit logs by action');
        throw new Error('Failed to fetch audit logs');
      }

      return { logs: data || [] };
    }
  );

  // GET /admin/stats/weekly - Weekly statistics for chart
  server.get(
    '/stats/weekly',
    {
      preHandler: [requireAdmin],
      schema: {
        querystring: {
          type: 'object',
          properties: {},
        },
      },
    },
    async () => {
      const supabase = getSupabaseClient();
      const weeks: string[] = [];
      const missing: number[] = [];
      const found: number[] = [];
      const reports: number[] = [];
      const pending: number[] = [];

      const today = new Date();
      const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

      // Build promises for all 12 weeks of data
      const promises = [];

      for (let i = 11; i >= 0; i--) {
        const weekStart = new Date(today);
        weekStart.setDate(weekStart.getDate() - weekStart.getDay() - i * 7);
        weekStart.setHours(0, 0, 0, 0);

        const weekEnd = new Date(weekStart);
        weekEnd.setDate(weekEnd.getDate() + 6);
        weekEnd.setHours(23, 59, 59, 999);

        const weekLabel = `${monthNames[weekStart.getMonth()]} ${weekStart.getDate()}`;
        weeks.push(weekLabel);

        promises.push(
          Promise.all([
            supabase
              .from('post_public_view')
              .select('*', { count: 'exact', head: true })
              .eq('item_type', 'missing')
              .gte('submission_date', weekStart.toISOString())
              .lte('submission_date', weekEnd.toISOString()),
            supabase
              .from('post_public_view')
              .select('*', { count: 'exact', head: true })
              .eq('item_type', 'found')
              .gte('submission_date', weekStart.toISOString())
              .lte('submission_date', weekEnd.toISOString()),
            supabase
              .from('fraud_reports_table')
              .select('*', { count: 'exact', head: true })
              .in('report_status', ['open', 'under_review'])
              .gte('date_reported', weekStart.toISOString())
              .lte('date_reported', weekEnd.toISOString()),
            supabase
              .from('post_public_view')
              .select('*', { count: 'exact', head: true })
              .eq('post_status', 'pending')
              .gte('submission_date', weekStart.toISOString())
              .lte('submission_date', weekEnd.toISOString()),
          ])
        );
      }

      const results = await Promise.all(promises);

      results.forEach(([missingRes, foundRes, reportsRes, pendingRes]) => {
        missing.push(missingRes.count || 0);
        found.push(foundRes.count || 0);
        reports.push(reportsRes.count || 0);
        pending.push(pendingRes.count || 0);
      });

      return { weeks, series: { missing, found, reports, pending } };
    }
  );

  // GET /admin/stats/export - Export data for CSV
  server.get<{
    Querystring: { start_date: string; end_date: string };
  }>(
    '/stats/export',
    {
      preHandler: [requireAdmin],
      schema: {
        querystring: {
          type: 'object',
          required: ['start_date', 'end_date'],
          properties: {
            start_date: { type: 'string', minLength: 1 },
            end_date: { type: 'string', minLength: 1 },
          },
        },
      },
    },
    async (request) => {
      const supabase = getSupabaseClient();
      const { start_date, end_date } = request.query;

      if (!start_date || !end_date) {
        throw new Error('start_date and end_date are required');
      }

      const { data, error } = await supabase
        .from('post_public_view')
        .select(
          'poster_name,item_name,item_description,last_seen_location,accepted_by_staff_name,submission_date,claimed_by_name,claimed_by_email,accepted_on_date'
        )
        .gte('submission_date', start_date)
        .lte('submission_date', end_date);

      if (error) {
        logger.error({ error }, 'Failed to fetch export data');
        throw new Error('Failed to fetch export data');
      }

      const rows = (data || []).map((row) => ({
        poster_name: escapeCsvValue(row.poster_name),
        item_name: escapeCsvValue(row.item_name),
        item_description: escapeCsvValue(row.item_description),
        last_seen_location: escapeCsvValue(row.last_seen_location),
        accepted_by_staff_name: escapeCsvValue(row.accepted_by_staff_name),
        submission_date: escapeCsvValue(row.submission_date),
        claimed_by_name: escapeCsvValue(row.claimed_by_name),
        claimed_by_email: escapeCsvValue(row.claimed_by_email),
        accepted_on_date: escapeCsvValue(row.accepted_on_date),
      }));

      return { rows };
    }
  );
}

function escapeCsvValue(value: string | null): string | null {
  if (value === null) return null;
  if (value.startsWith('=') || value.startsWith('+') || value.startsWith('-') || value.startsWith('@')) {
    return `'${value}`;
  }
  return value;
}
