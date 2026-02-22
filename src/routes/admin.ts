import { FastifyInstance } from 'fastify';
import { getSupabaseClient } from '../services/supabase.js';
import { requireAdmin, requireStaff } from '../middleware/auth.js';
import { DashboardStats } from '../types/search.js';
import logger from '../utils/logger.js';

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
    },
    async (request) => {
      const supabase = getSupabaseClient();
      const { limit = 20, offset = 0 } = request.query as { limit?: number; offset?: number };
      const limitNum = Math.min(limit, 100);

      const { data, error } = await supabase
        .from('audit_table')
        .select('*, user_table(*)')
        .order('timestamp', { ascending: false })
        .range(offset, offset + limitNum - 1);

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
    },
    async (request) => {
      const supabase = getSupabaseClient();
      const userId = request.params.userId;
      const { limit = 20, offset = 0 } = request.query as { limit?: number; offset?: number };
      const limitNum = Math.min(limit, 100);

      const { data, error } = await supabase
        .from('audit_table')
        .select('*, user_table(*)')
        .eq('user_id', userId)
        .order('timestamp', { ascending: false })
        .range(offset, offset + limitNum - 1);

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
    },
    async (request) => {
      const supabase = getSupabaseClient();
      const actionType = request.params.actionType;
      const { limit = 20, offset = 0 } = request.query as { limit?: number; offset?: number };
      const limitNum = Math.min(limit, 100);

      const { data, error } = await supabase
        .from('audit_table')
        .select('*, user_table(*)')
        .eq('action', actionType)
        .order('timestamp', { ascending: false })
        .range(offset, offset + limitNum - 1);

      if (error) {
        logger.error({ error, actionType }, 'Failed to fetch audit logs by action');
        throw new Error('Failed to fetch audit logs');
      }

      return { logs: data || [] };
    }
  );
}
