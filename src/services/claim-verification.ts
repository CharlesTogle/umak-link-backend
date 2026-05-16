import crypto from 'node:crypto';
import { getSupabaseClient } from './supabase.js';
import logger from '../utils/logger.js';
import { createHttpError } from '../utils/http-error.js';
import { logAudit } from '../utils/audit-logger.js';
import type {
  CancelClaimVerificationSessionResponse,
  ClaimQrSessionStatus,
  ClaimVerificationRouteActor,
  ClaimVerificationSessionStatus,
  ClaimVerificationSessionStatusResponse,
  ClaimVerificationSubmission,
  ClaimVerificationSubmissionMethod,
  ClaimVerificationMethod,
  ClaimVerifiedClaimerSummary,
  CreateClaimVerificationSessionRequest,
  CreateClaimVerificationSessionResponse,
  GuardActiveClaimReviewRecord,
  GuardActiveClaimReviewsResponse,
  JoinClaimVerificationSessionRequest,
  JoinClaimVerificationSessionResponse,
  RetryClaimVerificationSessionRequest,
  RetryClaimVerificationSessionResponse,
  ScanClaimVerificationRequest,
  ScanClaimVerificationResponse,
} from '../types/claim-verification.js';

function parsePositiveIntEnv(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const DEFAULT_CLAIM_QR_TTL_SECONDS = parsePositiveIntEnv(process.env.CLAIM_QR_TTL_SECONDS, 300);
const DEFAULT_CLAIM_QR_MAX_ATTEMPTS = parsePositiveIntEnv(process.env.CLAIM_QR_MAX_ATTEMPTS, 5);
const DEFAULT_CLAIM_SESSION_LIMIT_PER_HOUR = parsePositiveIntEnv(
  process.env.CLAIM_SESSION_LIMIT_PER_HOUR,
  2
);
const CLAIM_SESSION_LIMIT_WINDOW_MS = 60 * 60 * 1000;

type SupabaseClientLike = ReturnType<typeof getSupabaseClient>;
type AuditLogger = typeof logAudit;

interface ClaimablePostRow {
  post_id: number;
  item_id: string;
  item_name: string | null;
  item_description: string | null;
  item_image_url: string | null;
  category: string | null;
  last_seen_at: string | null;
  last_seen_location: string | null;
  poster_name: string | null;
  poster_profile_picture_url: string | null;
  submission_date: string | null;
  is_anonymous?: boolean;
  item_type: string | null;
  post_status: string | null;
  item_status: string | null;
  custody_status: string | null;
}

interface AcceptedCustodyAttemptRow {
  custody_attempt_id: string;
  post_id: number;
  item_id: string;
  attempt_number: number;
  status: string;
  decision_by_guard_id: string | null;
  office_received_at: string | null;
}

interface ClaimVerificationSessionRow {
  claim_verification_session_id: string;
  post_id: number;
  item_id: string;
  processor_user_id: string;
  processor_user_type: string;
  claimer_user_id: string | null;
  join_code: string;
  status: ClaimVerificationSessionStatus;
  number_of_attempts: number;
  expires_at: string;
  scanned_at: string | null;
  completed_at: string | null;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
  details: Record<string, unknown> | null;
}

interface ClaimQrSessionRow {
  claim_qr_session_id: string;
  claim_verification_session_id: string;
  session_token_hash: string;
  status: ClaimQrSessionStatus;
  expires_at: string;
  scanned_by_processor_id: string | null;
  scanned_at: string | null;
  closed_at: string | null;
  created_at: string;
}

interface ClaimVerifiedUserRow {
  user_id: string;
  user_name: string | null;
  email: string | null;
  profile_picture_url: string | null;
}

interface ClaimVerificationRecordInsert {
  claim_verification_session_id: string;
  claim_qr_session_id: string | null;
  post_id: number;
  item_id: string;
  actor_user_id: string | null;
  record_type: string;
  details: Record<string, unknown>;
  occurred_at: string;
}

export interface ClaimVerificationServiceDependencies {
  getSupabase?: () => SupabaseClientLike;
  now?: () => Date;
  hashSessionToken?: (sessionToken: string) => string;
  generateJoinCode?: () => string;
  qrSessionTtlSeconds?: number;
  maxSessionAttempts?: number;
  maxSessionLoopsPerHour?: number;
  auditLogger?: AuditLogger;
}

export interface CreateClaimVerificationSessionInput extends CreateClaimVerificationSessionRequest {
  actor: ClaimVerificationRouteActor;
}

export interface JoinClaimVerificationSessionInput extends JoinClaimVerificationSessionRequest {
  actor: ClaimVerificationRouteActor;
}

export interface GetClaimVerificationSessionStatusInput {
  actor: ClaimVerificationRouteActor;
  claim_verification_session_id: string;
}

export interface RetryClaimVerificationSessionInput extends RetryClaimVerificationSessionRequest {
  actor: ClaimVerificationRouteActor;
  claim_verification_session_id: string;
}

export interface CancelClaimVerificationSessionInput {
  actor: ClaimVerificationRouteActor;
  claim_verification_session_id: string;
}

export interface ScanClaimVerificationSessionInput extends ScanClaimVerificationRequest {
  actor: ClaimVerificationRouteActor;
}

export interface VerifyClaimSubmissionInput {
  actor: ClaimVerificationRouteActor;
  found_post_id: number;
  claim_verification: ClaimVerificationSubmission;
}

export interface CompleteClaimVerificationSessionInput {
  actor: ClaimVerificationRouteActor;
  claim_verification_session_id: string;
  claim_qr_session_id: string | null;
  found_post_id: number;
  claim_id: string | null;
  verification_method: ClaimVerificationMethod;
  occurred_at?: string;
}

export interface ListGuardActiveClaimReviewsInput {
  actor: ClaimVerificationRouteActor;
}

export interface VerifiedClaimSubmissionContext {
  claim_verification_session_id: string;
  claim_qr_session_id: string | null;
  verification_method: ClaimVerificationSubmissionMethod;
  verified_claimer: ClaimVerifiedClaimerSummary;
}

function defaultHashSessionToken(sessionToken: string): string {
  return crypto.createHash('sha256').update(sessionToken).digest('hex');
}

function defaultGenerateJoinCode(): string {
  return crypto.randomBytes(4).toString('hex').toUpperCase();
}

function isNoRowsError(error: { code?: string } | null | undefined): boolean {
  return error?.code === 'PGRST116';
}

function resolveDependencies(deps?: ClaimVerificationServiceDependencies) {
  return {
    getSupabase: deps?.getSupabase ?? getSupabaseClient,
    now: deps?.now ?? (() => new Date()),
    hashSessionToken: deps?.hashSessionToken ?? defaultHashSessionToken,
    generateJoinCode: deps?.generateJoinCode ?? defaultGenerateJoinCode,
    qrSessionTtlSeconds: deps?.qrSessionTtlSeconds ?? DEFAULT_CLAIM_QR_TTL_SECONDS,
    maxSessionAttempts: deps?.maxSessionAttempts ?? DEFAULT_CLAIM_QR_MAX_ATTEMPTS,
    maxSessionLoopsPerHour: deps?.maxSessionLoopsPerHour ?? DEFAULT_CLAIM_SESSION_LIMIT_PER_HOUR,
    auditLogger: deps?.auditLogger ?? logAudit,
  };
}

function shouldWriteAdminAudit(actor: Pick<ClaimVerificationRouteActor, 'user_type'>): boolean {
  return actor.user_type !== 'User';
}

function formatAuditPostTitle(itemName: string | null | undefined, postId: number): string {
  const normalizedItemName = itemName?.trim();
  return normalizedItemName && normalizedItemName.length > 0
    ? normalizedItemName
    : `Post ${postId}`;
}

function getAuditActorRoleLabel(userType: ClaimVerificationRouteActor['user_type']): string {
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

function getProcessorUserTypeLabel(userType: string | null | undefined): string {
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

function getVerificationMethodLabel(method: string): string {
  switch (method) {
    case 'manual_staff':
      return 'Manual Staff';
    case 'staff_qr':
      return 'Staff QR';
    case 'guard_qr':
      return 'Guard QR';
    default:
      return method
        .split('_')
        .map((segment: string) => segment.charAt(0).toUpperCase() + segment.slice(1))
        .join(' ');
  }
}

async function getAuditActorName(
  supabase: SupabaseClientLike,
  actor: Pick<ClaimVerificationRouteActor, 'user_id' | 'user_type'>
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
        'Failed to resolve audit actor name for claim verification log'
      );
      return fallbackName;
    }

    const userName = (data as ClaimVerifiedUserRow).user_name?.trim();
    return userName && userName.length > 0 ? userName : fallbackName;
  } catch (error) {
    logger.warn(
      { actorUserId: actor.user_id, error },
      'Exception resolving audit actor name for claim verification log'
    );
    return fallbackName;
  }
}

async function getAuditActorLabel(
  supabase: SupabaseClientLike,
  actor: Pick<ClaimVerificationRouteActor, 'user_id' | 'user_type'>
): Promise<string> {
  const actorName = await getAuditActorName(supabase, actor);
  return `${getAuditActorRoleLabel(actor.user_type)} ${actorName}`;
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
      logger.warn({ postId, error }, 'Failed to resolve claim verification audit post title');
      return formatAuditPostTitle(null, postId);
    }

    return formatAuditPostTitle((data as { item_name?: string | null }).item_name ?? null, postId);
  } catch (error) {
    logger.warn({ postId, error }, 'Exception resolving claim verification audit post title');
    return formatAuditPostTitle(null, postId);
  }
}

function getRetriesRemaining(numberOfAttempts: number, maxSessionAttempts: number): number {
  return Math.max(maxSessionAttempts - numberOfAttempts, 0);
}

function buildRetryMetadata(
  session: Pick<ClaimVerificationSessionRow, 'number_of_attempts'>,
  maxSessionAttempts: number
) {
  return {
    number_of_attempts: session.number_of_attempts,
    max_number_of_attempts: maxSessionAttempts,
    retries_remaining: getRetriesRemaining(session.number_of_attempts, maxSessionAttempts),
  };
}

function isUnderlyingSessionActive(status: ClaimVerificationSessionStatus): boolean {
  return status === 'awaiting_claimer' || status === 'qr_active' || status === 'scanned';
}

function hasExpired(expiresAt: string, currentTime: Date): boolean {
  return new Date(expiresAt).getTime() <= currentTime.getTime();
}

function deriveQrStatus(
  qrSession: ClaimQrSessionRow | null,
  currentWindowExpired: boolean
): ClaimQrSessionStatus | null {
  if (!qrSession) return null;
  if (qrSession.status === 'active' && currentWindowExpired) {
    return 'expired';
  }
  return qrSession.status;
}

function deriveSessionStatus(
  session: ClaimVerificationSessionRow,
  qrSession: ClaimQrSessionRow | null,
  currentWindowExpired: boolean
): ClaimVerificationSessionStatus {
  if (!currentWindowExpired) return session.status;
  if (
    session.status === 'completed' ||
    session.status === 'cancelled' ||
    session.status === 'expired'
  ) {
    return session.status;
  }
  if (session.status === 'scanned' || qrSession?.status === 'scanned') {
    return 'expired';
  }
  return 'expired';
}

function canRetrySession(
  session: ClaimVerificationSessionRow,
  qrSession: ClaimQrSessionRow | null,
  currentWindowExpired: boolean,
  maxSessionAttempts: number
): boolean {
  if (!currentWindowExpired) return false;
  if (!session.claimer_user_id) return false;
  if (!qrSession || qrSession.status !== 'active') return false;
  return session.number_of_attempts < maxSessionAttempts;
}

async function getClaimablePost(
  supabase: SupabaseClientLike,
  postId: number,
  columns = 'post_id, item_id, item_name, item_description, item_image_url, category, last_seen_at, last_seen_location, poster_name, poster_profile_picture_url, submission_date:submitted_on_date_local, is_anonymous, item_type, post_status, item_status, custody_status'
): Promise<ClaimablePostRow> {
  const { data, error } = await supabase
    .from('v_post_records_details')
    .select(columns)
    .eq('post_id', postId)
    .single();

  if (error || !data) {
    logger.warn({ postId, error }, 'Claim verification post not found');
    throw createHttpError('Post not found', 404);
  }

  return data as unknown as ClaimablePostRow;
}

async function getLatestAcceptedCustodyAttempt(
  supabase: SupabaseClientLike,
  postId: number
): Promise<AcceptedCustodyAttemptRow> {
  const { data, error } = await supabase
    .from('custody_attempt_table')
    .select(
      'custody_attempt_id, post_id, item_id, attempt_number, status, decision_by_guard_id, office_received_at'
    )
    .eq('post_id', postId)
    .eq('status', 'accepted')
    .order('attempt_number', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error && !isNoRowsError(error)) {
    logger.error(
      { postId, error },
      'Failed to fetch accepted custody attempt for claim verification'
    );
    throw createHttpError('Failed to validate guard assignment', 500);
  }

  if (!data) {
    throw createHttpError('No accepted custody attempt found for this post', 409);
  }

  return data as AcceptedCustodyAttemptRow;
}

async function assertGuardOwnsActiveReview(
  supabase: SupabaseClientLike,
  post: ClaimablePostRow,
  guardUserId: string
): Promise<void> {
  if (post.custody_status !== 'with_guard') {
    throw createHttpError(
      'This found post cannot be claimed by a guard from its current custody state.',
      409
    );
  }

  const acceptedAttempt = await getLatestAcceptedCustodyAttempt(supabase, post.post_id);

  if (acceptedAttempt.decision_by_guard_id !== guardUserId) {
    throw createHttpError('This active review does not belong to the requesting guard.', 403);
  }

  if (acceptedAttempt.office_received_at) {
    throw createHttpError(
      'This found post cannot be claimed by a guard after office receipt.',
      409
    );
  }
}

async function getSessionById(
  supabase: SupabaseClientLike,
  claimVerificationSessionId: string
): Promise<ClaimVerificationSessionRow> {
  const { data, error } = await supabase
    .from('claim_verification_session_table')
    .select(
      'claim_verification_session_id, post_id, item_id, processor_user_id, processor_user_type, claimer_user_id, join_code, status, number_of_attempts, expires_at, scanned_at, completed_at, closed_at, created_at, updated_at, details'
    )
    .eq('claim_verification_session_id', claimVerificationSessionId)
    .single();

  if (error || !data) {
    logger.warn({ claimVerificationSessionId, error }, 'Claim verification session not found');
    throw createHttpError('Claim verification session not found', 404);
  }

  return data as ClaimVerificationSessionRow;
}

async function getSessionByJoinCode(
  supabase: SupabaseClientLike,
  joinCode: string
): Promise<ClaimVerificationSessionRow> {
  const { data, error } = await supabase
    .from('claim_verification_session_table')
    .select(
      'claim_verification_session_id, post_id, item_id, processor_user_id, processor_user_type, claimer_user_id, join_code, status, number_of_attempts, expires_at, scanned_at, completed_at, closed_at, created_at, updated_at, details'
    )
    .eq('join_code', joinCode)
    .single();

  if (error || !data) {
    logger.warn({ joinCode, error }, 'Claim verification session join code not found');
    throw createHttpError('Claim verification session not found', 404);
  }

  return data as ClaimVerificationSessionRow;
}

async function getActiveSessionForPost(
  supabase: SupabaseClientLike,
  postId: number
): Promise<ClaimVerificationSessionRow | null> {
  const { data, error } = await supabase
    .from('claim_verification_session_table')
    .select(
      'claim_verification_session_id, post_id, item_id, processor_user_id, processor_user_type, claimer_user_id, join_code, status, number_of_attempts, expires_at, scanned_at, completed_at, closed_at, created_at, updated_at, details'
    )
    .eq('post_id', postId)
    .in('status', ['awaiting_claimer', 'qr_active', 'scanned'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error && !isNoRowsError(error)) {
    logger.error({ postId, error }, 'Failed to resolve active claim verification session');
    throw createHttpError('Failed to create claim verification session', 500);
  }

  return (data as ClaimVerificationSessionRow | null) ?? null;
}

async function getQrSessionByVerificationSessionId(
  supabase: SupabaseClientLike,
  claimVerificationSessionId: string
): Promise<ClaimQrSessionRow | null> {
  const { data, error } = await supabase
    .from('claim_qr_session_table')
    .select(
      'claim_qr_session_id, claim_verification_session_id, session_token_hash, status, expires_at, scanned_by_processor_id, scanned_at, closed_at, created_at'
    )
    .eq('claim_verification_session_id', claimVerificationSessionId)
    .maybeSingle();

  if (error && !isNoRowsError(error)) {
    logger.error({ claimVerificationSessionId, error }, 'Failed to fetch claim QR session');
    throw createHttpError('Failed to load claim verification session', 500);
  }

  return (data as ClaimQrSessionRow | null) ?? null;
}

async function getQrSessionById(
  supabase: SupabaseClientLike,
  claimQrSessionId: string
): Promise<ClaimQrSessionRow> {
  const { data, error } = await supabase
    .from('claim_qr_session_table')
    .select(
      'claim_qr_session_id, claim_verification_session_id, session_token_hash, status, expires_at, scanned_by_processor_id, scanned_at, closed_at, created_at'
    )
    .eq('claim_qr_session_id', claimQrSessionId)
    .single();

  if (error || !data) {
    logger.warn({ claimQrSessionId, error }, 'Claim QR session not found');
    throw createHttpError('Claim QR session not found', 404);
  }

  return data as ClaimQrSessionRow;
}

async function getVerifiedClaimerSummary(
  supabase: SupabaseClientLike,
  userId: string
): Promise<ClaimVerifiedClaimerSummary> {
  const { data, error } = await supabase
    .from('user_table')
    .select('user_id, user_name, email, profile_picture_url')
    .eq('user_id', userId)
    .single();

  if (error || !data) {
    logger.error({ userId, error }, 'Failed to fetch verified claimer summary');
    throw createHttpError('Failed to resolve verified claimer', 500);
  }

  const user = data as ClaimVerifiedUserRow;
  if (!user.user_name || !user.email) {
    throw createHttpError('Verified claimer profile is incomplete', 409);
  }

  return {
    user_id: user.user_id,
    user_name: user.user_name,
    email: user.email,
    profile_picture_url: user.profile_picture_url ?? null,
  };
}

async function insertClaimVerificationRecords(
  supabase: SupabaseClientLike,
  records: ClaimVerificationRecordInsert[]
): Promise<void> {
  if (records.length === 0) return;

  const { error } = await supabase.from('claim_verification_record_table').insert(
    records.map((record) => ({
      ...record,
      details: record.details,
    }))
  );

  if (error) {
    logger.error(
      { error, recordCount: records.length },
      'Failed to insert claim verification history'
    );
    throw createHttpError('Failed to save claim verification history', 500);
  }
}

async function finalizeExpiredSession(
  supabase: SupabaseClientLike,
  session: ClaimVerificationSessionRow,
  qrSession: ClaimQrSessionRow | null,
  currentTime: Date,
  auditLogger: AuditLogger,
  auditUserId?: string
): Promise<{
  session: ClaimVerificationSessionRow;
  qrSession: ClaimQrSessionRow | null;
}> {
  const timestamp = currentTime.toISOString();
  const postTitle = await getAuditPostTitle(supabase, session.post_id);

  const { error: sessionError } = await supabase
    .from('claim_verification_session_table')
    .update({
      status: 'expired',
      closed_at: timestamp,
      updated_at: timestamp,
    })
    .eq('claim_verification_session_id', session.claim_verification_session_id);

  if (sessionError) {
    logger.error(
      { error: sessionError, claimVerificationSessionId: session.claim_verification_session_id },
      'Failed to expire claim verification session'
    );
    throw createHttpError('Failed to expire claim verification session', 500);
  }

  if (qrSession && qrSession.status !== 'expired' && qrSession.status !== 'cancelled') {
    const { error: qrError } = await supabase
      .from('claim_qr_session_table')
      .update({
        status: 'expired',
        closed_at: timestamp,
      })
      .eq('claim_qr_session_id', qrSession.claim_qr_session_id);

    if (qrError) {
      logger.error(
        { error: qrError, claimQrSessionId: qrSession.claim_qr_session_id },
        'Failed to expire claim QR session'
      );
      throw createHttpError('Failed to expire claim verification session', 500);
    }
  }

  await insertClaimVerificationRecords(supabase, [
    {
      claim_verification_session_id: session.claim_verification_session_id,
      claim_qr_session_id: qrSession?.claim_qr_session_id ?? null,
      post_id: session.post_id,
      item_id: session.item_id,
      actor_user_id: auditUserId ?? null,
      record_type: 'session_expired',
      details: {
        number_of_attempts: session.number_of_attempts,
        status_before_expiry: session.status,
      },
      occurred_at: timestamp,
    },
  ]);

  if (auditUserId) {
    await auditLogger({
      userId: auditUserId,
      actionType: 'claim_verification_session_expired',
      tableName: 'claim_verification_session_table',
      recordId: session.claim_verification_session_id,
      details: {
        message: `Claim verification session expired for ${postTitle}`,
        post_title: postTitle,
        claim_verification_session_id: session.claim_verification_session_id,
        claim_qr_session_id: qrSession?.claim_qr_session_id ?? null,
        post_id: session.post_id,
        item_id: session.item_id,
      },
    });
  }

  return {
    session: {
      ...session,
      status: 'expired',
      closed_at: timestamp,
      updated_at: timestamp,
    },
    qrSession: qrSession
      ? {
          ...qrSession,
          status: 'expired',
          closed_at: timestamp,
        }
      : null,
  };
}

async function resolveSessionExpiration(
  supabase: SupabaseClientLike,
  session: ClaimVerificationSessionRow,
  qrSession: ClaimQrSessionRow | null,
  currentTime: Date,
  maxSessionAttempts: number,
  auditLogger: AuditLogger,
  auditUserId?: string
): Promise<{
  session: ClaimVerificationSessionRow;
  qrSession: ClaimQrSessionRow | null;
  currentWindowExpired: boolean;
  finalizedExpiration: boolean;
}> {
  const currentWindowExpired =
    isUnderlyingSessionActive(session.status) && hasExpired(session.expires_at, currentTime);

  if (!currentWindowExpired) {
    return {
      session,
      qrSession,
      currentWindowExpired: false,
      finalizedExpiration: false,
    };
  }

  const retryable = canRetrySession(session, qrSession, currentWindowExpired, maxSessionAttempts);

  if (retryable) {
    return {
      session,
      qrSession,
      currentWindowExpired: true,
      finalizedExpiration: false,
    };
  }

  const finalized = await finalizeExpiredSession(
    supabase,
    session,
    qrSession,
    currentTime,
    auditLogger,
    auditUserId
  );

  return {
    ...finalized,
    currentWindowExpired: true,
    finalizedExpiration: true,
  };
}

function buildStatusResponse(
  session: ClaimVerificationSessionRow,
  qrSession: ClaimQrSessionRow | null,
  verifiedClaimer: ClaimVerifiedClaimerSummary | null,
  currentTime: Date,
  maxSessionAttempts: number
): ClaimVerificationSessionStatusResponse {
  const currentWindowExpired =
    isUnderlyingSessionActive(session.status) && hasExpired(session.expires_at, currentTime);

  return {
    claim_verification_session_id: session.claim_verification_session_id,
    found_post_id: session.post_id,
    item_id: session.item_id,
    join_code: session.join_code,
    status: deriveSessionStatus(session, qrSession, currentWindowExpired),
    qr_status: deriveQrStatus(qrSession, currentWindowExpired),
    expires_at: session.expires_at,
    scanned_at: qrSession?.scanned_at ?? session.scanned_at,
    completed_at: session.completed_at,
    closed_at: session.closed_at,
    current_window_expired: currentWindowExpired,
    can_retry: canRetrySession(session, qrSession, currentWindowExpired, maxSessionAttempts),
    verified_claimer: verifiedClaimer,
    ...buildRetryMetadata(session, maxSessionAttempts),
  };
}

function assertCanAccessSession(
  actor: ClaimVerificationRouteActor,
  session: ClaimVerificationSessionRow
): void {
  const isProcessor = session.processor_user_id === actor.user_id;
  const isClaimer = session.claimer_user_id === actor.user_id;

  if (!isProcessor && !isClaimer) {
    throw createHttpError('Forbidden', 403);
  }
}

function assertCanCreateVerificationSession(actor: ClaimVerificationRouteActor): void {
  if (!['Staff', 'Admin', 'Guard'].includes(actor.user_type)) {
    throw createHttpError('Forbidden', 403);
  }
}

function assertCanScanVerificationSession(actor: ClaimVerificationRouteActor): void {
  if (!['Staff', 'Admin', 'Guard'].includes(actor.user_type)) {
    throw createHttpError('Forbidden', 403);
  }
}

async function buildJoinResponse(
  supabase: SupabaseClientLike,
  session: ClaimVerificationSessionRow,
  qrSession: ClaimQrSessionRow,
  maxSessionAttempts: number
): Promise<JoinClaimVerificationSessionResponse> {
  const post = await getClaimablePost(
    supabase,
    session.post_id,
    'post_id, item_id, item_name, item_image_url, item_description, item_type, post_status, item_status, custody_status'
  );

  return {
    claim_verification_session_id: session.claim_verification_session_id,
    claim_qr_session_id: qrSession.claim_qr_session_id,
    join_code: session.join_code,
    status: session.status,
    qr_status: qrSession.status,
    expires_at: session.expires_at,
    found_post: {
      post_id: post.post_id,
      item_id: post.item_id,
      item_name: post.item_name,
      item_image_url: post.item_image_url,
      item_description: post.item_description,
    },
    ...buildRetryMetadata(session, maxSessionAttempts),
  };
}

export async function createClaimVerificationSession(
  input: CreateClaimVerificationSessionInput,
  deps?: ClaimVerificationServiceDependencies
): Promise<CreateClaimVerificationSessionResponse> {
  const {
    getSupabase,
    now,
    generateJoinCode,
    qrSessionTtlSeconds,
    maxSessionAttempts,
    maxSessionLoopsPerHour,
    auditLogger,
  } = resolveDependencies(deps);
  const supabase = getSupabase();
  const currentTime = now();
  const timestamp = currentTime.toISOString();

  assertCanCreateVerificationSession(input.actor);

  const post = await getClaimablePost(supabase, input.found_post_id);

  if (post.item_type !== 'found') {
    throw createHttpError('Only found items can be claimed.', 400);
  }

  if (input.actor.user_type !== 'Guard' && post.post_status !== 'accepted') {
    throw createHttpError('This found post must be accepted before it can be claimed.', 400);
  }

  if (post.item_status !== 'unclaimed') {
    throw createHttpError('This found post is no longer available for claim.', 400);
  }

  if (input.actor.user_type === 'Guard') {
    await assertGuardOwnsActiveReview(supabase, post, input.actor.user_id);
  } else if (post.custody_status !== 'in_security_office') {
    throw createHttpError(
      'This found post cannot be claimed until the item is received in the Security Office.',
      400
    );
  }

  const existingSession = await getActiveSessionForPost(supabase, input.found_post_id);
  if (existingSession) {
    if (existingSession.processor_user_id !== input.actor.user_id) {
      throw createHttpError(
        'Another active claim verification session already exists for this post.',
        409
      );
    }

    const existingQrSession = await getQrSessionByVerificationSessionId(
      supabase,
      existingSession.claim_verification_session_id
    );
    const expirationResult = await resolveSessionExpiration(
      supabase,
      existingSession,
      existingQrSession,
      currentTime,
      maxSessionAttempts,
      auditLogger,
      shouldWriteAdminAudit(input.actor) ? input.actor.user_id : undefined
    );
    const verifiedClaimer = expirationResult.session.claimer_user_id
      ? await getVerifiedClaimerSummary(supabase, expirationResult.session.claimer_user_id)
      : null;

    return buildStatusResponse(
      expirationResult.session,
      expirationResult.qrSession,
      verifiedClaimer,
      currentTime,
      maxSessionAttempts
    );
  }

  const sessionLimitWindowStart = new Date(
    currentTime.getTime() - CLAIM_SESSION_LIMIT_WINDOW_MS
  ).toISOString();
  const { count: recentSessionLoopCount, error: recentSessionLoopCountError } = await supabase
    .from('claim_verification_session_table')
    .select('claim_verification_session_id', { count: 'exact', head: true })
    .eq('post_id', input.found_post_id)
    .eq('processor_user_id', input.actor.user_id)
    .gte('created_at', sessionLimitWindowStart);

  if (recentSessionLoopCountError) {
    logger.error(
      {
        postId: input.found_post_id,
        actorUserId: input.actor.user_id,
        error: recentSessionLoopCountError,
      },
      'Failed to enforce claim verification session loop limit'
    );
    throw createHttpError('Failed to create claim verification session', 500);
  }

  if ((recentSessionLoopCount ?? 0) >= maxSessionLoopsPerHour) {
    throw createHttpError(
      'Too many claim verification sessions were started for this post. Try again later.',
      429
    );
  }

  const expiresAt = new Date(currentTime.getTime() + qrSessionTtlSeconds * 1000).toISOString();

  const { data: createdSession, error: sessionError } = await supabase
    .from('claim_verification_session_table')
    .insert({
      post_id: post.post_id,
      item_id: post.item_id,
      processor_user_id: input.actor.user_id,
      processor_user_type: input.actor.user_type,
      join_code: generateJoinCode(),
      status: 'awaiting_claimer',
      number_of_attempts: 1,
      expires_at: expiresAt,
      details: {
        initiated_via: 'backend_route',
      },
    })
    .select(
      'claim_verification_session_id, post_id, item_id, processor_user_id, processor_user_type, claimer_user_id, join_code, status, number_of_attempts, expires_at, scanned_at, completed_at, closed_at, created_at, updated_at, details'
    )
    .single();

  if (sessionError || !createdSession) {
    logger.error(
      { error: sessionError, postId: input.found_post_id },
      'Failed to create claim verification session'
    );
    throw createHttpError('Failed to create claim verification session', 500);
  }

  const session = createdSession as ClaimVerificationSessionRow;

  await insertClaimVerificationRecords(supabase, [
    {
      claim_verification_session_id: session.claim_verification_session_id,
      claim_qr_session_id: null,
      post_id: session.post_id,
      item_id: session.item_id,
      actor_user_id: input.actor.user_id,
      record_type: 'session_started',
      details: {
        processor_user_type: input.actor.user_type,
        expires_at: session.expires_at,
      },
      occurred_at: timestamp,
    },
  ]);

  const actorLabel = await getAuditActorLabel(supabase, input.actor);
  const postTitle = await getAuditPostTitle(supabase, session.post_id, post.item_name);

  await auditLogger({
    userId: input.actor.user_id,
    actionType: 'claim_verification_session_started',
    tableName: 'claim_verification_session_table',
    recordId: session.claim_verification_session_id,
    details: {
      message: `${actorLabel} started claim verification for ${postTitle} as ${getProcessorUserTypeLabel(input.actor.user_type)}`,
      post_title: postTitle,
      claim_verification_session_id: session.claim_verification_session_id,
      post_id: session.post_id,
      item_id: session.item_id,
      expires_at: session.expires_at,
      processor_user_type: input.actor.user_type,
    },
  });

  return buildStatusResponse(session, null, null, currentTime, maxSessionAttempts);
}

export async function joinClaimVerificationSession(
  input: JoinClaimVerificationSessionInput,
  deps?: ClaimVerificationServiceDependencies
): Promise<JoinClaimVerificationSessionResponse> {
  const { getSupabase, now, hashSessionToken, maxSessionAttempts, auditLogger } =
    resolveDependencies(deps);
  const supabase = getSupabase();
  const currentTime = now();
  const timestamp = currentTime.toISOString();

  let session = await getSessionByJoinCode(supabase, input.join_code.trim().toUpperCase());
  let qrSession = await getQrSessionByVerificationSessionId(
    supabase,
    session.claim_verification_session_id
  );

  const expirationResult = await resolveSessionExpiration(
    supabase,
    session,
    qrSession,
    currentTime,
    maxSessionAttempts,
    auditLogger,
    shouldWriteAdminAudit(input.actor) ? input.actor.user_id : undefined
  );
  session = expirationResult.session;
  qrSession = expirationResult.qrSession;

  if (
    session.status === 'cancelled' ||
    session.status === 'completed' ||
    session.status === 'expired'
  ) {
    throw createHttpError('Claim verification session is no longer active.', 409);
  }

  if (expirationResult.currentWindowExpired) {
    throw createHttpError(
      'Claim verification session expired. Ask the processor to restart the claim session.',
      409
    );
  }

  if (session.claimer_user_id && session.claimer_user_id !== input.actor.user_id) {
    throw createHttpError('Another claimer already joined this claim verification session.', 409);
  }

  const nextTokenHash = hashSessionToken(input.session_token);
  const joiningForTheFirstTime = !session.claimer_user_id;

  if (joiningForTheFirstTime) {
    const { error: sessionUpdateError } = await supabase
      .from('claim_verification_session_table')
      .update({
        claimer_user_id: input.actor.user_id,
        status: 'qr_active',
        updated_at: timestamp,
      })
      .eq('claim_verification_session_id', session.claim_verification_session_id);

    if (sessionUpdateError) {
      logger.error(
        {
          error: sessionUpdateError,
          claimVerificationSessionId: session.claim_verification_session_id,
        },
        'Failed to attach claimer to claim verification session'
      );
      throw createHttpError('Failed to join claim verification session', 500);
    }

    session = {
      ...session,
      claimer_user_id: input.actor.user_id,
      status: 'qr_active',
      updated_at: timestamp,
    };
  }

  if (!qrSession) {
    const { data: createdQrSession, error: qrInsertError } = await supabase
      .from('claim_qr_session_table')
      .insert({
        claim_verification_session_id: session.claim_verification_session_id,
        session_token_hash: nextTokenHash,
        status: 'active',
        expires_at: session.expires_at,
      })
      .select(
        'claim_qr_session_id, claim_verification_session_id, session_token_hash, status, expires_at, scanned_by_processor_id, scanned_at, closed_at, created_at'
      )
      .single();

    if (qrInsertError || !createdQrSession) {
      logger.error(
        {
          error: qrInsertError,
          claimVerificationSessionId: session.claim_verification_session_id,
        },
        'Failed to create claim QR session'
      );
      throw createHttpError('Failed to join claim verification session', 500);
    }

    qrSession = createdQrSession as ClaimQrSessionRow;
  } else if (qrSession.status === 'active') {
    const { error: qrUpdateError } = await supabase
      .from('claim_qr_session_table')
      .update({
        session_token_hash: nextTokenHash,
        expires_at: session.expires_at,
        scanned_by_processor_id: null,
        scanned_at: null,
        closed_at: null,
      })
      .eq('claim_qr_session_id', qrSession.claim_qr_session_id);

    if (qrUpdateError) {
      logger.error(
        { error: qrUpdateError, claimQrSessionId: qrSession.claim_qr_session_id },
        'Failed to refresh active claim QR session'
      );
      throw createHttpError('Failed to join claim verification session', 500);
    }

    qrSession = {
      ...qrSession,
      session_token_hash: nextTokenHash,
      expires_at: session.expires_at,
      scanned_by_processor_id: null,
      scanned_at: null,
      closed_at: null,
    };
  } else {
    throw createHttpError('Claim verification QR is no longer joinable.', 409);
  }

  await insertClaimVerificationRecords(
    supabase,
    [
      joiningForTheFirstTime
        ? {
            claim_verification_session_id: session.claim_verification_session_id,
            claim_qr_session_id: qrSession.claim_qr_session_id,
            post_id: session.post_id,
            item_id: session.item_id,
            actor_user_id: input.actor.user_id,
            record_type: 'claimer_joined',
            details: {},
            occurred_at: timestamp,
          }
        : null,
      {
        claim_verification_session_id: session.claim_verification_session_id,
        claim_qr_session_id: qrSession.claim_qr_session_id,
        post_id: session.post_id,
        item_id: session.item_id,
        actor_user_id: input.actor.user_id,
        record_type: 'qr_generated',
        details: {
          expires_at: session.expires_at,
          number_of_attempts: session.number_of_attempts,
        },
        occurred_at: timestamp,
      },
    ].filter(Boolean) as ClaimVerificationRecordInsert[]
  );

  return buildJoinResponse(supabase, session, qrSession, maxSessionAttempts);
}

export async function getClaimVerificationSessionStatus(
  input: GetClaimVerificationSessionStatusInput,
  deps?: ClaimVerificationServiceDependencies
): Promise<ClaimVerificationSessionStatusResponse> {
  const { getSupabase, now, maxSessionAttempts, auditLogger } = resolveDependencies(deps);
  const supabase = getSupabase();
  const currentTime = now();

  let session = await getSessionById(supabase, input.claim_verification_session_id);
  let qrSession = await getQrSessionByVerificationSessionId(
    supabase,
    session.claim_verification_session_id
  );

  assertCanAccessSession(input.actor, session);

  const expirationResult = await resolveSessionExpiration(
    supabase,
    session,
    qrSession,
    currentTime,
    maxSessionAttempts,
    auditLogger,
    shouldWriteAdminAudit(input.actor) ? input.actor.user_id : undefined
  );
  session = expirationResult.session;
  qrSession = expirationResult.qrSession;

  const verifiedClaimer = session.claimer_user_id
    ? await getVerifiedClaimerSummary(supabase, session.claimer_user_id)
    : null;

  return buildStatusResponse(session, qrSession, verifiedClaimer, currentTime, maxSessionAttempts);
}

export async function retryClaimVerificationSession(
  input: RetryClaimVerificationSessionInput,
  deps?: ClaimVerificationServiceDependencies
): Promise<RetryClaimVerificationSessionResponse> {
  const {
    getSupabase,
    now,
    hashSessionToken,
    qrSessionTtlSeconds,
    maxSessionAttempts,
    auditLogger,
  } = resolveDependencies(deps);
  const supabase = getSupabase();
  const currentTime = now();
  const timestamp = currentTime.toISOString();

  let session = await getSessionById(supabase, input.claim_verification_session_id);
  let qrSession = await getQrSessionByVerificationSessionId(
    supabase,
    session.claim_verification_session_id
  );

  if (session.claimer_user_id !== input.actor.user_id) {
    throw createHttpError(
      'Only the joined claimer can retry this claim verification session.',
      403
    );
  }

  const expirationResult = await resolveSessionExpiration(
    supabase,
    session,
    qrSession,
    currentTime,
    maxSessionAttempts,
    auditLogger,
    shouldWriteAdminAudit(input.actor) ? input.actor.user_id : undefined
  );
  session = expirationResult.session;
  qrSession = expirationResult.qrSession;

  if (!expirationResult.currentWindowExpired) {
    throw createHttpError('Claim verification QR is still active.', 409);
  }

  if (expirationResult.finalizedExpiration || !qrSession) {
    throw createHttpError('Claim verification session is no longer retryable.', 409);
  }

  if (qrSession.status !== 'active') {
    throw createHttpError('Claim verification session is no longer retryable.', 409);
  }

  const nextNumberOfAttempts = session.number_of_attempts + 1;
  if (nextNumberOfAttempts > maxSessionAttempts) {
    throw createHttpError('Claim verification session is no longer retryable.', 409);
  }

  const nextExpiresAt = new Date(currentTime.getTime() + qrSessionTtlSeconds * 1000).toISOString();
  const nextTokenHash = hashSessionToken(input.session_token);

  const { error: sessionUpdateError } = await supabase
    .from('claim_verification_session_table')
    .update({
      status: 'qr_active',
      number_of_attempts: nextNumberOfAttempts,
      expires_at: nextExpiresAt,
      scanned_at: null,
      closed_at: null,
      updated_at: timestamp,
    })
    .eq('claim_verification_session_id', session.claim_verification_session_id);

  if (sessionUpdateError) {
    logger.error(
      {
        error: sessionUpdateError,
        claimVerificationSessionId: session.claim_verification_session_id,
      },
      'Failed to update claim verification session for retry'
    );
    throw createHttpError('Failed to retry claim verification session', 500);
  }

  const { error: qrUpdateError } = await supabase
    .from('claim_qr_session_table')
    .update({
      session_token_hash: nextTokenHash,
      status: 'active',
      expires_at: nextExpiresAt,
      scanned_by_processor_id: null,
      scanned_at: null,
      closed_at: null,
    })
    .eq('claim_qr_session_id', qrSession.claim_qr_session_id);

  if (qrUpdateError) {
    logger.error(
      { error: qrUpdateError, claimQrSessionId: qrSession.claim_qr_session_id },
      'Failed to rotate claim QR session'
    );
    throw createHttpError('Failed to retry claim verification session', 500);
  }

  session = {
    ...session,
    status: 'qr_active',
    number_of_attempts: nextNumberOfAttempts,
    expires_at: nextExpiresAt,
    scanned_at: null,
    closed_at: null,
    updated_at: timestamp,
  };
  qrSession = {
    ...qrSession,
    session_token_hash: nextTokenHash,
    status: 'active',
    expires_at: nextExpiresAt,
    scanned_by_processor_id: null,
    scanned_at: null,
    closed_at: null,
  };

  await insertClaimVerificationRecords(supabase, [
    {
      claim_verification_session_id: session.claim_verification_session_id,
      claim_qr_session_id: qrSession.claim_qr_session_id,
      post_id: session.post_id,
      item_id: session.item_id,
      actor_user_id: input.actor.user_id,
      record_type: 'qr_generated',
      details: {
        expires_at: nextExpiresAt,
        number_of_attempts: nextNumberOfAttempts,
        retried: true,
      },
      occurred_at: timestamp,
    },
  ]);

  return {
    claim_verification_session_id: session.claim_verification_session_id,
    claim_qr_session_id: qrSession.claim_qr_session_id,
    join_code: session.join_code,
    status: session.status,
    qr_status: qrSession.status,
    expires_at: session.expires_at,
    ...buildRetryMetadata(session, maxSessionAttempts),
  };
}

export async function cancelClaimVerificationSession(
  input: CancelClaimVerificationSessionInput,
  deps?: ClaimVerificationServiceDependencies
): Promise<CancelClaimVerificationSessionResponse> {
  const { getSupabase, now, maxSessionAttempts, auditLogger } = resolveDependencies(deps);
  const supabase = getSupabase();
  const currentTime = now();
  const cancelledAt = currentTime.toISOString();

  let session = await getSessionById(supabase, input.claim_verification_session_id);
  let qrSession = await getQrSessionByVerificationSessionId(
    supabase,
    session.claim_verification_session_id
  );

  assertCanAccessSession(input.actor, session);

  const expirationResult = await resolveSessionExpiration(
    supabase,
    session,
    qrSession,
    currentTime,
    maxSessionAttempts,
    auditLogger,
    shouldWriteAdminAudit(input.actor) ? input.actor.user_id : undefined
  );
  session = expirationResult.session;
  qrSession = expirationResult.qrSession;

  if (session.status === 'cancelled') {
    return {
      claim_verification_session_id: session.claim_verification_session_id,
      claim_qr_session_id: qrSession?.claim_qr_session_id ?? null,
      status: 'cancelled',
      qr_status: qrSession?.status ?? null,
      cancelled_at: session.closed_at ?? cancelledAt,
      ...buildRetryMetadata(session, maxSessionAttempts),
    };
  }

  if (session.status === 'completed' || session.status === 'expired') {
    throw createHttpError('Claim verification session is no longer cancellable.', 409);
  }

  const { error: sessionUpdateError } = await supabase
    .from('claim_verification_session_table')
    .update({
      status: 'cancelled',
      closed_at: cancelledAt,
      updated_at: cancelledAt,
    })
    .eq('claim_verification_session_id', session.claim_verification_session_id);

  if (sessionUpdateError) {
    logger.error(
      {
        error: sessionUpdateError,
        claimVerificationSessionId: session.claim_verification_session_id,
      },
      'Failed to cancel claim verification session'
    );
    throw createHttpError('Failed to cancel claim verification session', 500);
  }

  if (qrSession && qrSession.status !== 'cancelled' && qrSession.status !== 'expired') {
    const { error: qrUpdateError } = await supabase
      .from('claim_qr_session_table')
      .update({
        status: 'cancelled',
        closed_at: cancelledAt,
      })
      .eq('claim_qr_session_id', qrSession.claim_qr_session_id);

    if (qrUpdateError) {
      logger.error(
        { error: qrUpdateError, claimQrSessionId: qrSession.claim_qr_session_id },
        'Failed to cancel claim QR session'
      );
      throw createHttpError('Failed to cancel claim verification session', 500);
    }

    qrSession = {
      ...qrSession,
      status: 'cancelled',
      closed_at: cancelledAt,
    };
  }

  session = {
    ...session,
    status: 'cancelled',
    closed_at: cancelledAt,
    updated_at: cancelledAt,
  };

  await insertClaimVerificationRecords(supabase, [
    {
      claim_verification_session_id: session.claim_verification_session_id,
      claim_qr_session_id: qrSession?.claim_qr_session_id ?? null,
      post_id: session.post_id,
      item_id: session.item_id,
      actor_user_id: input.actor.user_id,
      record_type: 'session_cancelled',
      details: {
        cancelled_by: input.actor.user_id,
        cancelled_by_role: input.actor.user_type,
      },
      occurred_at: cancelledAt,
    },
  ]);

  if (shouldWriteAdminAudit(input.actor)) {
    const actorLabel = await getAuditActorLabel(supabase, input.actor);
    const postTitle = await getAuditPostTitle(supabase, session.post_id);

    await auditLogger({
      userId: input.actor.user_id,
      actionType: 'claim_verification_session_cancelled',
      tableName: 'claim_verification_session_table',
      recordId: session.claim_verification_session_id,
      details: {
        message: `${actorLabel} cancelled claim verification for ${postTitle}`,
        post_title: postTitle,
        claim_verification_session_id: session.claim_verification_session_id,
        claim_qr_session_id: qrSession?.claim_qr_session_id ?? null,
        post_id: session.post_id,
        item_id: session.item_id,
      },
    });
  }

  return {
    claim_verification_session_id: session.claim_verification_session_id,
    claim_qr_session_id: qrSession?.claim_qr_session_id ?? null,
    status: session.status,
    qr_status: qrSession?.status ?? null,
    cancelled_at: cancelledAt,
    ...buildRetryMetadata(session, maxSessionAttempts),
  };
}

export async function scanClaimVerificationSession(
  input: ScanClaimVerificationSessionInput,
  deps?: ClaimVerificationServiceDependencies
): Promise<ScanClaimVerificationResponse> {
  const { getSupabase, now, hashSessionToken, maxSessionAttempts, auditLogger } =
    resolveDependencies(deps);
  const supabase = getSupabase();
  const currentTime = now();

  assertCanScanVerificationSession(input.actor);

  let qrSession = await getQrSessionById(supabase, input.claim_qr_session_id);
  let session = await getSessionById(supabase, qrSession.claim_verification_session_id);

  if (session.processor_user_id !== input.actor.user_id) {
    throw createHttpError('Only the processor who created this session can scan its QR.', 403);
  }

  const expirationResult = await resolveSessionExpiration(
    supabase,
    session,
    qrSession,
    currentTime,
    maxSessionAttempts,
    auditLogger,
    shouldWriteAdminAudit(input.actor) ? input.actor.user_id : undefined
  );
  session = expirationResult.session;
  qrSession = expirationResult.qrSession ?? qrSession;

  if (expirationResult.currentWindowExpired && !expirationResult.finalizedExpiration) {
    throw createHttpError(
      'Claim verification QR expired. The claimer must generate a new QR.',
      409
    );
  }

  if (
    session.status === 'completed' ||
    session.status === 'cancelled' ||
    session.status === 'expired'
  ) {
    throw createHttpError('Claim verification session is no longer active.', 409);
  }

  if (qrSession.status === 'scanned') {
    if (qrSession.scanned_by_processor_id !== input.actor.user_id) {
      throw createHttpError('Claim verification QR was already scanned by another processor.', 409);
    }

    if (!session.claimer_user_id) {
      throw createHttpError('Claim verification session has no bound claimer.', 409);
    }

    return {
      claim_verification_session_id: session.claim_verification_session_id,
      claim_qr_session_id: qrSession.claim_qr_session_id,
      status: 'scanned',
      qr_status: 'scanned',
      scanned_at: qrSession.scanned_at ?? session.scanned_at ?? currentTime.toISOString(),
      verified_claimer: await getVerifiedClaimerSummary(supabase, session.claimer_user_id),
    };
  }

  if (qrSession.status !== 'active') {
    throw createHttpError('Claim verification QR is no longer active.', 409);
  }

  const providedHash = hashSessionToken(input.session_token);
  if (providedHash !== qrSession.session_token_hash) {
    throw createHttpError('Invalid claim verification QR token.', 401);
  }

  if (!session.claimer_user_id) {
    throw createHttpError('No claimer joined this claim verification session.', 409);
  }

  const scannedAt = currentTime.toISOString();

  const { error: qrUpdateError } = await supabase
    .from('claim_qr_session_table')
    .update({
      status: 'scanned',
      scanned_by_processor_id: input.actor.user_id,
      scanned_at: scannedAt,
    })
    .eq('claim_qr_session_id', qrSession.claim_qr_session_id);

  if (qrUpdateError) {
    logger.error(
      { error: qrUpdateError, claimQrSessionId: qrSession.claim_qr_session_id },
      'Failed to mark claim QR session as scanned'
    );
    throw createHttpError('Failed to scan claim verification QR', 500);
  }

  const { error: sessionUpdateError } = await supabase
    .from('claim_verification_session_table')
    .update({
      status: 'scanned',
      scanned_at: scannedAt,
      updated_at: scannedAt,
    })
    .eq('claim_verification_session_id', session.claim_verification_session_id);

  if (sessionUpdateError) {
    logger.error(
      {
        error: sessionUpdateError,
        claimVerificationSessionId: session.claim_verification_session_id,
      },
      'Failed to update claim verification session scan state'
    );
    throw createHttpError('Failed to scan claim verification QR', 500);
  }

  session = {
    ...session,
    status: 'scanned',
    scanned_at: scannedAt,
    updated_at: scannedAt,
  };
  qrSession = {
    ...qrSession,
    status: 'scanned',
    scanned_by_processor_id: input.actor.user_id,
    scanned_at: scannedAt,
  };

  await insertClaimVerificationRecords(supabase, [
    {
      claim_verification_session_id: session.claim_verification_session_id,
      claim_qr_session_id: qrSession.claim_qr_session_id,
      post_id: session.post_id,
      item_id: session.item_id,
      actor_user_id: input.actor.user_id,
      record_type: 'qr_scanned',
      details: {
        scanned_by_processor_id: input.actor.user_id,
      },
      occurred_at: scannedAt,
    },
  ]);

  const actorLabel = await getAuditActorLabel(supabase, input.actor);
  const postTitle = await getAuditPostTitle(supabase, session.post_id);

  await auditLogger({
    userId: input.actor.user_id,
    actionType: 'claim_verification_qr_scanned',
    tableName: 'claim_qr_session_table',
    recordId: qrSession.claim_qr_session_id,
    details: {
      message: `${actorLabel} scanned the claim verification QR for ${postTitle}`,
      post_title: postTitle,
      claim_verification_session_id: session.claim_verification_session_id,
      claim_qr_session_id: qrSession.claim_qr_session_id,
      post_id: session.post_id,
      item_id: session.item_id,
    },
  });

  return {
    claim_verification_session_id: session.claim_verification_session_id,
    claim_qr_session_id: qrSession.claim_qr_session_id,
    status: session.status,
    qr_status: qrSession.status,
    scanned_at: scannedAt,
    verified_claimer: await getVerifiedClaimerSummary(supabase, session.claimer_user_id as string),
  };
}

export async function verifyClaimSubmission(
  input: VerifyClaimSubmissionInput,
  deps?: ClaimVerificationServiceDependencies
): Promise<VerifiedClaimSubmissionContext> {
  const { getSupabase, now, maxSessionAttempts, auditLogger } = resolveDependencies(deps);
  const supabase = getSupabase();
  const currentTime = now();

  const session = await getSessionById(
    supabase,
    input.claim_verification.claim_verification_session_id
  );
  const qrSession = await getQrSessionByVerificationSessionId(
    supabase,
    session.claim_verification_session_id
  );

  const expirationResult = await resolveSessionExpiration(
    supabase,
    session,
    qrSession,
    currentTime,
    maxSessionAttempts,
    auditLogger,
    shouldWriteAdminAudit(input.actor) ? input.actor.user_id : undefined
  );
  const resolvedSession = expirationResult.session;
  const resolvedQrSession = expirationResult.qrSession;

  if (resolvedSession.post_id !== input.found_post_id) {
    throw createHttpError('Claim verification session does not belong to this found post.', 400);
  }

  if (resolvedSession.processor_user_id !== input.actor.user_id) {
    throw createHttpError('Claim verification session belongs to another processor.', 403);
  }

  const method = input.claim_verification.verification_method;
  if (input.actor.user_type === 'Guard' && method !== 'guard_qr') {
    throw createHttpError('Guard claims must use guard_qr verification.', 400);
  }

  if (input.actor.user_type !== 'Guard' && method !== 'staff_qr') {
    throw createHttpError('Staff QR-assisted claims must use staff_qr verification.', 400);
  }

  if (expirationResult.currentWindowExpired) {
    throw createHttpError('Claim verification session expired.', 409);
  }

  if (!resolvedQrSession) {
    throw createHttpError('Claim verification QR was never generated.', 409);
  }

  if (resolvedSession.status !== 'scanned' || resolvedQrSession.status !== 'scanned') {
    throw createHttpError('Claim verification QR must be scanned before claim submission.', 409);
  }

  if (resolvedQrSession.scanned_by_processor_id !== input.actor.user_id) {
    throw createHttpError('Only the processor who scanned the QR can submit this claim.', 403);
  }

  if (!resolvedSession.claimer_user_id) {
    throw createHttpError('Claim verification session has no verified claimer.', 409);
  }

  return {
    claim_verification_session_id: resolvedSession.claim_verification_session_id,
    claim_qr_session_id: resolvedQrSession.claim_qr_session_id,
    verification_method: method,
    verified_claimer: await getVerifiedClaimerSummary(supabase, resolvedSession.claimer_user_id),
  };
}

export async function completeClaimVerificationSession(
  input: CompleteClaimVerificationSessionInput,
  deps?: ClaimVerificationServiceDependencies
): Promise<void> {
  const { getSupabase, now, auditLogger } = resolveDependencies(deps);
  const supabase = getSupabase();
  const timestamp = input.occurred_at ?? now().toISOString();

  const session = await getSessionById(supabase, input.claim_verification_session_id);
  const qrSession = input.claim_qr_session_id
    ? await getQrSessionById(supabase, input.claim_qr_session_id)
    : await getQrSessionByVerificationSessionId(supabase, input.claim_verification_session_id);

  if (session.post_id !== input.found_post_id) {
    throw createHttpError('Claim verification session does not belong to this found post.', 400);
  }

  if (session.processor_user_id !== input.actor.user_id) {
    throw createHttpError('Claim verification session belongs to another processor.', 403);
  }

  const { error: sessionUpdateError } = await supabase
    .from('claim_verification_session_table')
    .update({
      status: 'completed',
      completed_at: timestamp,
      closed_at: timestamp,
      updated_at: timestamp,
    })
    .eq('claim_verification_session_id', session.claim_verification_session_id);

  if (sessionUpdateError) {
    logger.error(
      {
        error: sessionUpdateError,
        claimVerificationSessionId: session.claim_verification_session_id,
      },
      'Failed to complete claim verification session'
    );
    throw createHttpError('Failed to complete claim verification session', 500);
  }

  if (qrSession && !qrSession.closed_at) {
    const { error: qrUpdateError } = await supabase
      .from('claim_qr_session_table')
      .update({
        closed_at: timestamp,
      })
      .eq('claim_qr_session_id', qrSession.claim_qr_session_id);

    if (qrUpdateError) {
      logger.error(
        { error: qrUpdateError, claimQrSessionId: qrSession.claim_qr_session_id },
        'Failed to close claim QR session after completion'
      );
      throw createHttpError('Failed to complete claim verification session', 500);
    }
  }

  await insertClaimVerificationRecords(supabase, [
    {
      claim_verification_session_id: session.claim_verification_session_id,
      claim_qr_session_id: qrSession?.claim_qr_session_id ?? null,
      post_id: session.post_id,
      item_id: session.item_id,
      actor_user_id: input.actor.user_id,
      record_type: 'claim_completed',
      details: {
        claim_id: input.claim_id,
        verification_method: input.verification_method,
      },
      occurred_at: timestamp,
    },
  ]);

  const actorLabel = await getAuditActorLabel(supabase, input.actor);
  const postTitle = await getAuditPostTitle(supabase, session.post_id);

  await auditLogger({
    userId: input.actor.user_id,
    actionType: 'claim_verification_session_completed',
    tableName: 'claim_verification_session_table',
    recordId: session.claim_verification_session_id,
    details: {
      message: `${actorLabel} completed claim verification for ${postTitle} via ${getVerificationMethodLabel(input.verification_method)}`,
      post_title: postTitle,
      claim_verification_session_id: session.claim_verification_session_id,
      claim_qr_session_id: qrSession?.claim_qr_session_id ?? null,
      post_id: session.post_id,
      item_id: session.item_id,
      claim_id: input.claim_id,
      verification_method: input.verification_method,
    },
  });
}

export async function canGuardAccessClaimReview(
  postId: number,
  guardUserId: string,
  deps?: ClaimVerificationServiceDependencies
): Promise<boolean> {
  const { getSupabase } = resolveDependencies(deps);
  const supabase = getSupabase();

  try {
    const post = await getClaimablePost(
      supabase,
      postId,
      'post_id, item_id, item_type, post_status, item_status, custody_status'
    );

    if (
      post.item_type !== 'found' ||
      post.item_status !== 'unclaimed' ||
      post.custody_status !== 'with_guard'
    ) {
      return false;
    }

    await assertGuardOwnsActiveReview(supabase, post, guardUserId);
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      'statusCode' in error &&
      typeof (error as { statusCode?: unknown }).statusCode === 'number' &&
      [403, 404, 409].includes((error as { statusCode: number }).statusCode)
    ) {
      return false;
    }

    throw error;
  }
}

export async function listGuardActiveClaimReviews(
  input: ListGuardActiveClaimReviewsInput,
  deps?: ClaimVerificationServiceDependencies
): Promise<GuardActiveClaimReviewsResponse> {
  const { getSupabase } = resolveDependencies(deps);
  const supabase = getSupabase();

  if (input.actor.user_type !== 'Guard') {
    throw createHttpError('Guard access required', 403);
  }

  const { data: attempts, error: attemptError } = await supabase
    .from('custody_attempt_table')
    .select(
      'custody_attempt_id, post_id, item_id, attempt_number, status, decision_by_guard_id, office_received_at'
    )
    .eq('status', 'accepted')
    .eq('decision_by_guard_id', input.actor.user_id)
    .is('office_received_at', null)
    .order('attempt_number', { ascending: false });

  if (attemptError) {
    logger.error(
      { error: attemptError, guardUserId: input.actor.user_id },
      'Failed to fetch active guard claim reviews'
    );
    throw createHttpError('Failed to fetch active guard reviews', 500);
  }

  const latestAcceptedAttempts = new Map<number, AcceptedCustodyAttemptRow>();
  for (const rawAttempt of (attempts ?? []) as AcceptedCustodyAttemptRow[]) {
    if (!latestAcceptedAttempts.has(rawAttempt.post_id)) {
      latestAcceptedAttempts.set(rawAttempt.post_id, rawAttempt);
    }
  }

  const postIds = Array.from(latestAcceptedAttempts.keys());
  if (postIds.length === 0) {
    return { posts: [] };
  }

  const { data: posts, error: postsError } = await supabase
    .from('v_post_records_details')
    .select(
      'post_id, item_id, item_name, item_description, item_image_url, category, last_seen_at, last_seen_location, poster_name, poster_profile_picture_url, submitted_on_date_local, custody_status, post_status, item_status'
    )
    .in('post_id', postIds)
    .eq('item_type', 'found')
    .eq('item_status', 'unclaimed')
    .eq('custody_status', 'with_guard')
    .order('submitted_on_date_local', { ascending: false });

  if (postsError) {
    logger.error(
      { error: postsError, guardUserId: input.actor.user_id },
      'Failed to fetch guard-active claim review posts'
    );
    throw createHttpError('Failed to fetch active guard reviews', 500);
  }

  return {
    posts: ((posts ?? []) as GuardActiveClaimReviewRecord[]).filter((post) =>
      latestAcceptedAttempts.has(post.post_id)
    ),
  };
}

export async function listActiveGuardClaimReviews(
  actor: ClaimVerificationRouteActor,
  deps?: ClaimVerificationServiceDependencies
): Promise<GuardActiveClaimReviewRecord[]> {
  const response = await listGuardActiveClaimReviews({ actor }, deps);
  return response.posts;
}
