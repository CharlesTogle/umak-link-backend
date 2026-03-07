import { getSupabaseClient } from '../services/supabase.js';
import logger from './logger.js';

export interface AuditLogParams {
  userId: string;
  actionType: string;
  details: Record<string, unknown>;
  tableName?: string;
  recordId?: string;
}

/**
 * Insert an audit log entry
 * This is a non-blocking operation - errors are logged but don't throw
 */
export async function logAudit(params: AuditLogParams): Promise<void> {
  const { userId, actionType, details, tableName = 'audit_table', recordId = userId } = params;

  try {
    const supabase = getSupabaseClient();

    const { error } = await supabase.rpc('insert_audit_log', {
      p_user_id: userId,
      p_action_type: actionType,
      p_target_entity_type: tableName,
      p_target_entity_id: recordId,
      p_details: details,
    });

    if (error) {
      logger.error({ error, userId, actionType }, 'Failed to insert audit log');
    } else {
      logger.debug({ userId, actionType, recordId }, 'Audit log inserted');
    }
  } catch (error) {
    // Non-blocking: log error but don't throw
    logger.error({ error, userId, actionType }, 'Exception inserting audit log');
  }
}

/**
 * Get user name for audit log message
 */
export async function getUserName(userId: string): Promise<string> {
  try {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('user_table')
      .select('user_name')
      .eq('user_id', userId)
      .single();

    if (error || !data) {
      return 'Staff';
    }

    return data.user_name || 'Staff';
  } catch (error) {
    return 'Staff';
  }
}
