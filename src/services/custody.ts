import crypto from 'node:crypto';
import { getSupabaseClient } from './supabase.js';
import { createNotification, type NotificationPayload } from './notifications.js';
import { logAudit } from '../utils/audit-logger.js';
import logger from '../utils/logger.js';
import { createHttpError } from '../utils/http-error.js';
import {
  CancelCustodySessionResponse,
  ClaimedCustodyStatus,
  CreateCustodyAttemptRequest,
  CreateCustodyAttemptResponse,
  CustodyActor,
  CustodyDecision,
  CustodySessionStatusResponse,
  CustodyStatus,
  EscalateStaleAcceptedCustodyAttemptsResponse,
  ExpireCustodySessionsResponse,
  GuardDecisionRequest,
  GuardDecisionResponse,
  GuardPostRecord,
  GuardScanRequest,
  GuardScanResponse,
  OpenCustodyInvestigationResponse,
  NotifyGuardRequest,
  NotifyGuardResponse,
  PhysicalTakeReportRequest,
  PhysicalTakeReportResponse,
  RetryCustodySessionRequest,
  RetryCustodySessionResponse,
  SecurityOfficeReceiptResponse,
  StaffCustodyPostRequest,
  StudentCustodyHistoryEntry,
  StudentCustodyHistoryResponse,
  UntrackedCustodyStatus,
  UpdatePostCustodyStatusRequest,
  UpdatePostCustodyStatusResponse,
  EditablePostCustodyStatus,
} from '../types/custody.js';

function parsePositiveIntEnv(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const DEFAULT_QR_SESSION_TTL_SECONDS = parsePositiveIntEnv(process.env.CUSTODY_QR_TTL_SECONDS, 120);
const DEFAULT_QR_SESSION_MAX_ATTEMPTS = parsePositiveIntEnv(process.env.CUSTODY_QR_MAX_ATTEMPTS, 5);
const DEFAULT_CUSTODY_SESSION_ABSOLUTE_TTL_SECONDS = parsePositiveIntEnv(
  process.env.CUSTODY_SESSION_ABSOLUTE_TTL_SECONDS,
  15 * 60
);
const DEFAULT_CUSTODY_SESSION_LIMIT_PER_HOUR = parsePositiveIntEnv(
  process.env.CUSTODY_SESSION_LIMIT_PER_HOUR,
  2
);
const DEFAULT_STALE_ACCEPTED_ESCALATION_HOURS = parsePositiveIntEnv(
  process.env.CUSTODY_STALE_ACCEPTED_ESCALATION_HOURS,
  48
);
const DEFAULT_AUTOMATION_STAFF_USER_ID = process.env.CUSTODY_AUTOMATION_STAFF_USER_ID ?? null;
const CUSTODY_SESSION_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const MANUAL_ENTRY_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MANUAL_ENTRY_CODE_LENGTH = 6;
const MAX_MANUAL_ENTRY_CODE_GENERATION_ATTEMPTS = 10;
const ATTEMPT_SELECT_COLUMNS =
  'custody_attempt_id, post_id, item_id, poster_id, guard_post_id, handover_image_id, attempt_number, number_of_attempts, status, decision_by_guard_id, decision_at, closed_at, created_at';
const ATTEMPT_REVIEW_SELECT_COLUMNS = `${ATTEMPT_SELECT_COLUMNS}, office_received_by_staff_id, office_received_at, investigation_opened_by, investigation_opened_at`;
const SESSION_SELECT_COLUMNS =
  'qr_code_session_id, custody_attempt_id, session_token_hash, manual_entry_code, status, expires_at, scanned_by_guard_id, scanned_at, closed_at';

type SupabaseClientLike = ReturnType<typeof getSupabaseClient>;

interface GuardPostRow {
  guard_post_id: string;
  guard_post_name: string;
  location_id: number;
  is_active: boolean;
}

interface LocationRow {
  location_id: number;
  full_location_name: string | null;
}

interface PostCustodyAccessRow {
  post_id: number;
  item_id: string;
  item_name?: string | null;
  poster_id: string | null;
  item_type: string | null;
  post_status: string | null;
  item_status?: string | null;
  custody_status: CustodyStatus | null;
  submission_date?: string;
}

interface AttemptRow {
  custody_attempt_id: string;
  post_id: number;
  item_id: string;
  poster_id: string;
  guard_post_id: string;
  handover_image_id: number;
  attempt_number: number;
  number_of_attempts: number;
  status: 'open' | 'accepted' | 'rejected' | 'timed_out' | 'cancelled';
  decision_by_guard_id: string | null;
  decision_at: string | null;
  closed_at: string | null;
  created_at: string;
}

interface AttemptReviewRow extends AttemptRow {
  office_received_by_staff_id: string | null;
  office_received_at: string | null;
  investigation_opened_by: string | null;
  investigation_opened_at: string | null;
}

interface SessionRow {
  qr_code_session_id: string;
  custody_attempt_id: string;
  session_token_hash: string;
  manual_entry_code: string;
  status: 'active' | 'accepted' | 'rejected' | 'expired' | 'cancelled';
  expires_at: string;
  scanned_by_guard_id: string | null;
  scanned_at: string | null;
  closed_at: string | null;
}

interface ItemCustodyRow {
  custody_status: CustodyStatus;
}

interface GuardPostLookupRow {
  guard_post_name: string;
}

interface HandoverImageRow {
  item_image_id?: number;
  image_link: string | null;
}

interface CustodyHistoryRow {
  custody_record_id: string;
  post_id: number;
  item_id: string;
  custody_attempt_id: string | null;
  qr_code_session_id: string | null;
  guard_post_id: string | null;
  actor_user_id: string | null;
  record_type: string;
  details: Record<string, unknown> | null;
  occurred_at: string;
}

interface UserNameRow {
  user_id: string;
  user_name: string | null;
}

interface UserRoleRow {
  user_id: string;
  user_type: string;
  email?: string | null;
}

interface GuardPostDetailsRow {
  post_id: number;
  item_id: string;
  item_name: string;
  item_description: string | null;
  item_image_url: string | null;
  category: string | null;
  last_seen_at: string | null;
  last_seen_location: string | null;
  submission_date: string;
}

type AuditLogger = typeof logAudit;

export interface CustodyServiceDependencies {
  getSupabase?: () => SupabaseClientLike;
  now?: () => Date;
  hashSessionToken?: (sessionToken: string) => string;
  generateManualEntryCode?: () => string;
  qrSessionTtlSeconds?: number;
  absoluteSessionTtlSeconds?: number;
  maxSessionAttempts?: number;
  maxSessionLoopsPerHour?: number;
  staleAcceptedEscalationHours?: number;
  automationStaffUserId?: string | null;
  auditLogger?: AuditLogger;
  notificationCreator?: (payload: NotificationPayload) => Promise<string | number | null>;
}

export interface CreateCustodyAttemptInput extends CreateCustodyAttemptRequest {
  actor: CustodyActor;
}

export type GuardScanInput = GuardScanRequest & {
  actor: CustodyActor;
};

export interface GuardDecisionInput extends GuardDecisionRequest {
  actor: CustodyActor;
  custody_attempt_id: string;
}

export interface GetCustodySessionStatusInput {
  actor: CustodyActor;
  qr_code_session_id: string;
}

export interface RetryCustodySessionInput extends RetryCustodySessionRequest {
  actor: CustodyActor;
  qr_code_session_id: string;
}

export interface CancelCustodySessionInput {
  actor: CustodyActor;
  qr_code_session_id: string;
}

export interface GetStudentCustodyHistoryInput {
  actor: CustodyActor;
  post_id: number;
}

export interface SecurityOfficeReceiptInput extends StaffCustodyPostRequest {
  actor: CustodyActor;
}

export interface OpenCustodyInvestigationInput extends StaffCustodyPostRequest {
  actor: CustodyActor;
}

export interface ReportPhysicalTakeInput extends PhysicalTakeReportRequest {
  actor: CustodyActor;
}

export interface NotifyGuardInput extends NotifyGuardRequest {
  actor: CustodyActor;
}

export interface UpdatePostCustodyStatusInput extends UpdatePostCustodyStatusRequest {
  actor: CustodyActor;
  details?: Record<string, unknown>;
  occurred_at?: string;
}

function defaultHashSessionToken(sessionToken: string): string {
  return crypto.createHash('sha256').update(sessionToken).digest('hex');
}

function defaultGenerateManualEntryCode(): string {
  const randomBytes = crypto.randomBytes(MANUAL_ENTRY_CODE_LENGTH);

  return Array.from(
    randomBytes,
    (value) => MANUAL_ENTRY_CODE_ALPHABET[value % MANUAL_ENTRY_CODE_ALPHABET.length]
  ).join('');
}

function normalizeManualEntryCode(manualEntryCode: string): string {
  return manualEntryCode
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

function isNoRowsError(error: { code?: string } | null | undefined): boolean {
  return error?.code === 'PGRST116';
}

function isUniqueConstraintError(error: { code?: string } | null | undefined): boolean {
  return error?.code === '23505';
}

function resolveDependencies(deps?: CustodyServiceDependencies) {
  return {
    getSupabase: deps?.getSupabase ?? getSupabaseClient,
    now: deps?.now ?? (() => new Date()),
    hashSessionToken: deps?.hashSessionToken ?? defaultHashSessionToken,
    generateManualEntryCode: deps?.generateManualEntryCode ?? defaultGenerateManualEntryCode,
    qrSessionTtlSeconds: deps?.qrSessionTtlSeconds ?? DEFAULT_QR_SESSION_TTL_SECONDS,
    absoluteSessionTtlSeconds:
      deps?.absoluteSessionTtlSeconds ?? DEFAULT_CUSTODY_SESSION_ABSOLUTE_TTL_SECONDS,
    maxSessionAttempts: deps?.maxSessionAttempts ?? DEFAULT_QR_SESSION_MAX_ATTEMPTS,
    maxSessionLoopsPerHour: deps?.maxSessionLoopsPerHour ?? DEFAULT_CUSTODY_SESSION_LIMIT_PER_HOUR,
    staleAcceptedEscalationHours:
      deps?.staleAcceptedEscalationHours ?? DEFAULT_STALE_ACCEPTED_ESCALATION_HOURS,
    automationStaffUserId: deps?.automationStaffUserId ?? DEFAULT_AUTOMATION_STAFF_USER_ID,
    auditLogger: deps?.auditLogger ?? logAudit,
    notificationCreator: deps?.notificationCreator ?? createNotification,
  };
}

function isClaimedCustodyStatus(
  status: CustodyStatus | null | undefined
): status is ClaimedCustodyStatus {
  return (
    status === 'in_security_office' ||
    status === 'under_investigation' ||
    status === 'claimed_by_student'
  );
}

function isUntrackedEditableCustodyStatus(
  status: CustodyStatus | null | undefined
): status is UntrackedCustodyStatus {
  return status === 'with_reporter' || status === 'with_guard' || status === 'in_security_office';
}

function getPostCustodyRecordType(status: EditablePostCustodyStatus): string {
  switch (status) {
    case 'with_reporter':
      return 'staff_marked_with_reporter';
    case 'with_guard':
      return 'staff_marked_with_guard';
    case 'in_security_office':
      return 'security_office_received';
    case 'under_investigation':
      return 'investigation_opened';
    case 'claimed_by_student':
      return 'claimed_by_student';
  }
}

function getPostCustodyAuditAction(status: EditablePostCustodyStatus): string {
  switch (status) {
    case 'with_reporter':
      return 'custody_marked_with_reporter';
    case 'with_guard':
      return 'custody_marked_with_guard';
    case 'in_security_office':
      return 'custody_marked_in_security_office';
    case 'under_investigation':
      return 'custody_marked_under_investigation';
    case 'claimed_by_student':
      return 'custody_marked_claimed_by_student';
  }
}

function shouldWriteAdminAudit(actor: Pick<CustodyActor, 'user_type'>): boolean {
  return actor.user_type !== 'User';
}

function formatAuditPostTitle(itemName: string | null | undefined, postId: number): string {
  const normalizedItemName = itemName?.trim();
  return normalizedItemName && normalizedItemName.length > 0
    ? normalizedItemName
    : `Post ${postId}`;
}

function getAuditActorRoleLabel(userType: CustodyActor['user_type']): string {
  switch (userType) {
    case 'Admin':
      return 'Admin';
    case 'Guard':
      return 'Guard';
    case 'Staff':
      return 'Staff';
    default:
      return 'User';
  }
}

function getPostCustodyStatusMessage(
  actorLabel: string,
  postTitle: string,
  custodyStatus: EditablePostCustodyStatus
): string {
  switch (custodyStatus) {
    case 'with_reporter':
      return `${actorLabel} marked ${postTitle} as with the reporter`;
    case 'with_guard':
      return `${actorLabel} marked ${postTitle} as with the guard`;
    case 'in_security_office':
      return `${actorLabel} marked ${postTitle} as received in the Security Office`;
    case 'under_investigation':
      return `${actorLabel} marked ${postTitle} under investigation`;
    case 'claimed_by_student':
      return `${actorLabel} marked ${postTitle} as claimed by student`;
  }
}

async function getAuditActorName(
  supabase: SupabaseClientLike,
  actor: Pick<CustodyActor, 'user_id' | 'user_type'>
): Promise<string> {
  const fallbackName = getAuditActorRoleLabel(actor.user_type);

  try {
    const { data, error } = await supabase
      .from('user_table')
      .select('user_id, user_name')
      .eq('user_id', actor.user_id)
      .single();

    if (error || !data) {
      logger.warn(
        { actorUserId: actor.user_id, error },
        'Failed to resolve audit actor name for custody log'
      );
      return fallbackName;
    }

    const userName = (data as UserNameRow).user_name?.trim();
    return userName && userName.length > 0 ? userName : fallbackName;
  } catch (error) {
    logger.warn(
      { actorUserId: actor.user_id, error },
      'Exception resolving audit actor name for custody log'
    );
    return fallbackName;
  }
}

async function getAuditPostTitle(
  supabase: SupabaseClientLike,
  postId: number,
  fallbackItemName?: string | null
): Promise<string> {
  if (fallbackItemName !== undefined) {
    return formatAuditPostTitle(fallbackItemName, postId);
  }

  try {
    const { data, error } = await supabase
      .from('post_public_view')
      .select('item_name')
      .eq('post_id', postId)
      .single();

    if (error || !data) {
      logger.warn({ postId, error }, 'Failed to resolve custody audit post title');
      return formatAuditPostTitle(null, postId);
    }

    return formatAuditPostTitle((data as { item_name?: string | null }).item_name ?? null, postId);
  } catch (error) {
    logger.warn({ postId, error }, 'Exception resolving custody audit post title');
    return formatAuditPostTitle(null, postId);
  }
}

async function getAuditActorLabel(
  supabase: SupabaseClientLike,
  actor: Pick<CustodyActor, 'user_id' | 'user_type'>
): Promise<string> {
  const actorName = await getAuditActorName(supabase, actor);
  return `${getAuditActorRoleLabel(actor.user_type)} ${actorName}`;
}

async function getPostCustodyAccessRow(
  supabase: SupabaseClientLike,
  postId: number,
  columns = 'post_id, item_id, poster_id, item_type, post_status, custody_status'
): Promise<PostCustodyAccessRow> {
  const { data, error } = await supabase
    .from('post_public_view')
    .select(columns)
    .eq('post_id', postId)
    .single();

  if (error || !data) {
    logger.warn({ postId, error }, 'Post not found for custody operation');
    throw createHttpError('Post not found', 404);
  }

  return data as unknown as PostCustodyAccessRow;
}

async function getLatestAttemptForPost(
  supabase: SupabaseClientLike,
  postId: number
): Promise<AttemptReviewRow> {
  const { data, error } = await supabase
    .from('custody_attempt_table')
    .select(ATTEMPT_REVIEW_SELECT_COLUMNS)
    .eq('post_id', postId)
    .order('attempt_number', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error && !isNoRowsError(error)) {
    logger.error({ postId, error }, 'Failed to fetch latest custody attempt');
    throw createHttpError('Failed to fetch custody attempt', 500);
  }

  if (!data) {
    throw createHttpError('No custody attempt found for this post', 409);
  }

  return data as AttemptReviewRow;
}

async function getLatestAcceptedAttemptForPost(
  supabase: SupabaseClientLike,
  postId: number
): Promise<AttemptReviewRow> {
  const { data, error } = await supabase
    .from('custody_attempt_table')
    .select(ATTEMPT_REVIEW_SELECT_COLUMNS)
    .eq('post_id', postId)
    .eq('status', 'accepted')
    .order('attempt_number', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error && !isNoRowsError(error)) {
    logger.error({ postId, error }, 'Failed to fetch accepted custody attempt');
    throw createHttpError('Failed to fetch custody attempt', 500);
  }

  if (!data) {
    throw createHttpError('No accepted custody attempt found for this post', 409);
  }

  return data as AttemptReviewRow;
}

async function assertGuardUserExists(supabase: SupabaseClientLike, guardId: string): Promise<void> {
  const { data, error } = await supabase
    .from('user_table')
    .select('user_id, user_type')
    .eq('user_id', guardId)
    .single();

  if (error || !data) {
    logger.warn({ guardId, error }, 'Guard user not found for custody operation');
    throw createHttpError('Guard user not found', 404);
  }

  if ((data as UserRoleRow).user_type !== 'Guard') {
    throw createHttpError('Provided guard_id does not belong to a Guard user', 409);
  }
}

async function getAutomationStaffActor(
  supabase: SupabaseClientLike,
  automationStaffUserId: string | null
): Promise<CustodyActor> {
  if (!automationStaffUserId || automationStaffUserId.trim().length === 0) {
    logger.error('Missing CUSTODY_AUTOMATION_STAFF_USER_ID for automated custody escalation');
    throw createHttpError('Custody automation staff user is not configured', 500);
  }

  const { data, error } = await supabase
    .from('user_table')
    .select('user_id, user_type, email')
    .eq('user_id', automationStaffUserId)
    .single();

  if (error || !data) {
    logger.error(
      { automationStaffUserId, error },
      'Automation staff user not found for automated custody escalation'
    );
    throw createHttpError('Custody automation staff user is invalid', 500);
  }

  if ((data as UserRoleRow).user_type !== 'Staff') {
    logger.error(
      { automationStaffUserId, userType: (data as UserRoleRow).user_type },
      'Automation staff user must belong to a Staff account'
    );
    throw createHttpError('Custody automation staff user is invalid', 500);
  }

  return {
    user_id: (data as UserRoleRow).user_id,
    email: (data as UserRoleRow).email ?? null,
    user_type: 'Staff',
  };
}

async function getStaleAcceptedAttemptsForEscalation(
  supabase: SupabaseClientLike,
  thresholdIso: string
): Promise<AttemptReviewRow[]> {
  const { data, error } = await supabase
    .from('custody_attempt_table')
    .select(ATTEMPT_REVIEW_SELECT_COLUMNS)
    .eq('status', 'accepted')
    .is('office_received_at', null)
    .is('investigation_opened_at', null)
    .lte('decision_at', thresholdIso)
    .order('decision_at', { ascending: true });

  if (error) {
    logger.error({ error, thresholdIso }, 'Failed to fetch stale accepted custody attempts');
    throw createHttpError('Failed to fetch stale accepted custody attempts', 500);
  }

  return (data ?? []) as AttemptReviewRow[];
}

async function getAttemptById(
  supabase: SupabaseClientLike,
  custodyAttemptId: string
): Promise<AttemptRow> {
  const { data, error } = await supabase
    .from('custody_attempt_table')
    .select(ATTEMPT_SELECT_COLUMNS)
    .eq('custody_attempt_id', custodyAttemptId)
    .single();

  if (error || !data) {
    logger.warn({ custodyAttemptId, error }, 'Custody attempt not found');
    throw createHttpError('Custody attempt not found', 404);
  }

  return data as AttemptRow;
}

async function getSessionById(
  supabase: SupabaseClientLike,
  qrCodeSessionId: string
): Promise<SessionRow> {
  const { data, error } = await supabase
    .from('qr_code_session_table')
    .select(SESSION_SELECT_COLUMNS)
    .eq('qr_code_session_id', qrCodeSessionId)
    .single();

  if (error || !data) {
    logger.warn({ qrCodeSessionId, error }, 'QR code session not found');
    throw createHttpError('QR code session not found', 404);
  }

  return data as SessionRow;
}

async function getSessionByManualEntryCode(
  supabase: SupabaseClientLike,
  manualEntryCode: string
): Promise<SessionRow> {
  const normalizedManualEntryCode = normalizeManualEntryCode(manualEntryCode);

  const { data, error } = await supabase
    .from('qr_code_session_table')
    .select(SESSION_SELECT_COLUMNS)
    .eq('manual_entry_code', normalizedManualEntryCode)
    .single();

  if (error || !data) {
    logger.warn(
      { manualEntryCode: normalizedManualEntryCode, error },
      'QR code session not found for manual entry code'
    );
    throw createHttpError('Manual entry code not found', 404);
  }

  return data as SessionRow;
}

async function getItemCustodyStatus(
  supabase: SupabaseClientLike,
  itemId: string
): Promise<CustodyStatus> {
  const { data, error } = await supabase
    .from('item_table')
    .select('custody_status')
    .eq('item_id', itemId)
    .single();

  if (error || !data) {
    logger.error({ itemId, error }, 'Failed to fetch current item custody status');
    throw createHttpError('Failed to fetch custody status', 500);
  }

  return (data as ItemCustodyRow).custody_status;
}

async function persistItemCustodyStatus(
  supabase: SupabaseClientLike,
  itemIds: string[],
  custodyStatus: CustodyStatus,
  context: { postId?: number; custodyAttemptIds?: string[]; action: string }
): Promise<void> {
  const normalizedItemIds = Array.from(new Set(itemIds.filter((itemId) => itemId.trim().length > 0)));

  if (normalizedItemIds.length === 0) {
    return;
  }

  const { error } = await supabase
    .from('item_table')
    .update({ custody_status: custodyStatus })
    .in('item_id', normalizedItemIds);

  if (error) {
    logger.error(
      {
        error,
        itemIds: normalizedItemIds,
        postId: context.postId,
        custodyAttemptIds: context.custodyAttemptIds,
        custodyStatus,
        action: context.action,
      },
      'Failed to persist item custody status'
    );
    throw createHttpError('Failed to update item custody status', 500);
  }
}

function getRetriesRemaining(numberOfAttempts: number, maxSessionAttempts: number): number {
  return Math.max(maxSessionAttempts - numberOfAttempts, 0);
}

function isSessionWindowExpired(session: SessionRow, currentTime: Date): boolean {
  return new Date(session.expires_at).getTime() <= currentTime.getTime();
}

function getAbsoluteSessionDeadline(
  attempt: Pick<AttemptRow, 'created_at'>,
  absoluteSessionTtlSeconds: number
): Date {
  return new Date(new Date(attempt.created_at).getTime() + absoluteSessionTtlSeconds * 1000);
}

function isAbsoluteSessionExpired(
  attempt: Pick<AttemptRow, 'created_at'>,
  currentTime: Date,
  absoluteSessionTtlSeconds: number
): boolean {
  return (
    getAbsoluteSessionDeadline(attempt, absoluteSessionTtlSeconds).getTime() <=
    currentTime.getTime()
  );
}

function buildSessionExpirationTimestamp(
  currentTime: Date,
  qrSessionTtlSeconds: number,
  attempt: Pick<AttemptRow, 'created_at'>,
  absoluteSessionTtlSeconds: number
): string {
  const qrWindowDeadline = currentTime.getTime() + qrSessionTtlSeconds * 1000;
  const absoluteDeadline = getAbsoluteSessionDeadline(attempt, absoluteSessionTtlSeconds).getTime();

  return new Date(Math.min(qrWindowDeadline, absoluteDeadline)).toISOString();
}

function buildSessionRetryMetadata(
  attempt: Pick<AttemptRow, 'number_of_attempts'>,
  maxSessionAttempts: number
): {
  number_of_attempts: number;
  max_number_of_attempts: number;
  retries_remaining: number;
} {
  return {
    number_of_attempts: attempt.number_of_attempts,
    max_number_of_attempts: maxSessionAttempts,
    retries_remaining: getRetriesRemaining(attempt.number_of_attempts, maxSessionAttempts),
  };
}

function buildCreateOrRetryResponse(
  session: SessionRow,
  attempt: AttemptRow,
  custodyStatus: CustodyStatus,
  maxSessionAttempts: number
): CreateCustodyAttemptResponse | RetryCustodySessionResponse {
  return {
    custody_attempt_id: attempt.custody_attempt_id,
    qr_code_session_id: session.qr_code_session_id,
    manual_entry_code: session.manual_entry_code,
    attempt_status: attempt.status,
    qr_status: session.status,
    custody_status: custodyStatus,
    expires_at: session.expires_at,
    ...buildSessionRetryMetadata(attempt, maxSessionAttempts),
  };
}

function buildCancelResponse(
  session: SessionRow,
  attempt: AttemptRow,
  custodyStatus: CustodyStatus,
  cancelledAt: string
): CancelCustodySessionResponse {
  return {
    qr_code_session_id: session.qr_code_session_id,
    custody_attempt_id: attempt.custody_attempt_id,
    attempt_status: attempt.status,
    qr_status: session.status,
    custody_status: custodyStatus,
    cancelled_at: cancelledAt,
  };
}

function buildSessionStatusResponse(
  session: SessionRow,
  attempt: AttemptRow,
  custodyStatus: CustodyStatus,
  currentTime: Date,
  maxSessionAttempts: number
): CustodySessionStatusResponse {
  const currentWindowExpired = isSessionWindowExpired(session, currentTime);

  return {
    qr_code_session_id: session.qr_code_session_id,
    custody_attempt_id: attempt.custody_attempt_id,
    post_id: attempt.post_id,
    item_id: attempt.item_id,
    manual_entry_code: session.manual_entry_code,
    qr_status: session.status,
    attempt_status: attempt.status,
    custody_status: custodyStatus,
    expires_at: session.expires_at,
    scanned_at: session.scanned_at,
    decision_at: attempt.decision_at,
    current_window_expired: currentWindowExpired,
    can_retry:
      session.status === 'active' &&
      attempt.status === 'open' &&
      currentWindowExpired &&
      attempt.number_of_attempts < maxSessionAttempts,
    ...buildSessionRetryMetadata(attempt, maxSessionAttempts),
  };
}

async function createSessionWithManualEntryCode(
  supabase: SupabaseClientLike,
  custodyAttemptId: string,
  sessionTokenHash: string,
  expiresAt: string,
  generateManualEntryCode: () => string
): Promise<SessionRow> {
  for (
    let attemptIndex = 0;
    attemptIndex < MAX_MANUAL_ENTRY_CODE_GENERATION_ATTEMPTS;
    attemptIndex += 1
  ) {
    const manualEntryCode = normalizeManualEntryCode(generateManualEntryCode());
    if (manualEntryCode.length !== MANUAL_ENTRY_CODE_LENGTH) {
      continue;
    }

    const { data, error } = await supabase
      .from('qr_code_session_table')
      .insert({
        custody_attempt_id: custodyAttemptId,
        session_token_hash: sessionTokenHash,
        manual_entry_code: manualEntryCode,
        status: 'active',
        expires_at: expiresAt,
      })
      .select(SESSION_SELECT_COLUMNS)
      .single();

    if (!error && data) {
      return data as SessionRow;
    }

    if (isUniqueConstraintError(error)) {
      continue;
    }

    logger.error({ error, custodyAttemptId }, 'Failed to create QR code session');
    throw createHttpError('Failed to create QR code session', 500);
  }

  logger.error(
    { custodyAttemptId },
    'Failed to generate a unique manual entry code for QR session creation'
  );
  throw createHttpError('Failed to create QR code session', 500);
}

async function rotateSessionManualEntryCode(
  supabase: SupabaseClientLike,
  session: SessionRow,
  sessionTokenHash: string,
  expiresAt: string,
  generateManualEntryCode: () => string
): Promise<string> {
  for (
    let attemptIndex = 0;
    attemptIndex < MAX_MANUAL_ENTRY_CODE_GENERATION_ATTEMPTS;
    attemptIndex += 1
  ) {
    const manualEntryCode = normalizeManualEntryCode(generateManualEntryCode());
    if (manualEntryCode.length !== MANUAL_ENTRY_CODE_LENGTH) {
      continue;
    }

    const { error } = await supabase
      .from('qr_code_session_table')
      .update({
        session_token_hash: sessionTokenHash,
        manual_entry_code: manualEntryCode,
        status: 'active',
        expires_at: expiresAt,
        scanned_by_guard_id: null,
        scanned_at: null,
        closed_at: null,
      })
      .eq('qr_code_session_id', session.qr_code_session_id);

    if (!error) {
      return manualEntryCode;
    }

    if (isUniqueConstraintError(error)) {
      continue;
    }

    logger.error(
      { error, qrCodeSessionId: session.qr_code_session_id },
      'Failed to rotate custody QR session'
    );
    throw createHttpError('Failed to retry custody handover session', 500);
  }

  logger.error(
    { qrCodeSessionId: session.qr_code_session_id },
    'Failed to generate a unique manual entry code for custody QR session retry'
  );
  throw createHttpError('Failed to retry custody handover session', 500);
}

async function insertCustodyRecords(
  supabase: SupabaseClientLike,
  records: Array<Record<string, unknown>>
): Promise<void> {
  if (records.length === 0) return;

  const { error } = await supabase.from('custody_record_table').insert(records);
  if (error) {
    logger.error({ error, recordCount: records.length }, 'Failed to insert custody records');
    throw createHttpError('Failed to save custody history', 500);
  }
}

function assertCanReadReporterSession(actor: CustodyActor, posterId: string): void {
  if (actor.user_type === 'Guard') {
    throw createHttpError('Forbidden', 403);
  }

  if (actor.user_type === 'User' && actor.user_id !== posterId) {
    throw createHttpError('Forbidden', 403);
  }
}

function assertActorOwnsReporterSession(actor: CustodyActor, posterId: string): void {
  if (actor.user_id !== posterId) {
    throw createHttpError('Forbidden', 403);
  }
}

function hasHttpStatusCode(error: unknown, statusCodes: number[]): boolean {
  return (
    error instanceof Error &&
    'statusCode' in error &&
    typeof (error as { statusCode?: unknown }).statusCode === 'number' &&
    statusCodes.includes((error as { statusCode: number }).statusCode)
  );
}

async function assertCanReadPostCustodyHistory(
  supabase: SupabaseClientLike,
  actor: CustodyActor,
  post: PostCustodyAccessRow
): Promise<void> {
  if (!post.poster_id) {
    throw createHttpError('Post not found', 404);
  }

  if (actor.user_type !== 'Guard') {
    assertCanReadReporterSession(actor, post.poster_id);
    return;
  }

  if (
    post.item_type !== 'found' ||
    post.item_status !== 'unclaimed' ||
    post.custody_status !== 'with_guard'
  ) {
    throw createHttpError('Forbidden', 403);
  }

  try {
    const acceptedAttempt = await getLatestAcceptedAttemptForPost(supabase, post.post_id);

    if (
      acceptedAttempt.decision_by_guard_id !== actor.user_id ||
      acceptedAttempt.office_received_at
    ) {
      throw createHttpError('Forbidden', 403);
    }
  } catch (error) {
    if (hasHttpStatusCode(error, [403, 404, 409])) {
      throw createHttpError('Forbidden', 403);
    }

    throw error;
  }
}

async function finalizeTimedOutSession(
  supabase: SupabaseClientLike,
  session: SessionRow,
  attempt: AttemptRow,
  currentTime: Date,
  auditLogger: AuditLogger,
  auditUserId?: string
): Promise<{ session: SessionRow; attempt: AttemptRow }> {
  const timestamp = currentTime.toISOString();
  const postTitle = await getAuditPostTitle(supabase, attempt.post_id);

  const { error: sessionError } = await supabase
    .from('qr_code_session_table')
    .update({
      status: 'expired',
      closed_at: timestamp,
    })
    .eq('qr_code_session_id', session.qr_code_session_id);

  if (sessionError) {
    logger.error(
      { error: sessionError, qrCodeSessionId: session.qr_code_session_id },
      'Failed to expire QR session'
    );
    throw createHttpError('Failed to expire QR session', 500);
  }

  const { error: attemptError } = await supabase
    .from('custody_attempt_table')
    .update({
      status: 'timed_out',
      closed_at: timestamp,
    })
    .eq('custody_attempt_id', attempt.custody_attempt_id);

  if (attemptError) {
    logger.error(
      { error: attemptError, custodyAttemptId: attempt.custody_attempt_id },
      'Failed to timeout custody attempt'
    );
    throw createHttpError('Failed to timeout custody attempt', 500);
  }

  await insertCustodyRecords(supabase, [
    {
      post_id: attempt.post_id,
      item_id: attempt.item_id,
      custody_attempt_id: attempt.custody_attempt_id,
      qr_code_session_id: session.qr_code_session_id,
      guard_post_id: attempt.guard_post_id,
      actor_user_id: auditUserId ?? null,
      record_type: 'qr_expired',
      visible_to_poster: true,
      details: {
        qr_status: 'expired',
        attempt_status: 'timed_out',
        number_of_attempts: attempt.number_of_attempts,
      },
      occurred_at: timestamp,
    },
  ]);

  if (auditUserId) {
    await auditLogger({
      userId: auditUserId,
      actionType: 'custody_session_expired',
      tableName: 'qr_code_session_table',
      recordId: session.qr_code_session_id,
      details: {
        message: `Custody handover session expired for ${postTitle}`,
        post_title: postTitle,
        qr_code_session_id: session.qr_code_session_id,
        custody_attempt_id: attempt.custody_attempt_id,
        post_id: attempt.post_id,
        item_id: attempt.item_id,
        number_of_attempts: attempt.number_of_attempts,
      },
    });
  }

  return {
    session: {
      ...session,
      status: 'expired',
      closed_at: timestamp,
    },
    attempt: {
      ...attempt,
      status: 'timed_out',
      closed_at: timestamp,
    },
  };
}

async function resolveSessionExpiration(
  supabase: SupabaseClientLike,
  session: SessionRow,
  attempt: AttemptRow,
  currentTime: Date,
  absoluteSessionTtlSeconds: number,
  maxSessionAttempts: number,
  auditLogger: AuditLogger,
  auditUserId?: string
): Promise<{
  session: SessionRow;
  attempt: AttemptRow;
  currentWindowExpired: boolean;
  finalizedTimeout: boolean;
}> {
  const currentWindowExpired =
    session.status === 'active' &&
    attempt.status === 'open' &&
    isSessionWindowExpired(session, currentTime);
  const absoluteSessionExpired =
    session.status === 'active' &&
    attempt.status === 'open' &&
    isAbsoluteSessionExpired(attempt, currentTime, absoluteSessionTtlSeconds);

  if (!currentWindowExpired && !absoluteSessionExpired) {
    return {
      session,
      attempt,
      currentWindowExpired: false,
      finalizedTimeout: false,
    };
  }

  if (!absoluteSessionExpired && attempt.number_of_attempts < maxSessionAttempts) {
    return {
      session,
      attempt,
      currentWindowExpired: true,
      finalizedTimeout: false,
    };
  }

  const finalized = await finalizeTimedOutSession(
    supabase,
    session,
    attempt,
    currentTime,
    auditLogger,
    auditUserId
  );

  return {
    ...finalized,
    currentWindowExpired: true,
    finalizedTimeout: true,
  };
}

export async function listGuardPosts(
  deps?: CustodyServiceDependencies
): Promise<{ guard_posts: GuardPostRecord[] }> {
  const { getSupabase } = resolveDependencies(deps);
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('guard_post_table')
    .select('guard_post_id, guard_post_name, location_id, is_active')
    .eq('is_active', true)
    .order('guard_post_name', { ascending: true });

  if (error) {
    logger.error({ error }, 'Failed to fetch guard posts');
    throw createHttpError('Failed to fetch guard posts', 500);
  }

  const guardPosts = (data ?? []) as GuardPostRow[];
  const locationIds = guardPosts.map((guardPost) => guardPost.location_id);

  let locationMap = new Map<number, string | null>();
  if (locationIds.length > 0) {
    const { data: locations, error: locationError } = await supabase
      .from('location_lookup')
      .select('location_id, full_location_name')
      .in('location_id', locationIds);

    if (locationError) {
      logger.error({ error: locationError }, 'Failed to fetch guard post locations');
      throw createHttpError('Failed to fetch guard posts', 500);
    }

    locationMap = new Map(
      ((locations ?? []) as LocationRow[]).map((location) => [
        location.location_id,
        location.full_location_name,
      ])
    );
  }

  return {
    guard_posts: guardPosts.map((guardPost) => ({
      ...guardPost,
      full_location_name: locationMap.get(guardPost.location_id) ?? null,
    })),
  };
}

export async function createCustodyAttempt(
  input: CreateCustodyAttemptInput,
  deps?: CustodyServiceDependencies
): Promise<CreateCustodyAttemptResponse> {
  const {
    getSupabase,
    now,
    hashSessionToken,
    generateManualEntryCode,
    qrSessionTtlSeconds,
    absoluteSessionTtlSeconds,
    maxSessionAttempts,
    maxSessionLoopsPerHour,
  } = resolveDependencies(deps);
  const supabase = getSupabase();
  const currentTime = now();
  const timestamp = currentTime.toISOString();

  const { data: post, error: postError } = await supabase
    .from('post_public_view')
    .select('post_id, item_id, poster_id, item_type, post_status, custody_status')
    .eq('post_id', input.post_id)
    .single();

  if (postError || !post) {
    logger.warn({ postId: input.post_id, error: postError }, 'Post not found for custody attempt');
    throw createHttpError('Post not found', 404);
  }

  const postRow = post as PostCustodyAccessRow;
  if (postRow.poster_id !== input.actor.user_id) {
    throw createHttpError('Forbidden', 403);
  }

  if (postRow.item_type !== 'found') {
    throw createHttpError('Custody flow only applies to found items', 400);
  }

  if (
    postRow.post_status === 'deleted' ||
    postRow.post_status === 'rejected' ||
    postRow.post_status === 'fraud'
  ) {
    throw createHttpError('Post cannot start custody handover', 409);
  }

  if (
    postRow.custody_status === 'with_guard' ||
    postRow.custody_status === 'in_security_office' ||
    postRow.custody_status === 'claimed_by_student' ||
    postRow.custody_status === 'under_investigation' ||
    postRow.custody_status === 'discarded'
  ) {
    throw createHttpError(
      'Post cannot start a new custody handover from its current custody state',
      409
    );
  }

  const { data: existingOpenAttempt, error: existingOpenAttemptError } = await supabase
    .from('custody_attempt_table')
    .select('custody_attempt_id')
    .eq('post_id', input.post_id)
    .eq('status', 'open')
    .maybeSingle();

  if (existingOpenAttemptError && !isNoRowsError(existingOpenAttemptError)) {
    logger.error(
      { postId: input.post_id, error: existingOpenAttemptError },
      'Failed to check existing custody attempt'
    );
    throw createHttpError('Failed to create custody attempt', 500);
  }

  if (existingOpenAttempt) {
    throw createHttpError('An open custody attempt already exists for this post', 409);
  }

  const sessionLimitWindowStart = new Date(
    currentTime.getTime() - CUSTODY_SESSION_LIMIT_WINDOW_MS
  ).toISOString();
  const { count: recentSessionLoopCount, error: recentSessionLoopCountError } = await supabase
    .from('custody_attempt_table')
    .select('custody_attempt_id', { count: 'exact', head: true })
    .eq('post_id', input.post_id)
    .eq('poster_id', input.actor.user_id)
    .gte('created_at', sessionLimitWindowStart);

  if (recentSessionLoopCountError) {
    logger.error(
      { postId: input.post_id, userId: input.actor.user_id, error: recentSessionLoopCountError },
      'Failed to enforce custody session loop rate limit'
    );
    throw createHttpError('Failed to create custody attempt', 500);
  }

  if ((recentSessionLoopCount ?? 0) >= maxSessionLoopsPerHour) {
    throw createHttpError(
      'Too many custody handover sessions started for this post. Try again later.',
      429
    );
  }

  const { data: guardPost, error: guardPostError } = await supabase
    .from('guard_post_table')
    .select('guard_post_id')
    .eq('guard_post_id', input.guard_post_id)
    .eq('is_active', true)
    .single();

  if (guardPostError || !guardPost) {
    logger.warn(
      { guardPostId: input.guard_post_id, error: guardPostError },
      'Guard post not found for custody attempt'
    );
    throw createHttpError('Guard post not found', 404);
  }

  const { data: imageRow, error: imageError } = await supabase
    .from('item_image_table')
    .upsert(
      {
        image_hash: input.handover_image_hash,
        image_link: input.handover_image_url,
      },
      {
        onConflict: 'image_hash',
      }
    )
    .select('item_image_id')
    .single();

  if (imageError || !imageRow) {
    logger.error({ error: imageError, postId: input.post_id }, 'Failed to persist handover image');
    throw createHttpError('Failed to save handover image', 500);
  }

  const { data: lastAttempts, error: lastAttemptError } = await supabase
    .from('custody_attempt_table')
    .select('attempt_number')
    .eq('post_id', input.post_id)
    .order('attempt_number', { ascending: false })
    .limit(1);

  if (lastAttemptError) {
    logger.error(
      { error: lastAttemptError, postId: input.post_id },
      'Failed to resolve custody attempt number'
    );
    throw createHttpError('Failed to create custody attempt', 500);
  }

  const nextAttemptNumber =
    ((lastAttempts?.[0] as { attempt_number?: number } | undefined)?.attempt_number ?? 0) + 1;

  const { data: createdAttempt, error: attemptError } = await supabase
    .from('custody_attempt_table')
    .insert({
      post_id: input.post_id,
      item_id: postRow.item_id,
      poster_id: input.actor.user_id,
      guard_post_id: input.guard_post_id,
      handover_image_id: (imageRow as { item_image_id: number }).item_image_id,
      attempt_number: nextAttemptNumber,
      number_of_attempts: 1,
      status: 'open',
      details: {
        initiated_via: 'backend_route',
      },
    })
    .select(ATTEMPT_SELECT_COLUMNS)
    .single();

  if (attemptError || !createdAttempt) {
    logger.error(
      { error: attemptError, postId: input.post_id },
      'Failed to create custody attempt'
    );
    throw createHttpError('Failed to create custody attempt', 500);
  }

  const expiresAt = buildSessionExpirationTimestamp(
    currentTime,
    qrSessionTtlSeconds,
    createdAttempt as AttemptRow,
    absoluteSessionTtlSeconds
  );
  const tokenHash = hashSessionToken(input.session_token);
  let createdSession: SessionRow;

  try {
    createdSession = await createSessionWithManualEntryCode(
      supabase,
      (createdAttempt as AttemptRow).custody_attempt_id,
      tokenHash,
      expiresAt,
      generateManualEntryCode
    );
  } catch (error) {
    logger.error({ error, postId: input.post_id }, 'Failed to create QR code session');

    const { error: rollbackError } = await supabase
      .from('custody_attempt_table')
      .delete()
      .eq('custody_attempt_id', (createdAttempt as AttemptRow).custody_attempt_id);

    if (rollbackError) {
      logger.error(
        {
          error: rollbackError,
          custodyAttemptId: (createdAttempt as AttemptRow).custody_attempt_id,
        },
        'Failed to rollback custody attempt after QR session creation failure'
      );
    }

    throw error;
  }

  await insertCustodyRecords(supabase, [
    {
      post_id: input.post_id,
      item_id: postRow.item_id,
      custody_attempt_id: (createdAttempt as AttemptRow).custody_attempt_id,
      qr_code_session_id: null,
      guard_post_id: input.guard_post_id,
      actor_user_id: input.actor.user_id,
      record_type: 'attempt_started',
      visible_to_poster: true,
      details: {
        attempt_number: nextAttemptNumber,
        guard_post_id: input.guard_post_id,
      },
      occurred_at: timestamp,
    },
    {
      post_id: input.post_id,
      item_id: postRow.item_id,
      custody_attempt_id: (createdAttempt as AttemptRow).custody_attempt_id,
      qr_code_session_id: createdSession.qr_code_session_id,
      guard_post_id: input.guard_post_id,
      actor_user_id: input.actor.user_id,
      record_type: 'qr_generated',
      visible_to_poster: true,
      details: {
        expires_at: expiresAt,
        manual_entry_code: createdSession.manual_entry_code,
      },
      occurred_at: timestamp,
    },
  ]);

  const custodyStatus = await getItemCustodyStatus(supabase, postRow.item_id);

  return buildCreateOrRetryResponse(
    createdSession,
    createdAttempt as AttemptRow,
    custodyStatus,
    maxSessionAttempts
  ) as CreateCustodyAttemptResponse;
}

export async function getCustodySessionStatus(
  input: GetCustodySessionStatusInput,
  deps?: CustodyServiceDependencies
): Promise<CustodySessionStatusResponse> {
  const { getSupabase, now, absoluteSessionTtlSeconds, maxSessionAttempts, auditLogger } =
    resolveDependencies(deps);
  const supabase = getSupabase();
  const currentTime = now();

  let session = await getSessionById(supabase, input.qr_code_session_id);
  let attempt = await getAttemptById(supabase, session.custody_attempt_id);

  assertCanReadReporterSession(input.actor, attempt.poster_id);

  const expirationResult = await resolveSessionExpiration(
    supabase,
    session,
    attempt,
    currentTime,
    absoluteSessionTtlSeconds,
    maxSessionAttempts,
    auditLogger,
    shouldWriteAdminAudit(input.actor) ? input.actor.user_id : undefined
  );
  session = expirationResult.session;
  attempt = expirationResult.attempt;

  const custodyStatus = await getItemCustodyStatus(supabase, attempt.item_id);

  return buildSessionStatusResponse(
    session,
    attempt,
    custodyStatus,
    currentTime,
    maxSessionAttempts
  );
}

export async function retryCustodySession(
  input: RetryCustodySessionInput,
  deps?: CustodyServiceDependencies
): Promise<RetryCustodySessionResponse> {
  const {
    getSupabase,
    now,
    hashSessionToken,
    generateManualEntryCode,
    qrSessionTtlSeconds,
    absoluteSessionTtlSeconds,
    maxSessionAttempts,
    auditLogger,
  } = resolveDependencies(deps);
  const supabase = getSupabase();
  const currentTime = now();

  let session = await getSessionById(supabase, input.qr_code_session_id);
  let attempt = await getAttemptById(supabase, session.custody_attempt_id);

  assertActorOwnsReporterSession(input.actor, attempt.poster_id);

  const expirationResult = await resolveSessionExpiration(
    supabase,
    session,
    attempt,
    currentTime,
    absoluteSessionTtlSeconds,
    maxSessionAttempts,
    auditLogger,
    input.actor.user_id
  );
  session = expirationResult.session;
  attempt = expirationResult.attempt;

  if (
    expirationResult.finalizedTimeout ||
    attempt.status !== 'open' ||
    session.status !== 'active'
  ) {
    throw createHttpError('Custody handover session is no longer active', 409);
  }

  if (!expirationResult.currentWindowExpired) {
    throw createHttpError('QR session is still active', 409);
  }

  const nextNumberOfAttempts = attempt.number_of_attempts + 1;
  if (nextNumberOfAttempts > maxSessionAttempts) {
    throw createHttpError('Custody handover session is no longer retryable', 409);
  }

  const nextExpiresAt = buildSessionExpirationTimestamp(
    currentTime,
    qrSessionTtlSeconds,
    attempt,
    absoluteSessionTtlSeconds
  );
  const nextTokenHash = hashSessionToken(input.session_token);

  const { error: attemptUpdateError } = await supabase
    .from('custody_attempt_table')
    .update({
      number_of_attempts: nextNumberOfAttempts,
    })
    .eq('custody_attempt_id', attempt.custody_attempt_id);

  if (attemptUpdateError) {
    logger.error(
      { error: attemptUpdateError, custodyAttemptId: attempt.custody_attempt_id },
      'Failed to increment custody retry attempts'
    );
    throw createHttpError('Failed to retry custody handover session', 500);
  }

  let nextManualEntryCode: string;

  try {
    nextManualEntryCode = await rotateSessionManualEntryCode(
      supabase,
      session,
      nextTokenHash,
      nextExpiresAt,
      generateManualEntryCode
    );
  } catch (error) {
    const { error: rollbackError } = await supabase
      .from('custody_attempt_table')
      .update({
        number_of_attempts: attempt.number_of_attempts,
      })
      .eq('custody_attempt_id', attempt.custody_attempt_id);

    if (rollbackError) {
      logger.error(
        { error: rollbackError, custodyAttemptId: attempt.custody_attempt_id },
        'Failed to rollback custody retry attempt counter'
      );
    }

    throw error;
  }

  const updatedAttempt: AttemptRow = {
    ...attempt,
    number_of_attempts: nextNumberOfAttempts,
  };
  const updatedSession: SessionRow = {
    ...session,
    session_token_hash: nextTokenHash,
    manual_entry_code: nextManualEntryCode,
    status: 'active',
    expires_at: nextExpiresAt,
    scanned_by_guard_id: null,
    scanned_at: null,
    closed_at: null,
  };

  const custodyStatus = await getItemCustodyStatus(supabase, attempt.item_id);

  return buildCreateOrRetryResponse(
    updatedSession,
    updatedAttempt,
    custodyStatus,
    maxSessionAttempts
  ) as RetryCustodySessionResponse;
}

export async function cancelCustodySession(
  input: CancelCustodySessionInput,
  deps?: CustodyServiceDependencies
): Promise<CancelCustodySessionResponse> {
  const { getSupabase, now, absoluteSessionTtlSeconds, maxSessionAttempts, auditLogger } =
    resolveDependencies(deps);
  const supabase = getSupabase();
  const currentTime = now();

  let session = await getSessionById(supabase, input.qr_code_session_id);
  let attempt = await getAttemptById(supabase, session.custody_attempt_id);

  assertActorOwnsReporterSession(input.actor, attempt.poster_id);

  const expirationResult = await resolveSessionExpiration(
    supabase,
    session,
    attempt,
    currentTime,
    absoluteSessionTtlSeconds,
    maxSessionAttempts,
    auditLogger,
    shouldWriteAdminAudit(input.actor) ? input.actor.user_id : undefined
  );
  session = expirationResult.session;
  attempt = expirationResult.attempt;

  if (attempt.status === 'cancelled' && session.status === 'cancelled') {
    return buildCancelResponse(
      session,
      attempt,
      await getItemCustodyStatus(supabase, attempt.item_id),
      attempt.closed_at ?? session.closed_at ?? currentTime.toISOString()
    );
  }

  if (
    expirationResult.finalizedTimeout ||
    attempt.status !== 'open' ||
    session.status !== 'active'
  ) {
    throw createHttpError('Custody handover session is no longer cancellable', 409);
  }

  const cancelledAt = currentTime.toISOString();

  const { error: sessionUpdateError } = await supabase
    .from('qr_code_session_table')
    .update({
      status: 'cancelled',
      closed_at: cancelledAt,
    })
    .eq('qr_code_session_id', session.qr_code_session_id);

  if (sessionUpdateError) {
    logger.error(
      { error: sessionUpdateError, qrCodeSessionId: session.qr_code_session_id },
      'Failed to cancel custody QR session'
    );
    throw createHttpError('Failed to cancel custody handover session', 500);
  }

  const { error: attemptUpdateError } = await supabase
    .from('custody_attempt_table')
    .update({
      status: 'cancelled',
      closed_at: cancelledAt,
    })
    .eq('custody_attempt_id', attempt.custody_attempt_id);

  if (attemptUpdateError) {
    logger.error(
      { error: attemptUpdateError, custodyAttemptId: attempt.custody_attempt_id },
      'Failed to cancel custody attempt'
    );

    const { error: rollbackError } = await supabase
      .from('qr_code_session_table')
      .update({
        status: session.status,
        closed_at: session.closed_at,
      })
      .eq('qr_code_session_id', session.qr_code_session_id);

    if (rollbackError) {
      logger.error(
        { error: rollbackError, qrCodeSessionId: session.qr_code_session_id },
        'Failed to rollback custody QR session after cancel failure'
      );
    }

    throw createHttpError('Failed to cancel custody handover session', 500);
  }

  await insertCustodyRecords(supabase, [
    {
      post_id: attempt.post_id,
      item_id: attempt.item_id,
      custody_attempt_id: attempt.custody_attempt_id,
      qr_code_session_id: session.qr_code_session_id,
      guard_post_id: attempt.guard_post_id,
      actor_user_id: input.actor.user_id,
      record_type: 'attempt_cancelled',
      visible_to_poster: true,
      details: {
        attempt_status: 'cancelled',
        qr_status: 'cancelled',
      },
      occurred_at: cancelledAt,
    },
  ]);

  const cancelledSession: SessionRow = {
    ...session,
    status: 'cancelled',
    closed_at: cancelledAt,
  };
  const cancelledAttempt: AttemptRow = {
    ...attempt,
    status: 'cancelled',
    closed_at: cancelledAt,
  };

  return buildCancelResponse(
    cancelledSession,
    cancelledAttempt,
    await getItemCustodyStatus(supabase, attempt.item_id),
    cancelledAt
  );
}

export async function getStudentCustodyHistory(
  input: GetStudentCustodyHistoryInput,
  deps?: CustodyServiceDependencies
): Promise<StudentCustodyHistoryResponse> {
  const { getSupabase } = resolveDependencies(deps);
  const supabase = getSupabase();
  const postRow = await getPostCustodyAccessRow(
    supabase,
    input.post_id,
    'post_id, item_id, poster_id, item_type, post_status, item_status, custody_status, submission_date'
  );

  await assertCanReadPostCustodyHistory(supabase, input.actor, postRow);

  const { data: historyRows, error: historyError } = await supabase
    .from('custody_record_table')
    .select(
      'custody_record_id, post_id, item_id, custody_attempt_id, qr_code_session_id, guard_post_id, actor_user_id, record_type, details, occurred_at'
    )
    .eq('post_id', input.post_id)
    .eq('visible_to_poster', true)
    .order('occurred_at', { ascending: true });

  if (historyError) {
    logger.error(
      { error: historyError, postId: input.post_id },
      'Failed to fetch student custody history'
    );
    throw createHttpError('Failed to fetch custody history', 500);
  }

  const { data: attempts, error: attemptsError } = await supabase
    .from('custody_attempt_table')
    .select('custody_attempt_id, attempt_number, handover_image_id, guard_post_id')
    .eq('post_id', input.post_id)
    .order('attempt_number', { ascending: true });

  if (attemptsError) {
    logger.error(
      { error: attemptsError, postId: input.post_id },
      'Failed to fetch custody attempts for history'
    );
    throw createHttpError('Failed to fetch custody history', 500);
  }

  const attemptRows = (attempts ?? []) as Array<
    Pick<
      AttemptRow,
      'custody_attempt_id' | 'attempt_number' | 'handover_image_id' | 'guard_post_id'
    >
  >;
  const attemptMap = new Map(attemptRows.map((attempt) => [attempt.custody_attempt_id, attempt]));

  const handoverImageIds = Array.from(
    new Set(attemptRows.map((attempt) => attempt.handover_image_id))
  );
  let handoverImageMap = new Map<number, string | null>();
  if (handoverImageIds.length > 0) {
    const { data: handoverImages, error: handoverImagesError } = await supabase
      .from('item_image_table')
      .select('item_image_id, image_link')
      .in('item_image_id', handoverImageIds);

    if (handoverImagesError) {
      logger.error(
        { error: handoverImagesError, postId: input.post_id },
        'Failed to fetch handover images for history'
      );
      throw createHttpError('Failed to fetch custody history', 500);
    }

    handoverImageMap = new Map(
      ((handoverImages ?? []) as HandoverImageRow[]).map((image) => [
        image.item_image_id as number,
        image.image_link,
      ])
    );
  }

  const guardPostIds = Array.from(
    new Set(
      [
        ...attemptRows.map((attempt) => attempt.guard_post_id),
        ...((historyRows ?? []) as CustodyHistoryRow[])
          .map((record) => record.guard_post_id)
          .filter((guardPostId): guardPostId is string => Boolean(guardPostId)),
      ].filter((guardPostId): guardPostId is string => Boolean(guardPostId))
    )
  );

  let guardPostMap = new Map<string, GuardPostRow>();
  let locationMap = new Map<number, string | null>();
  if (guardPostIds.length > 0) {
    const { data: guardPosts, error: guardPostsError } = await supabase
      .from('guard_post_table')
      .select('guard_post_id, guard_post_name, location_id, is_active')
      .in('guard_post_id', guardPostIds);

    if (guardPostsError) {
      logger.error(
        { error: guardPostsError, postId: input.post_id },
        'Failed to fetch guard posts for history'
      );
      throw createHttpError('Failed to fetch custody history', 500);
    }

    const guardPostRows = (guardPosts ?? []) as GuardPostRow[];
    guardPostMap = new Map(guardPostRows.map((guardPost) => [guardPost.guard_post_id, guardPost]));

    const locationIds = Array.from(
      new Set(guardPostRows.map((guardPost) => guardPost.location_id))
    );
    if (locationIds.length > 0) {
      const { data: locations, error: locationsError } = await supabase
        .from('location_lookup')
        .select('location_id, full_location_name')
        .in('location_id', locationIds);

      if (locationsError) {
        logger.error(
          { error: locationsError, postId: input.post_id },
          'Failed to fetch guard post locations for history'
        );
        throw createHttpError('Failed to fetch custody history', 500);
      }

      locationMap = new Map(
        ((locations ?? []) as LocationRow[]).map((location) => [
          location.location_id,
          location.full_location_name,
        ])
      );
    }
  }

  const actorIds = Array.from(
    new Set(
      ((historyRows ?? []) as CustodyHistoryRow[]).flatMap((record) => {
        const guardId =
          typeof record.details?.guard_id === 'string' ? record.details.guard_id : null;

        return [record.actor_user_id, guardId].filter((actorUserId): actorUserId is string =>
          Boolean(actorUserId)
        );
      })
    )
  );
  let actorNameMap = new Map<string, string | null>();
  if (actorIds.length > 0) {
    const { data: actors, error: actorsError } = await supabase
      .from('user_table')
      .select('user_id, user_name')
      .in('user_id', actorIds);

    if (actorsError) {
      logger.error(
        { error: actorsError, postId: input.post_id },
        'Failed to fetch custody actor names for history'
      );
      throw createHttpError('Failed to fetch custody history', 500);
    }

    actorNameMap = new Map(
      ((actors ?? []) as UserNameRow[]).map((actor) => [actor.user_id, actor.user_name])
    );
  }

  const history: StudentCustodyHistoryEntry[] = [];
  const custodyHistoryRows = (historyRows ?? []) as CustodyHistoryRow[];

  history.push({
    history_id: `item-reported-${input.post_id}`,
    event_type: 'item_reported',
    source_record_type: null,
    message: 'Item reported in Umak Link',
    occurred_at: postRow.submission_date ?? new Date(0).toISOString(),
    custody_attempt_id: null,
    qr_code_session_id: null,
    attempt_number: null,
    guard_post_id: null,
    guard_post_name: null,
    full_location_name: null,
    handover_image_url: null,
    actor_user_id: postRow.poster_id,
    actor_name: null,
  });

  for (const record of custodyHistoryRows) {
    const attempt = record.custody_attempt_id
      ? (attemptMap.get(record.custody_attempt_id) ?? null)
      : null;
    const guardPostId = record.guard_post_id ?? attempt?.guard_post_id ?? null;
    const guardPost = guardPostId ? (guardPostMap.get(guardPostId) ?? null) : null;
    const guardPostName = guardPost?.guard_post_name ?? null;
    const fullLocationName = guardPost ? (locationMap.get(guardPost.location_id) ?? null) : null;
    const locationLabel = fullLocationName ?? guardPostName ?? 'selected guard post';
    const handoverImageUrl = attempt
      ? (handoverImageMap.get(attempt.handover_image_id) ?? null)
      : null;
    const actorName = record.actor_user_id
      ? (actorNameMap.get(record.actor_user_id) ?? null)
      : null;
    const reportedGuardId =
      typeof record.details?.guard_id === 'string' ? record.details.guard_id : null;
    const reportedGuardName = reportedGuardId ? (actorNameMap.get(reportedGuardId) ?? null) : null;
    const decisionReason =
      typeof record.details?.decision_reason === 'string' ? record.details.decision_reason : null;
    const discardReason =
      typeof record.details?.discard_reason === 'string' ? record.details.discard_reason : null;

    let eventType: StudentCustodyHistoryEntry['event_type'] | null = null;
    let message: string | null = null;

    switch (record.record_type) {
      case 'staff_marked_with_reporter':
        eventType = 'item_reported';
        message = 'Item is with the reporter';
        break;
      case 'staff_marked_with_guard':
        eventType = 'guard_accepted';
        message = 'Item is with the guard';
        break;
      case 'attempt_started':
        eventType = 'handover_attempted';
        message = `Guard handover attempted at ${locationLabel}`;
        break;
      case 'guard_rejected':
        eventType = 'guard_rejected';
        message = `Guard ${actorName ?? 'Unknown Guard'} has rejected the handover`;
        break;
      case 'guard_accepted':
        eventType = 'guard_accepted';
        message = `Guard ${actorName ?? 'Unknown Guard'} has accepted handover`;
        break;
      case 'qr_expired':
        eventType = 'session_timed_out';
        message = `Guard handover session timed out at ${locationLabel}`;
        break;
      case 'security_office_received':
        eventType = 'security_office_received';
        message = 'Item is in Security office';
        break;
      case 'attempt_cancelled':
        eventType = 'attempt_cancelled';
        message = 'Guard handover session was cancelled by the student';
        break;
      case 'investigation_opened':
        eventType = 'under_investigation';
        message = 'This handover is under investigation';
        break;
      case 'physical_take_reported':
        eventType = 'physical_take_reported';
        message = `A physical handover without QR acceptance involving Guard ${reportedGuardName ?? 'Unknown Guard'} was reported`;
        break;
      case 'claimed_by_student':
        eventType = 'claimed_by_student';
        message = 'Item has been claimed by the student';
        break;
      case 'item_discarded':
        eventType = 'discarded';
        message = 'Item was discarded by staff';
        break;
      default:
        break;
    }

    if (!eventType || !message) {
      continue;
    }

    history.push({
      history_id: record.custody_record_id,
      event_type: eventType,
      source_record_type: record.record_type,
      message,
      occurred_at: record.occurred_at,
      custody_attempt_id: record.custody_attempt_id,
      qr_code_session_id: record.qr_code_session_id,
      attempt_number: attempt?.attempt_number ?? null,
      guard_post_id: guardPostId,
      guard_post_name: guardPostName,
      full_location_name: fullLocationName,
      handover_image_url: handoverImageUrl,
      actor_user_id: record.actor_user_id,
      actor_name: actorName,
      decision_reason: decisionReason,
      discard_reason: discardReason,
    });
  }

  history.sort((left, right) => {
    return new Date(left.occurred_at).getTime() - new Date(right.occurred_at).getTime();
  });

  const latestHistoryEvent = history[history.length - 1] ?? null;
  const derivedCustodyStatus =
    latestHistoryEvent?.event_type === 'discarded'
      ? 'discarded'
      : latestHistoryEvent?.event_type === 'claimed_by_student'
        ? 'claimed_by_student'
        : (postRow.custody_status ?? (await getItemCustodyStatus(supabase, postRow.item_id)));

  return {
    post_id: postRow.post_id,
    item_id: postRow.item_id,
    post_status: postRow.post_status,
    custody_status: derivedCustodyStatus,
    history,
  };
}

export async function markPostReceivedInSecurityOffice(
  input: SecurityOfficeReceiptInput,
  deps?: CustodyServiceDependencies
): Promise<SecurityOfficeReceiptResponse> {
  const { getSupabase, now, auditLogger } = resolveDependencies(deps);
  const supabase = getSupabase();
  const currentTime = now();
  const timestamp = currentTime.toISOString();

  const postRow = await getPostCustodyAccessRow(
    supabase,
    input.post_id,
    'post_id, item_id, item_name, poster_id, item_type, post_status, custody_status'
  );
  if (postRow.item_type !== 'found') {
    throw createHttpError('Custody flow only applies to found items', 400);
  }

  const acceptedAttempt = await getLatestAcceptedAttemptForPost(supabase, input.post_id);

  if (acceptedAttempt.office_received_at) {
    return {
      post_id: input.post_id,
      custody_attempt_id: acceptedAttempt.custody_attempt_id,
      custody_status: await getItemCustodyStatus(supabase, acceptedAttempt.item_id),
      office_received_at: acceptedAttempt.office_received_at,
    };
  }

  const { error: updateError } = await supabase
    .from('custody_attempt_table')
    .update({
      office_received_by_staff_id: input.actor.user_id,
      office_received_at: timestamp,
    })
    .eq('custody_attempt_id', acceptedAttempt.custody_attempt_id);

  if (updateError) {
    logger.error(
      {
        error: updateError,
        postId: input.post_id,
        custodyAttemptId: acceptedAttempt.custody_attempt_id,
      },
      'Failed to mark custody attempt as received in security office'
    );
    throw createHttpError('Failed to mark item as received in the Security Office', 500);
  }

  await persistItemCustodyStatus(supabase, [acceptedAttempt.item_id], 'in_security_office', {
    postId: input.post_id,
    custodyAttemptIds: [acceptedAttempt.custody_attempt_id],
    action: 'markPostReceivedInSecurityOffice',
  });

  await insertCustodyRecords(supabase, [
    {
      post_id: acceptedAttempt.post_id,
      item_id: acceptedAttempt.item_id,
      custody_attempt_id: acceptedAttempt.custody_attempt_id,
      qr_code_session_id: null,
      guard_post_id: acceptedAttempt.guard_post_id,
      actor_user_id: input.actor.user_id,
      record_type: 'security_office_received',
      visible_to_poster: true,
      details: {
        office_received_at: timestamp,
      },
      occurred_at: timestamp,
    },
  ]);

  const actorLabel = await getAuditActorLabel(supabase, input.actor);
  const postTitle = await getAuditPostTitle(supabase, acceptedAttempt.post_id, postRow.item_name);

  await auditLogger({
    userId: input.actor.user_id,
    actionType: 'custody_security_office_received',
    tableName: 'custody_attempt_table',
    recordId: acceptedAttempt.custody_attempt_id,
    details: {
      message: `${actorLabel} received ${postTitle} in the Security Office`,
      item_name: postRow.item_name ?? 'Unknown Item',
      post_title: postTitle,
      post_id: acceptedAttempt.post_id,
      item_id: acceptedAttempt.item_id,
      custody_attempt_id: acceptedAttempt.custody_attempt_id,
    },
  });

  return {
    post_id: input.post_id,
    custody_attempt_id: acceptedAttempt.custody_attempt_id,
    custody_status: await getItemCustodyStatus(supabase, acceptedAttempt.item_id),
    office_received_at: timestamp,
  };
}

export async function openCustodyInvestigation(
  input: OpenCustodyInvestigationInput,
  deps?: CustodyServiceDependencies
): Promise<OpenCustodyInvestigationResponse> {
  const { getSupabase, now, auditLogger } = resolveDependencies(deps);
  const supabase = getSupabase();
  const currentTime = now();
  const timestamp = currentTime.toISOString();

  const postRow = await getPostCustodyAccessRow(
    supabase,
    input.post_id,
    'post_id, item_id, item_name, poster_id, item_type, post_status, custody_status'
  );
  if (postRow.item_type !== 'found') {
    throw createHttpError('Custody flow only applies to found items', 400);
  }

  const latestAttempt = await getLatestAttemptForPost(supabase, input.post_id);

  if (latestAttempt.investigation_opened_at) {
    return {
      post_id: input.post_id,
      custody_attempt_id: latestAttempt.custody_attempt_id,
      custody_status: await getItemCustodyStatus(supabase, latestAttempt.item_id),
      investigation_opened_at: latestAttempt.investigation_opened_at,
    };
  }

  const { error: updateError } = await supabase
    .from('custody_attempt_table')
    .update({
      investigation_opened_by: input.actor.user_id,
      investigation_opened_at: timestamp,
    })
    .eq('custody_attempt_id', latestAttempt.custody_attempt_id);

  if (updateError) {
    logger.error(
      {
        error: updateError,
        postId: input.post_id,
        custodyAttemptId: latestAttempt.custody_attempt_id,
      },
      'Failed to open custody investigation'
    );
    throw createHttpError('Failed to open custody investigation', 500);
  }

  await persistItemCustodyStatus(supabase, [latestAttempt.item_id], 'under_investigation', {
    postId: input.post_id,
    custodyAttemptIds: [latestAttempt.custody_attempt_id],
    action: 'openCustodyInvestigation',
  });

  await insertCustodyRecords(supabase, [
    {
      post_id: latestAttempt.post_id,
      item_id: latestAttempt.item_id,
      custody_attempt_id: latestAttempt.custody_attempt_id,
      qr_code_session_id: null,
      guard_post_id: latestAttempt.guard_post_id,
      actor_user_id: input.actor.user_id,
      record_type: 'investigation_opened',
      visible_to_poster: true,
      details: {
        attempt_status: latestAttempt.status,
      },
      occurred_at: timestamp,
    },
  ]);

  const actorLabel = await getAuditActorLabel(supabase, input.actor);
  const postTitle = await getAuditPostTitle(supabase, latestAttempt.post_id, postRow.item_name);

  await auditLogger({
    userId: input.actor.user_id,
    actionType: 'custody_investigation_opened',
    tableName: 'custody_attempt_table',
    recordId: latestAttempt.custody_attempt_id,
    details: {
      message: `${actorLabel} opened a custody investigation for ${postTitle}`,
      post_title: postTitle,
      post_id: latestAttempt.post_id,
      item_id: latestAttempt.item_id,
      custody_attempt_id: latestAttempt.custody_attempt_id,
    },
  });

  return {
    post_id: input.post_id,
    custody_attempt_id: latestAttempt.custody_attempt_id,
    custody_status: await getItemCustodyStatus(supabase, latestAttempt.item_id),
    investigation_opened_at: timestamp,
  };
}

export async function updatePostCustodyStatus(
  input: UpdatePostCustodyStatusInput,
  deps?: CustodyServiceDependencies
): Promise<UpdatePostCustodyStatusResponse> {
  const { getSupabase, now, auditLogger } = resolveDependencies(deps);
  const supabase = getSupabase();
  const timestamp = input.occurred_at ?? now().toISOString();

  const postRow = await getPostCustodyAccessRow(
    supabase,
    input.post_id,
    'post_id, item_id, item_name, poster_id, item_type, post_status, item_status, custody_status'
  );

  if (postRow.item_type !== 'found') {
    throw createHttpError('Custody flow only applies to found items', 400);
  }

  const currentCustodyStatus =
    postRow.custody_status ?? (await getItemCustodyStatus(supabase, postRow.item_id));
  const isClaimedFoundItem = (postRow.item_status ?? '').toLowerCase() === 'claimed';
  const isUntrackedFoundItem = currentCustodyStatus === 'untracked';

  if (isUntrackedFoundItem) {
    if (!isUntrackedEditableCustodyStatus(input.custody_status)) {
      throw createHttpError(
        'Untracked found items can update custody status only to with reporter, with guard, or in security office',
        409
      );
    }
  } else if (isClaimedFoundItem) {
    if (!isClaimedCustodyStatus(input.custody_status)) {
      throw createHttpError(
        'Claimed found items can update custody status only to in security office, under investigation, or claimed by student',
        409
      );
    }
  } else {
    throw createHttpError('Only claimed found items or untracked found items can update custody status', 409);
  }

  if (currentCustodyStatus === input.custody_status) {
    return {
      post_id: postRow.post_id,
      item_id: postRow.item_id,
      custody_status: input.custody_status,
      updated_at: timestamp,
    };
  }

  const { error: updateError } = await supabase
    .from('item_table')
    .update({ custody_status: input.custody_status })
    .eq('item_id', postRow.item_id);

  if (updateError) {
    logger.error(
      {
        error: updateError,
        postId: input.post_id,
        itemId: postRow.item_id,
        custodyStatus: input.custody_status,
      },
      'Failed to update post custody status'
    );
    throw createHttpError('Failed to update post custody status', 500);
  }

  await insertCustodyRecords(supabase, [
    {
      post_id: postRow.post_id,
      item_id: postRow.item_id,
      custody_attempt_id: null,
      qr_code_session_id: null,
      guard_post_id: null,
      actor_user_id: input.actor.user_id,
      record_type: getPostCustodyRecordType(input.custody_status),
      visible_to_poster: true,
      details: {
        previous_custody_status: currentCustodyStatus,
        next_custody_status: input.custody_status,
        ...input.details,
      },
      occurred_at: timestamp,
    },
  ]);

  const actorLabel = await getAuditActorLabel(supabase, input.actor);
  const postTitle = await getAuditPostTitle(supabase, postRow.post_id, postRow.item_name);

  await auditLogger({
    userId: input.actor.user_id,
    actionType: getPostCustodyAuditAction(input.custody_status),
    tableName: 'item_table',
    recordId: postRow.item_id,
    details: {
      message: getPostCustodyStatusMessage(actorLabel, postTitle, input.custody_status),
      post_title: postTitle,
      post_id: postRow.post_id,
      item_id: postRow.item_id,
      old_custody_status: currentCustodyStatus,
      new_custody_status: input.custody_status,
    },
  });

  return {
    post_id: postRow.post_id,
    item_id: postRow.item_id,
    custody_status: input.custody_status,
    updated_at: timestamp,
  };
}

export async function reportPhysicalTake(
  input: ReportPhysicalTakeInput,
  deps?: CustodyServiceDependencies
): Promise<PhysicalTakeReportResponse> {
  const { getSupabase, now, auditLogger } = resolveDependencies(deps);
  const supabase = getSupabase();
  const currentTime = now();
  const timestamp = currentTime.toISOString();

  const postRow = await getPostCustodyAccessRow(
    supabase,
    input.post_id,
    'post_id, item_id, item_name, poster_id, item_type, post_status, custody_status'
  );
  if (postRow.item_type !== 'found') {
    throw createHttpError('Custody flow only applies to found items', 400);
  }

  await assertGuardUserExists(supabase, input.guard_id);

  const latestAttempt = await getLatestAttemptForPost(supabase, input.post_id);
  if (latestAttempt.status === 'accepted' || latestAttempt.status === 'rejected') {
    throw createHttpError(
      'Physical take can only be reported when the latest custody attempt has no guard decision',
      409
    );
  }

  await insertCustodyRecords(supabase, [
    {
      post_id: latestAttempt.post_id,
      item_id: latestAttempt.item_id,
      custody_attempt_id: latestAttempt.custody_attempt_id,
      qr_code_session_id: null,
      guard_post_id: latestAttempt.guard_post_id,
      actor_user_id: input.actor.user_id,
      record_type: 'physical_take_reported',
      visible_to_poster: true,
      details: {
        guard_id: input.guard_id,
        attempt_status: latestAttempt.status,
      },
      occurred_at: timestamp,
    },
  ]);

  const actorLabel = await getAuditActorLabel(supabase, input.actor);
  const postTitle = await getAuditPostTitle(supabase, latestAttempt.post_id, postRow.item_name);

  await auditLogger({
    userId: input.actor.user_id,
    actionType: 'custody_physical_take_reported',
    tableName: 'custody_record_table',
    recordId: latestAttempt.custody_attempt_id,
    details: {
      message: `${actorLabel} reported a physical take for ${postTitle}`,
      post_title: postTitle,
      post_id: latestAttempt.post_id,
      item_id: latestAttempt.item_id,
      custody_attempt_id: latestAttempt.custody_attempt_id,
      guard_id: input.guard_id,
    },
  });

  return {
    post_id: input.post_id,
    custody_attempt_id: latestAttempt.custody_attempt_id,
    guard_id: input.guard_id,
    custody_status: await getItemCustodyStatus(supabase, latestAttempt.item_id),
    reported_at: timestamp,
  };
}

export async function notifyGuardForCustodyFollowUp(
  input: NotifyGuardInput,
  deps?: CustodyServiceDependencies
): Promise<NotifyGuardResponse> {
  const { getSupabase, now, auditLogger, notificationCreator } = resolveDependencies(deps);
  const supabase = getSupabase();
  const currentTime = now();
  const timestamp = currentTime.toISOString();

  const postRow = await getPostCustodyAccessRow(
    supabase,
    input.post_id,
    'post_id, item_id, item_name, poster_id, item_type, post_status, custody_status'
  );
  if (postRow.item_type !== 'found') {
    throw createHttpError('Custody flow only applies to found items', 400);
  }

  const acceptedAttempt = await getLatestAcceptedAttemptForPost(supabase, input.post_id);
  if (!acceptedAttempt.decision_by_guard_id) {
    throw createHttpError('No accepted guard was found for this custody attempt', 409);
  }

  if (acceptedAttempt.office_received_at) {
    throw createHttpError('Item is already marked as received in the Security Office', 409);
  }

  const notificationId = await notificationCreator({
    user_id: acceptedAttempt.decision_by_guard_id,
    title: 'Custody Follow-up Needed',
    body: 'A staff member requested follow-up for a custody handover that has not yet been received in the Security Office.',
    description:
      'Please review the accepted custody handover and coordinate delivery to the Security Office.',
    type: 'custody_guard_follow_up',
    data: {
      post_id: acceptedAttempt.post_id,
      custody_attempt_id: acceptedAttempt.custody_attempt_id,
      guard_id: acceptedAttempt.decision_by_guard_id,
      url: '/guard/notifications',
    },
    sent_by: input.actor.user_id,
    skip_push: true,
  });

  if (!notificationId) {
    throw createHttpError('Failed to create guard follow-up notification', 500);
  }

  const actorLabel = await getAuditActorLabel(supabase, input.actor);
  const postTitle = await getAuditPostTitle(supabase, acceptedAttempt.post_id, postRow.item_name);

  await auditLogger({
    userId: input.actor.user_id,
    actionType: 'custody_guard_notification_requested',
    tableName: 'custody_attempt_table',
    recordId: acceptedAttempt.custody_attempt_id,
    details: {
      message: `${actorLabel} requested guard follow-up for ${postTitle}`,
      post_title: postTitle,
      post_id: acceptedAttempt.post_id,
      item_id: acceptedAttempt.item_id,
      custody_attempt_id: acceptedAttempt.custody_attempt_id,
      guard_id: acceptedAttempt.decision_by_guard_id,
      notification_id: notificationId,
    },
  });

  return {
    post_id: input.post_id,
    custody_attempt_id: acceptedAttempt.custody_attempt_id,
    guard_id: acceptedAttempt.decision_by_guard_id,
    notification_id: notificationId,
    notification_status: 'created',
    requested_at: timestamp,
  };
}

export async function scanCustodySession(
  input: GuardScanInput,
  deps?: CustodyServiceDependencies
): Promise<GuardScanResponse> {
  const {
    getSupabase,
    now,
    hashSessionToken,
    absoluteSessionTtlSeconds,
    maxSessionAttempts,
    auditLogger,
  } = resolveDependencies(deps);
  const supabase = getSupabase();
  const currentTime = now();

  const isManualEntryCodeScan = 'manual_entry_code' in input;
  let session = isManualEntryCodeScan
    ? await getSessionByManualEntryCode(supabase, input.manual_entry_code)
    : await getSessionById(supabase, input.qr_code_session_id);
  let attempt = await getAttemptById(supabase, session.custody_attempt_id);

  const expirationResult = await resolveSessionExpiration(
    supabase,
    session,
    attempt,
    currentTime,
    absoluteSessionTtlSeconds,
    maxSessionAttempts,
    auditLogger
  );
  session = expirationResult.session;
  attempt = expirationResult.attempt;

  if (expirationResult.currentWindowExpired && !expirationResult.finalizedTimeout) {
    throw createHttpError('QR session expired. Generate a new QR for this handover session.', 409);
  }

  if (session.status !== 'active' || attempt.status !== 'open') {
    throw createHttpError('QR session is no longer active', 409);
  }

  if (!isManualEntryCodeScan) {
    const providedHash = hashSessionToken(input.session_token);
    if (providedHash !== session.session_token_hash) {
      throw createHttpError('Invalid QR session token', 401);
    }
  }

  if (session.scanned_by_guard_id && session.scanned_by_guard_id !== input.actor.user_id) {
    throw createHttpError('QR session already scanned by another guard', 409);
  }

  const isFirstGuardScan = !session.scanned_by_guard_id;
  if (isFirstGuardScan) {
    const scannedAt = currentTime.toISOString();
    const { error: scanUpdateError } = await supabase
      .from('qr_code_session_table')
      .update({
        scanned_by_guard_id: input.actor.user_id,
        scanned_at: scannedAt,
      })
      .eq('qr_code_session_id', session.qr_code_session_id);

    if (scanUpdateError) {
      logger.error(
        { error: scanUpdateError, qrCodeSessionId: session.qr_code_session_id },
        'Failed to mark QR session as scanned'
      );
      throw createHttpError('Failed to scan QR session', 500);
    }

    await insertCustodyRecords(supabase, [
      {
        post_id: attempt.post_id,
        item_id: attempt.item_id,
        custody_attempt_id: attempt.custody_attempt_id,
        qr_code_session_id: session.qr_code_session_id,
        guard_post_id: attempt.guard_post_id,
        actor_user_id: input.actor.user_id,
        record_type: 'qr_scanned',
        visible_to_poster: true,
        details: {
          scanned_by_guard_id: input.actor.user_id,
        },
        occurred_at: scannedAt,
      },
    ]);

    session = {
      ...session,
      scanned_by_guard_id: input.actor.user_id,
      scanned_at: scannedAt,
    };
  }

  const { data: handoverImage, error: handoverImageError } = await supabase
    .from('item_image_table')
    .select('image_link')
    .eq('item_image_id', attempt.handover_image_id)
    .single();

  if (handoverImageError || !handoverImage) {
    logger.error(
      { error: handoverImageError, handoverImageId: attempt.handover_image_id },
      'Failed to fetch handover image'
    );
    throw createHttpError('Failed to fetch handover details', 500);
  }

  const { data: guardPost, error: guardPostError } = await supabase
    .from('guard_post_table')
    .select('guard_post_name')
    .eq('guard_post_id', attempt.guard_post_id)
    .single();

  if (guardPostError || !guardPost) {
    logger.error(
      { error: guardPostError, guardPostId: attempt.guard_post_id },
      'Failed to fetch guard post details'
    );
    throw createHttpError('Failed to fetch guard handover details', 500);
  }

  const { data: postDetails, error: postDetailsError } = await supabase
    .from('post_public_view')
    .select(
      'post_id, item_id, item_name, item_description, item_image_url, category, last_seen_at, last_seen_location, submission_date'
    )
    .eq('post_id', attempt.post_id)
    .single();

  if (postDetailsError || !postDetails) {
    logger.error(
      { error: postDetailsError, postId: attempt.post_id },
      'Failed to fetch guard-visible post details'
    );
    throw createHttpError('Failed to fetch post details', 500);
  }

  if (isFirstGuardScan) {
    const guardName = await getAuditActorName(supabase, input.actor);
    const postTitle = await getAuditPostTitle(
      supabase,
      attempt.post_id,
      (postDetails as GuardPostDetailsRow).item_name
    );

    await auditLogger({
      userId: input.actor.user_id,
      actionType: 'custody_qr_scanned',
      tableName: 'qr_code_session_table',
      recordId: session.qr_code_session_id,
      details: {
        message: 'Handover QR Code Scanned',
        guard_name: guardName,
        item_name: (postDetails as GuardPostDetailsRow).item_name,
        post_title: postTitle,
        custody_attempt_id: attempt.custody_attempt_id,
        post_id: attempt.post_id,
        item_id: attempt.item_id,
      },
    });
  }

  const custodyStatus = await getItemCustodyStatus(supabase, attempt.item_id);

  return {
    qr_code_session_id: session.qr_code_session_id,
    custody_attempt_id: attempt.custody_attempt_id,
    post_id: attempt.post_id,
    item_id: attempt.item_id,
    item_name: (postDetails as GuardPostDetailsRow).item_name,
    item_description: (postDetails as GuardPostDetailsRow).item_description,
    item_image_url: (postDetails as GuardPostDetailsRow).item_image_url,
    handover_image_url: (handoverImage as HandoverImageRow).image_link,
    category: (postDetails as GuardPostDetailsRow).category,
    last_seen_at: (postDetails as GuardPostDetailsRow).last_seen_at,
    last_seen_location: (postDetails as GuardPostDetailsRow).last_seen_location,
    submission_date: (postDetails as GuardPostDetailsRow).submission_date,
    guard_post_id: attempt.guard_post_id,
    guard_post_name: (guardPost as GuardPostLookupRow).guard_post_name,
    attempt_number: attempt.attempt_number,
    custody_status: custodyStatus,
    qr_status: session.status,
    attempt_status: attempt.status,
  };
}

export async function decideCustodyAttempt(
  input: GuardDecisionInput,
  deps?: CustodyServiceDependencies
): Promise<GuardDecisionResponse> {
  const { getSupabase, now, absoluteSessionTtlSeconds, maxSessionAttempts, auditLogger } =
    resolveDependencies(deps);
  const supabase = getSupabase();
  const currentTime = now();
  const decisionAt = currentTime.toISOString();

  let attempt = await getAttemptById(supabase, input.custody_attempt_id);
  let session = await getSessionById(supabase, input.qr_code_session_id);

  if (session.custody_attempt_id !== attempt.custody_attempt_id) {
    throw createHttpError('QR session does not belong to this custody attempt', 400);
  }

  const expirationResult = await resolveSessionExpiration(
    supabase,
    session,
    attempt,
    currentTime,
    absoluteSessionTtlSeconds,
    maxSessionAttempts,
    auditLogger
  );
  session = expirationResult.session;
  attempt = expirationResult.attempt;

  if (expirationResult.currentWindowExpired && !expirationResult.finalizedTimeout) {
    throw createHttpError('QR session expired. Student must retry this handover session.', 409);
  }

  if (attempt.status !== 'open' || session.status !== 'active') {
    throw createHttpError('Custody attempt is no longer active', 409);
  }

  if (!session.scanned_by_guard_id) {
    throw createHttpError('QR session must be scanned before a guard can decide the handover', 409);
  }

  if (session.scanned_by_guard_id !== input.actor.user_id) {
    throw createHttpError('Only the guard who scanned the QR can decide this handover', 403);
  }

  const nextAttemptStatus: CustodyDecision = input.decision;
  const nextSessionStatus = input.decision;

  const { error: attemptUpdateError } = await supabase
    .from('custody_attempt_table')
    .update({
      status: nextAttemptStatus,
      decision_by_guard_id: input.actor.user_id,
      decision_at: decisionAt,
      decision_reason: input.decision_reason ?? null,
      closed_at: decisionAt,
    })
    .eq('custody_attempt_id', attempt.custody_attempt_id);

  if (attemptUpdateError) {
    logger.error(
      { error: attemptUpdateError, custodyAttemptId: attempt.custody_attempt_id },
      'Failed to update custody attempt decision'
    );
    throw createHttpError('Failed to save guard decision', 500);
  }

  const { error: sessionUpdateError } = await supabase
    .from('qr_code_session_table')
    .update({
      status: nextSessionStatus,
      scanned_by_guard_id: input.actor.user_id,
      scanned_at: session.scanned_at ?? decisionAt,
      closed_at: decisionAt,
    })
    .eq('qr_code_session_id', session.qr_code_session_id);

  if (sessionUpdateError) {
    logger.error(
      { error: sessionUpdateError, qrCodeSessionId: session.qr_code_session_id },
      'Failed to update QR session decision'
    );
    throw createHttpError('Failed to save guard decision', 500);
  }

  await insertCustodyRecords(supabase, [
    {
      post_id: attempt.post_id,
      item_id: attempt.item_id,
      custody_attempt_id: attempt.custody_attempt_id,
      qr_code_session_id: session.qr_code_session_id,
      guard_post_id: attempt.guard_post_id,
      actor_user_id: input.actor.user_id,
      record_type: input.decision === 'accepted' ? 'guard_accepted' : 'guard_rejected',
      visible_to_poster: true,
      details: {
        decision: input.decision,
        decision_reason: input.decision_reason ?? null,
      },
      occurred_at: decisionAt,
    },
  ]);

  const actorLabel = await getAuditActorLabel(supabase, input.actor);
  const guardName = await getAuditActorName(supabase, input.actor);
  const postTitle = await getAuditPostTitle(supabase, attempt.post_id);
  const actionLabel = input.decision === 'accepted' ? 'Accepted Handover' : 'Rejected Handover';

  await auditLogger({
    userId: input.actor.user_id,
    actionType: 'custody_attempt_decided',
    tableName: 'custody_attempt_table',
    recordId: attempt.custody_attempt_id,
    details: {
      message: `${actorLabel} ${actionLabel}`,
      guard_name: guardName,
      item_name: postTitle,
      post_title: postTitle,
      qr_code_session_id: session.qr_code_session_id,
      post_id: attempt.post_id,
      item_id: attempt.item_id,
      decision: input.decision,
    },
  });

  const custodyStatus = await getItemCustodyStatus(supabase, attempt.item_id);

  return {
    custody_attempt_id: attempt.custody_attempt_id,
    qr_code_session_id: session.qr_code_session_id,
    attempt_status: nextAttemptStatus,
    qr_status: nextSessionStatus,
    custody_status: custodyStatus,
    decision_at: decisionAt,
  };
}

export async function expireCustodySessions(
  deps?: CustodyServiceDependencies
): Promise<ExpireCustodySessionsResponse> {
  const { getSupabase, now, absoluteSessionTtlSeconds, maxSessionAttempts, auditLogger } =
    resolveDependencies(deps);
  const supabase = getSupabase();
  const currentTime = now();

  const { data: activeSessions, error } = await supabase
    .from('qr_code_session_table')
    .select(SESSION_SELECT_COLUMNS)
    .eq('status', 'active');

  if (error) {
    logger.error({ error }, 'Failed to fetch expired custody sessions');
    throw createHttpError('Failed to expire custody sessions', 500);
  }

  let expiredCount = 0;
  for (const row of (activeSessions ?? []) as SessionRow[]) {
    const attempt = await getAttemptById(supabase, row.custody_attempt_id);
    const result = await resolveSessionExpiration(
      supabase,
      row,
      attempt,
      currentTime,
      absoluteSessionTtlSeconds,
      maxSessionAttempts,
      auditLogger
    );

    if (result.finalizedTimeout) {
      expiredCount += 1;
    }
  }

  return {
    expired_count: expiredCount,
  };
}

export async function escalateStaleAcceptedCustodyAttempts(
  deps?: CustodyServiceDependencies
): Promise<EscalateStaleAcceptedCustodyAttemptsResponse> {
  const { getSupabase, now, staleAcceptedEscalationHours, automationStaffUserId, auditLogger } =
    resolveDependencies(deps);
  const supabase = getSupabase();
  const currentTime = now();
  const timestamp = currentTime.toISOString();
  const thresholdIso = new Date(
    currentTime.getTime() - staleAcceptedEscalationHours * 60 * 60 * 1000
  ).toISOString();

  const automationActor = await getAutomationStaffActor(supabase, automationStaffUserId);
  const staleAttempts = await getStaleAcceptedAttemptsForEscalation(supabase, thresholdIso);

  if (staleAttempts.length === 0) {
    return {
      escalated_count: 0,
    };
  }

  const custodyAttemptIds = staleAttempts.map((attempt) => attempt.custody_attempt_id);

  const { error: updateError } = await supabase
    .from('custody_attempt_table')
    .update({
      investigation_opened_by: automationActor.user_id,
      investigation_opened_at: timestamp,
    })
    .in('custody_attempt_id', custodyAttemptIds);

  if (updateError) {
    logger.error(
      { error: updateError, custodyAttemptIds },
      'Failed to escalate stale accepted custody attempts'
    );
    throw createHttpError('Failed to escalate stale accepted custody attempts', 500);
  }

  await persistItemCustodyStatus(
    supabase,
    staleAttempts.map((attempt) => attempt.item_id),
    'under_investigation',
    {
      custodyAttemptIds,
      action: 'escalateStaleAcceptedCustodyAttempts',
    }
  );

  await insertCustodyRecords(
    supabase,
    staleAttempts.map((attempt) => ({
      post_id: attempt.post_id,
      item_id: attempt.item_id,
      custody_attempt_id: attempt.custody_attempt_id,
      qr_code_session_id: null,
      guard_post_id: attempt.guard_post_id,
      actor_user_id: automationActor.user_id,
      record_type: 'investigation_opened',
      visible_to_poster: true,
      details: {
        attempt_status: attempt.status,
        escalation_reason: 'accepted_not_received_after_threshold',
        decision_at: attempt.decision_at,
        threshold_hours: staleAcceptedEscalationHours,
      },
      occurred_at: timestamp,
    }))
  );

  await Promise.all(
    staleAttempts.map(async (attempt) => {
      const actorLabel = await getAuditActorLabel(supabase, automationActor);
      const postTitle = await getAuditPostTitle(supabase, attempt.post_id);

      await auditLogger({
        userId: automationActor.user_id,
        actionType: 'custody_investigation_auto_opened',
        tableName: 'custody_attempt_table',
        recordId: attempt.custody_attempt_id,
        details: {
          message: `${actorLabel} auto-opened a custody investigation for ${postTitle}`,
          post_title: postTitle,
          post_id: attempt.post_id,
          item_id: attempt.item_id,
          custody_attempt_id: attempt.custody_attempt_id,
          decision_at: attempt.decision_at,
          threshold_hours: staleAcceptedEscalationHours,
        },
      });
    })
  );

  return {
    escalated_count: staleAttempts.length,
  };
}
