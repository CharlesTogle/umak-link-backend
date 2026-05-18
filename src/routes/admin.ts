import { FastifyInstance } from 'fastify';
import { getSupabaseClient } from '../services/supabase.js';
import { requireAdmin, requireStaff } from '../middleware/auth.js';
import { DashboardStats } from '../types/search.js';
import logger from '../utils/logger.js';
import { parsePagination } from '../utils/pagination.js';
import { AUDIT_TIMEOUT_MS, withTimeout } from '../utils/timeout.js';

type AdminRouteSupabaseClient = Pick<ReturnType<typeof getSupabaseClient>, 'from' | 'rpc'>;

export interface AdminRouteServices {
  getSupabaseClient: () => AdminRouteSupabaseClient;
}

interface AdminRoutesOptions {
  services?: AdminRouteServices;
}

interface WeeklyStatsRpcRow {
  week_start: string;
  missing_count: number | null;
  found_count: number | null;
  reports_count: number | null;
  pending_count: number | null;
}

interface ManilaDateParts {
  year: number;
  month: number;
  day: number;
}

interface ManilaDateTimeParts {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  second: string;
}

interface AuditLogViewRow {
  log_id: string;
  user_id: string | null;
  user_name: string | null;
  email: string | null;
  profile_picture_url: string | null;
  action_type: string | null;
  details: Record<string, unknown> | null;
  timestamp: string | null;
  timestamp_local?: string | null;
}

const PHILIPPINE_TIMEZONE = 'Asia/Manila';
const PHILIPPINE_UTC_OFFSET = '+08:00';
const HAS_EXPLICIT_OFFSET_PATTERN = /(Z|[+-]\d{2}:\d{2})$/;

const HIDDEN_ADMIN_AUDIT_ACTION_TYPES = [
  'custody_attempt_created',
  'custody_attempt_cancelled',
  'custody_session_retried',
  'custody_session_expired',
  'claim_verification_claimer_joined',
  'claim_verification_qr_refreshed',
  'claim_verification_qr_retried',
] as const;

function applyAuditVisibilityFilter<
  T extends { not: (column: string, operator: string, value: string) => T },
>(query: T): T {
  const hiddenActionTypes = HIDDEN_ADMIN_AUDIT_ACTION_TYPES.map(
    (actionType) => `"${actionType}"`
  ).join(',');

  return query.not('action_type', 'in', `(${hiddenActionTypes})`);
}

function getManilaDateParts(now = new Date()): ManilaDateParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: PHILIPPINE_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);

  const year = Number(parts.find((part) => part.type === 'year')?.value);
  const month = Number(parts.find((part) => part.type === 'month')?.value);
  const day = Number(parts.find((part) => part.type === 'day')?.value);

  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    throw new Error('Failed to resolve Asia/Manila date parts for weekly stats');
  }

  return { year, month, day };
}

function getManilaDateTimeParts(date: Date): ManilaDateTimeParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: PHILIPPINE_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);

  const getPart = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '00';

  return {
    year: getPart('year'),
    month: getPart('month'),
    day: getPart('day'),
    hour: getPart('hour'),
    minute: getPart('minute'),
    second: getPart('second'),
  };
}

function getOptionalString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseAuditTimestamp(value: unknown): Date | null {
  const rawValue = getOptionalString(value);
  if (!rawValue) return null;

  // Audit log view timestamps are returned without an offset and represent UTC.
  const normalizedValue = HAS_EXPLICIT_OFFSET_PATTERN.test(rawValue)
    ? rawValue
    : `${rawValue}Z`;
  const parsed = new Date(normalizedValue);

  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed;
}

function formatManilaIso(date: Date): string {
  const parts = getManilaDateTimeParts(date);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${PHILIPPINE_UTC_OFFSET}`;
}

function mapAuditLogResponse(log: AuditLogViewRow) {
  const parsedTimestamp = parseAuditTimestamp(log.timestamp);
  const fallbackTimestamp = getOptionalString(log.timestamp) ?? getOptionalString(log.timestamp_local);
  const fallbackTimestampLocal =
    getOptionalString(log.timestamp_local) ?? fallbackTimestamp;
  const timestamp = parsedTimestamp?.toISOString() ?? fallbackTimestamp;
  const timestampLocal = parsedTimestamp
    ? formatManilaIso(parsedTimestamp)
    : fallbackTimestampLocal;

  return {
    audit_id: log.log_id,
    user_id: log.user_id,
    action: log.action_type,
    table_name: 'audit_table',
    record_id: log.log_id,
    changes: log.details,
    timestamp,
    timestamp_local: timestampLocal,
    user_table: {
      user_id: log.user_id,
      user_name: log.user_name,
      email: log.email,
      profile_picture_url: log.profile_picture_url,
    },
  };
}

function getWeeklyBucketStarts(now = new Date()): string[] {
  const { year, month, day } = getManilaDateParts(now);
  const today = new Date(Date.UTC(year, month - 1, day));
  const currentWeekStart = new Date(today);
  currentWeekStart.setUTCDate(today.getUTCDate() - today.getUTCDay());

  const weekStarts: string[] = [];

  for (let i = 11; i >= 0; i--) {
    const weekStart = new Date(currentWeekStart);
    weekStart.setUTCDate(currentWeekStart.getUTCDate() - i * 7);
    weekStarts.push(toWeekKey(weekStart));
  }

  return weekStarts;
}

function formatWeekLabel(weekStart: string): string {
  const monthNames = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];

  const [, monthString, dayString] = normalizeWeekKey(weekStart).split('-');
  const monthIndex = Number(monthString) - 1;
  const day = Number(dayString);

  return `${monthNames[monthIndex]} ${day}`;
}

function normalizeWeekKey(weekStart: string): string {
  return weekStart.slice(0, 10);
}

function toWeekKey(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function buildWeeklyStatsResponse(rows: WeeklyStatsRpcRow[]) {
  const rowMap = new Map(rows.map((row) => [normalizeWeekKey(row.week_start), row]));
  const weekStarts = getWeeklyBucketStarts();

  return {
    weeks: weekStarts.map((weekStart) => formatWeekLabel(weekStart)),
    series: {
      missing: weekStarts.map((weekStart) => rowMap.get(weekStart)?.missing_count ?? 0),
      found: weekStarts.map((weekStart) => rowMap.get(weekStart)?.found_count ?? 0),
      reports: weekStarts.map((weekStart) => rowMap.get(weekStart)?.reports_count ?? 0),
      pending: weekStarts.map((weekStart) => rowMap.get(weekStart)?.pending_count ?? 0),
    },
  };
}

export default async function adminRoutes(server: FastifyInstance, options: AdminRoutesOptions = {}) {
  const services: AdminRouteServices = {
    getSupabaseClient: options.services?.getSupabaseClient ?? getSupabaseClient,
  };

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
      const supabase = services.getSupabaseClient();
      const { user_type } = request.query;

      let query = supabase
        .from('user_table')
        .select(
          'user_id, user_name, email, profile_picture_url, user_type, created_at, last_login'
        );

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
      role: 'User' | 'Staff' | 'Admin' | 'Guard';
      previous_role?: 'User' | 'Staff' | 'Admin' | 'Guard';
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
            role: { type: 'string', enum: ['User', 'Staff', 'Admin', 'Guard'] },
            previous_role: { type: 'string', enum: ['User', 'Staff', 'Admin', 'Guard'] },
          },
          additionalProperties: false,
        },
      },
    },
    async (request) => {
      const supabase = services.getSupabaseClient();
      const actorId = request.user?.user_id;
      const userId = request.params.id;
      const { role, previous_role } = request.body;

      if (!actorId) {
        throw new Error('Unauthorized');
      }

      const { data: existingUser, error: existingUserError } = await supabase
        .from('user_table')
        .select('user_id, user_name, email, user_type')
        .eq('user_id', userId)
        .single();

      if (existingUserError || !existingUser) {
        logger.error(
          { error: existingUserError, userId },
          'Failed to load user before role update'
        );
        throw new Error('Failed to update user role');
      }

      if (previous_role && existingUser.user_type !== previous_role) {
        logger.warn(
          { userId, expectedRole: previous_role, actualRole: existingUser.user_type },
          'Role update rejected because the target role changed before submission'
        );
        throw new Error(
          'User role changed before the update could be applied. Please refresh and try again.'
        );
      }

      if (existingUser.user_type === role) {
        return { success: true };
      }

      // Build the update query
      let query = supabase.from('user_table').update({ user_type: role }).eq('user_id', userId);

      // If previous_role is 'User', ensure we only promote regular users
      if (previous_role === 'User') {
        query = query.eq('user_type', 'User');
      }

      const { data: updatedUser, error } = await query
        .select('user_id, user_name, email, user_type')
        .single();

      if (error || !updatedUser) {
        logger.error({ error, userId, role }, 'Failed to update user role');
        throw new Error('Failed to update user role');
      }

      const auditDetails = {
        message: `Updated ${existingUser.user_name || 'user'} role from ${existingUser.user_type} to ${role}`,
        target_user_id: existingUser.user_id,
        target_user_email: existingUser.email,
        old_role: existingUser.user_type,
        new_role: role,
      };

      const { error: auditError } = await withTimeout(
        Promise.resolve(
          supabase.rpc('insert_audit_log', {
            p_user_id: actorId,
            p_action_type: 'role_updated',
            p_target_entity_type: 'user_table',
            p_target_entity_id: userId,
            p_details: auditDetails,
          })
        ),
        AUDIT_TIMEOUT_MS,
        'Insert role audit log'
      );

      if (auditError) {
        const { error: rollbackError } = await supabase
          .from('user_table')
          .update({ user_type: existingUser.user_type })
          .eq('user_id', userId);

        logger.error(
          { auditError, rollbackError, actorId, userId, role },
          'Failed to write role audit log after updating role'
        );
        throw new Error('Failed to update user role');
      }

      logger.info({ userId, role }, 'User role updated');
      return { success: true, user: updatedUser };
    }
  );

  // GET /admin/dashboard-stats - Dashboard statistics
  server.get<{
    Querystring: { date_range?: string };
  }>(
    '/dashboard-stats',
    {
      preHandler: [requireAdmin],
      schema: {
        querystring: {
          type: 'object',
          properties: {
            date_range: { type: 'string', enum: ['today', 'week', 'month', 'year', 'all'] },
          },
        },
      },
    },
    async (request): Promise<DashboardStats> => {
      const supabase = services.getSupabaseClient();
      const dateRange = request.query.date_range || 'all';

      const { data, error } = await supabase.rpc('get_dashboard_stats', {
        date_range: dateRange,
      });

      if (error) {
        logger.error({ error }, 'Failed to fetch dashboard stats');
        throw new Error('Failed to fetch dashboard stats');
      }

      return (
        data?.[0] || {
          pending_verifications: 0,
          pending_fraud_reports: 0,
          claimed_count: 0,
          unclaimed_count: 0,
          to_review_count: 0,
          lost_count: 0,
          returned_count: 0,
          reported_count: 0,
        }
      );
    }
  );

  // POST /audit-logs - Insert audit log
  server.post<{
    Body: {
      user_id?: string;
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
          required: ['action', 'table_name', 'record_id', 'changes'],
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
      const supabase = services.getSupabaseClient();
      const { action, table_name, record_id, changes } = request.body;
      const userId = request.user?.user_id;

      if (!userId) {
        throw new Error('Unauthorized');
      }

      const { data, error } = await supabase.rpc('insert_audit_log', {
        p_user_id: userId,
        p_action_type: action,
        p_target_entity_type: table_name,
        p_target_entity_id: record_id,
        p_details: changes,
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
      const supabase = services.getSupabaseClient();
      const { limit = 20, offset = 0 } = request.query as { limit?: number; offset?: number };
      const { limit: limitNum, offset: offsetNum } = parsePagination(limit, offset);

      const { data, error } = await applyAuditVisibilityFilter(
        supabase
          .from('view_audit_logs_with_user_details')
          .select('*')
          .order('timestamp', { ascending: false })
          .range(offsetNum, offsetNum + limitNum - 1)
      );

      if (error) {
        logger.error({ error }, 'Failed to fetch audit logs');
        throw new Error('Failed to fetch audit logs');
      }

      // Map view fields to expected frontend format
      const logs = (data || []).map((log) => mapAuditLogResponse(log as AuditLogViewRow));

      return { logs };
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
      const supabase = services.getSupabaseClient();
      const logId = request.params.id;

      const { data: log, error } = await supabase
        .from('view_audit_logs_with_user_details')
        .select('*')
        .eq('log_id', logId)
        .single();

      if (error || !log) {
        logger.error({ error, logId }, 'Failed to fetch audit log');
        throw new Error('Audit log not found');
      }

      // Map view fields to expected frontend format
      return mapAuditLogResponse(log as AuditLogViewRow);
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
      const supabase = services.getSupabaseClient();
      const userId = request.params.userId;
      const { limit = 20, offset = 0 } = request.query as { limit?: number; offset?: number };
      const { limit: limitNum, offset: offsetNum } = parsePagination(limit, offset);

      const { data, error } = await applyAuditVisibilityFilter(
        supabase
          .from('view_audit_logs_with_user_details')
          .select('*')
          .eq('user_id', userId)
          .order('timestamp', { ascending: false })
          .range(offsetNum, offsetNum + limitNum - 1)
      );

      if (error) {
        logger.error({ error, userId }, 'Failed to fetch user audit logs');
        throw new Error('Failed to fetch audit logs');
      }

      // Map view fields to expected frontend format
      const logs = (data || []).map((log) => mapAuditLogResponse(log as AuditLogViewRow));

      return { logs };
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
      const supabase = services.getSupabaseClient();
      const actionType = request.params.actionType;
      const { limit = 20, offset = 0 } = request.query as { limit?: number; offset?: number };
      const { limit: limitNum, offset: offsetNum } = parsePagination(limit, offset);

      if (
        HIDDEN_ADMIN_AUDIT_ACTION_TYPES.includes(
          actionType as (typeof HIDDEN_ADMIN_AUDIT_ACTION_TYPES)[number]
        )
      ) {
        return { logs: [] };
      }

      const { data, error } = await supabase
        .from('view_audit_logs_with_user_details')
        .select('*')
        .eq('action_type', actionType)
        .order('timestamp', { ascending: false })
        .range(offsetNum, offsetNum + limitNum - 1);

      if (error) {
        logger.error({ error, actionType }, 'Failed to fetch audit logs by action');
        throw new Error('Failed to fetch audit logs');
      }

      // Map view fields to expected frontend format
      const logs = (data || []).map((log) => mapAuditLogResponse(log as AuditLogViewRow));

      return { logs };
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
      const supabase = services.getSupabaseClient();
      const { data, error } = await supabase.rpc('get_admin_weekly_stats');

      if (error) {
        logger.error({ error }, 'Failed to fetch weekly stats');
        throw new Error('Failed to fetch weekly stats');
      }

      return buildWeeklyStatsResponse((data as WeeklyStatsRpcRow[] | null) || []);
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
      const supabase = services.getSupabaseClient();
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
  if (
    value.startsWith('=') ||
    value.startsWith('+') ||
    value.startsWith('-') ||
    value.startsWith('@')
  ) {
    return `'${value}`;
  }
  return value;
}
