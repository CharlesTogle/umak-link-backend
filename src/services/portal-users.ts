import { getSupabaseClient } from './supabase.js';
import { UserType } from '../types/auth.js';
import logger from '../utils/logger.js';

const USER_SELECT_COLUMNS =
  'user_id, user_name, email, profile_picture_url, user_type, notification_token';

export const DEFAULT_PORTAL_USER_TYPE: UserType = 'User';
export const ALLOWED_PORTAL_EMAIL_SUFFIX = '@umak.edu.ph';

export interface PortalUserRecord {
  user_id: string;
  user_name: string | null;
  email: string | null;
  profile_picture_url: string | null;
  user_type: UserType;
  notification_token: string | null;
}

interface PortalUserSignInInput {
  email: string;
  userName: string | null;
  loginTimestamp: string;
}

function buildUserSignInUpdate(userName: string | null, loginTimestamp: string) {
  const updates: { last_login: string; user_name?: string | null } = {
    last_login: loginTimestamp,
  };

  if (userName !== null) {
    updates.user_name = userName;
  }

  return updates;
}

function isUniqueViolationError(error: { code?: string } | null): boolean {
  return error?.code === '23505';
}

async function updateExistingPortalUser(
  supabase: ReturnType<typeof getSupabaseClient>,
  normalizedEmail: string,
  userName: string | null,
  loginTimestamp: string
): Promise<PortalUserRecord | null> {
  const { data: updatedUser, error: updateError } = await supabase
    .from('user_table')
    .update(buildUserSignInUpdate(userName, loginTimestamp))
    .eq('email', normalizedEmail)
    .select(USER_SELECT_COLUMNS)
    .single();

  if (updateError || !updatedUser) {
    logger.error({ error: updateError, email: normalizedEmail }, 'Failed to update portal user during sign in');
    return null;
  }

  return updatedUser as PortalUserRecord;
}

export function normalizePortalEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isAllowedPortalEmail(email: string): boolean {
  return normalizePortalEmail(email).endsWith(ALLOWED_PORTAL_EMAIL_SUFFIX);
}

export async function syncPortalUserOnSignIn(
  supabase: ReturnType<typeof getSupabaseClient>,
  input: PortalUserSignInInput
): Promise<PortalUserRecord | null> {
  const normalizedEmail = normalizePortalEmail(input.email);
  const { data: existingUser, error: existingUserError } = await supabase
    .from('user_table')
    .select(USER_SELECT_COLUMNS)
    .eq('email', normalizedEmail)
    .maybeSingle();

  if (existingUserError) {
    logger.error({ error: existingUserError, email: normalizedEmail }, 'Failed to load portal user during sign in');
    return null;
  }

  if (existingUser) {
    return updateExistingPortalUser(
      supabase,
      normalizedEmail,
      input.userName,
      input.loginTimestamp
    );
  }

  const { data: insertedUser, error: insertError } = await supabase
    .from('user_table')
    .insert({
      email: normalizedEmail,
      user_name: input.userName,
      last_login: input.loginTimestamp,
      user_type: DEFAULT_PORTAL_USER_TYPE,
    })
    .select(USER_SELECT_COLUMNS)
    .single();

  if (!insertError && insertedUser) {
    return insertedUser as PortalUserRecord;
  }

  if (isUniqueViolationError(insertError)) {
    return updateExistingPortalUser(
      supabase,
      normalizedEmail,
      input.userName,
      input.loginTimestamp
    );
  }

  logger.error({ error: insertError, email: normalizedEmail }, 'Failed to create portal user during sign in');
  return null;
}
