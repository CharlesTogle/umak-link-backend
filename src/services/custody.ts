import crypto from 'node:crypto';
import { getSupabaseClient } from './supabase.js';
import { logAudit } from '../utils/audit-logger.js';
import logger from '../utils/logger.js';
import { createHttpError } from '../utils/http-error.js';
import {
  CreateCustodyAttemptRequest,
  CreateCustodyAttemptResponse,
  CustodyActor,
  CustodyDecision,
  CustodySessionStatusResponse,
  CustodyStatus,
  ExpireCustodySessionsResponse,
  GuardDecisionRequest,
  GuardDecisionResponse,
  GuardPostRecord,
  GuardScanRequest,
  GuardScanResponse,
} from '../types/custody.js';

const DEFAULT_QR_SESSION_TTL_SECONDS = parseInt(process.env.CUSTODY_QR_TTL_SECONDS || '300', 10);

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
  poster_id: string | null;
  item_type: string | null;
  post_status: string | null;
  custody_status: CustodyStatus | null;
}

interface AttemptRow {
  custody_attempt_id: string;
  post_id: number;
  item_id: string;
  poster_id: string;
  guard_post_id: string;
  handover_image_id: number;
  attempt_number: number;
  status: 'open' | 'accepted' | 'rejected' | 'timed_out' | 'cancelled';
  decision_by_guard_id: string | null;
  decision_at: string | null;
  closed_at: string | null;
}

interface SessionRow {
  qr_code_session_id: string;
  custody_attempt_id: string;
  session_token_hash: string;
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
  image_link: string | null;
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
  qrSessionTtlSeconds?: number;
  auditLogger?: AuditLogger;
}

export interface CreateCustodyAttemptInput extends CreateCustodyAttemptRequest {
  actor: CustodyActor;
}

export interface GuardScanInput extends GuardScanRequest {
  actor: CustodyActor;
}

export interface GuardDecisionInput extends GuardDecisionRequest {
  actor: CustodyActor;
  custody_attempt_id: string;
}

export interface GetCustodySessionStatusInput {
  actor: CustodyActor;
  qr_code_session_id: string;
}

function defaultHashSessionToken(sessionToken: string): string {
  return crypto.createHash('sha256').update(sessionToken).digest('hex');
}

function isNoRowsError(error: { code?: string } | null | undefined): boolean {
  return error?.code === 'PGRST116';
}

function resolveDependencies(deps?: CustodyServiceDependencies) {
  return {
    getSupabase: deps?.getSupabase ?? getSupabaseClient,
    now: deps?.now ?? (() => new Date()),
    hashSessionToken: deps?.hashSessionToken ?? defaultHashSessionToken,
    qrSessionTtlSeconds: deps?.qrSessionTtlSeconds ?? DEFAULT_QR_SESSION_TTL_SECONDS,
    auditLogger: deps?.auditLogger ?? logAudit,
  };
}

async function getAttemptById(
  supabase: SupabaseClientLike,
  custodyAttemptId: string
): Promise<AttemptRow> {
  const { data, error } = await supabase
    .from('custody_attempt_table')
    .select(
      'custody_attempt_id, post_id, item_id, poster_id, guard_post_id, handover_image_id, attempt_number, status, decision_by_guard_id, decision_at, closed_at'
    )
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
    .select(
      'qr_code_session_id, custody_attempt_id, session_token_hash, status, expires_at, scanned_by_guard_id, scanned_at, closed_at'
    )
    .eq('qr_code_session_id', qrCodeSessionId)
    .single();

  if (error || !data) {
    logger.warn({ qrCodeSessionId, error }, 'QR code session not found');
    throw createHttpError('QR code session not found', 404);
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

async function expireSessionIfNeeded(
  supabase: SupabaseClientLike,
  session: SessionRow,
  attempt: AttemptRow,
  now: Date,
  auditLogger: AuditLogger,
  auditUserId?: string
): Promise<{ session: SessionRow; attempt: AttemptRow; expired: boolean }> {
  if (session.status !== 'active' || attempt.status !== 'open') {
    return { session, attempt, expired: false };
  }

  if (new Date(session.expires_at).getTime() > now.getTime()) {
    return { session, attempt, expired: false };
  }

  const timestamp = now.toISOString();

  const { error: sessionError } = await supabase
    .from('qr_code_session_table')
    .update({
      status: 'expired',
      closed_at: timestamp,
    })
    .eq('qr_code_session_id', session.qr_code_session_id);

  if (sessionError) {
    logger.error({ error: sessionError, qrCodeSessionId: session.qr_code_session_id }, 'Failed to expire QR session');
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
    logger.error({ error: attemptError, custodyAttemptId: attempt.custody_attempt_id }, 'Failed to timeout custody attempt');
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
        qr_code_session_id: session.qr_code_session_id,
        custody_attempt_id: attempt.custody_attempt_id,
        post_id: attempt.post_id,
        item_id: attempt.item_id,
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
    expired: true,
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
  const { getSupabase, now, hashSessionToken, qrSessionTtlSeconds, auditLogger } = resolveDependencies(deps);
  const supabase = getSupabase();
  const timestamp = now().toISOString();

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

  if (postRow.post_status === 'deleted' || postRow.post_status === 'rejected' || postRow.post_status === 'fraud') {
    throw createHttpError('Post cannot start custody handover', 409);
  }

  const { data: existingOpenAttempt, error: existingOpenAttemptError } = await supabase
    .from('custody_attempt_table')
    .select('custody_attempt_id')
    .eq('post_id', input.post_id)
    .eq('status', 'open')
    .maybeSingle();

  if (existingOpenAttemptError && !isNoRowsError(existingOpenAttemptError)) {
    logger.error({ postId: input.post_id, error: existingOpenAttemptError }, 'Failed to check existing custody attempt');
    throw createHttpError('Failed to create custody attempt', 500);
  }

  if (existingOpenAttempt) {
    throw createHttpError('An open custody attempt already exists for this post', 409);
  }

  const { data: guardPost, error: guardPostError } = await supabase
    .from('guard_post_table')
    .select('guard_post_id')
    .eq('guard_post_id', input.guard_post_id)
    .eq('is_active', true)
    .single();

  if (guardPostError || !guardPost) {
    logger.warn({ guardPostId: input.guard_post_id, error: guardPostError }, 'Guard post not found for custody attempt');
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
    logger.error({ error: lastAttemptError, postId: input.post_id }, 'Failed to resolve custody attempt number');
    throw createHttpError('Failed to create custody attempt', 500);
  }

  const nextAttemptNumber = ((lastAttempts?.[0] as { attempt_number?: number } | undefined)?.attempt_number ?? 0) + 1;

  const { data: createdAttempt, error: attemptError } = await supabase
    .from('custody_attempt_table')
    .insert({
      post_id: input.post_id,
      item_id: postRow.item_id,
      poster_id: input.actor.user_id,
      guard_post_id: input.guard_post_id,
      handover_image_id: (imageRow as { item_image_id: number }).item_image_id,
      attempt_number: nextAttemptNumber,
      status: 'open',
      details: {
        initiated_via: 'backend_route',
      },
    })
    .select(
      'custody_attempt_id, post_id, item_id, poster_id, guard_post_id, handover_image_id, attempt_number, status, decision_by_guard_id, decision_at, closed_at'
    )
    .single();

  if (attemptError || !createdAttempt) {
    logger.error({ error: attemptError, postId: input.post_id }, 'Failed to create custody attempt');
    throw createHttpError('Failed to create custody attempt', 500);
  }

  const expiresAt = new Date(now().getTime() + qrSessionTtlSeconds * 1000).toISOString();
  const tokenHash = hashSessionToken(input.session_token);

  const { data: createdSession, error: sessionError } = await supabase
    .from('qr_code_session_table')
    .insert({
      custody_attempt_id: (createdAttempt as AttemptRow).custody_attempt_id,
      session_token_hash: tokenHash,
      status: 'active',
      expires_at: expiresAt,
    })
    .select(
      'qr_code_session_id, custody_attempt_id, session_token_hash, status, expires_at, scanned_by_guard_id, scanned_at, closed_at'
    )
    .single();

  if (sessionError || !createdSession) {
    logger.error({ error: sessionError, postId: input.post_id }, 'Failed to create QR code session');

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

    throw createHttpError('Failed to create QR code session', 500);
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
      qr_code_session_id: (createdSession as SessionRow).qr_code_session_id,
      guard_post_id: input.guard_post_id,
      actor_user_id: input.actor.user_id,
      record_type: 'qr_generated',
      visible_to_poster: true,
      details: {
        expires_at: expiresAt,
      },
      occurred_at: timestamp,
    },
  ]);

  await auditLogger({
    userId: input.actor.user_id,
    actionType: 'custody_attempt_created',
    tableName: 'custody_attempt_table',
    recordId: (createdAttempt as AttemptRow).custody_attempt_id,
    details: {
      post_id: input.post_id,
      item_id: postRow.item_id,
      qr_code_session_id: (createdSession as SessionRow).qr_code_session_id,
      guard_post_id: input.guard_post_id,
    },
  });

  const custodyStatus = await getItemCustodyStatus(supabase, postRow.item_id);

  return {
    custody_attempt_id: (createdAttempt as AttemptRow).custody_attempt_id,
    qr_code_session_id: (createdSession as SessionRow).qr_code_session_id,
    attempt_status: (createdAttempt as AttemptRow).status,
    qr_status: (createdSession as SessionRow).status,
    custody_status: custodyStatus,
    expires_at: expiresAt,
  };
}

export async function getCustodySessionStatus(
  input: GetCustodySessionStatusInput,
  deps?: CustodyServiceDependencies
): Promise<CustodySessionStatusResponse> {
  const { getSupabase, now, auditLogger } = resolveDependencies(deps);
  const supabase = getSupabase();

  let session = await getSessionById(supabase, input.qr_code_session_id);
  let attempt = await getAttemptById(supabase, session.custody_attempt_id);

  assertCanReadReporterSession(input.actor, attempt.poster_id);

  const expirationResult = await expireSessionIfNeeded(
    supabase,
    session,
    attempt,
    now(),
    auditLogger,
    input.actor.user_id
  );
  session = expirationResult.session;
  attempt = expirationResult.attempt;

  const custodyStatus = await getItemCustodyStatus(supabase, attempt.item_id);

  return {
    qr_code_session_id: session.qr_code_session_id,
    custody_attempt_id: attempt.custody_attempt_id,
    post_id: attempt.post_id,
    item_id: attempt.item_id,
    qr_status: session.status,
    attempt_status: attempt.status,
    custody_status: custodyStatus,
    expires_at: session.expires_at,
    scanned_at: session.scanned_at,
    decision_at: attempt.decision_at,
  };
}

export async function scanCustodySession(
  input: GuardScanInput,
  deps?: CustodyServiceDependencies
): Promise<GuardScanResponse> {
  const { getSupabase, now, hashSessionToken, auditLogger } = resolveDependencies(deps);
  const supabase = getSupabase();

  let session = await getSessionById(supabase, input.qr_code_session_id);
  let attempt = await getAttemptById(supabase, session.custody_attempt_id);

  const expirationResult = await expireSessionIfNeeded(
    supabase,
    session,
    attempt,
    now(),
    auditLogger
  );
  session = expirationResult.session;
  attempt = expirationResult.attempt;

  if (session.status !== 'active' || attempt.status !== 'open') {
    throw createHttpError('QR session is no longer active', 409);
  }

  const providedHash = hashSessionToken(input.session_token);
  if (providedHash !== session.session_token_hash) {
    throw createHttpError('Invalid QR session token', 401);
  }

  if (session.scanned_by_guard_id && session.scanned_by_guard_id !== input.actor.user_id) {
    throw createHttpError('QR session already scanned by another guard', 409);
  }

  if (!session.scanned_by_guard_id) {
    const scannedAt = now().toISOString();
    const { error: scanUpdateError } = await supabase
      .from('qr_code_session_table')
      .update({
        scanned_by_guard_id: input.actor.user_id,
        scanned_at: scannedAt,
      })
      .eq('qr_code_session_id', session.qr_code_session_id);

    if (scanUpdateError) {
      logger.error({ error: scanUpdateError, qrCodeSessionId: session.qr_code_session_id }, 'Failed to mark QR session as scanned');
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

    await auditLogger({
      userId: input.actor.user_id,
      actionType: 'custody_qr_scanned',
      tableName: 'qr_code_session_table',
      recordId: session.qr_code_session_id,
      details: {
        custody_attempt_id: attempt.custody_attempt_id,
        post_id: attempt.post_id,
        item_id: attempt.item_id,
      },
    });

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
    logger.error({ error: handoverImageError, handoverImageId: attempt.handover_image_id }, 'Failed to fetch handover image');
    throw createHttpError('Failed to fetch handover details', 500);
  }

  const { data: guardPost, error: guardPostError } = await supabase
    .from('guard_post_table')
    .select('guard_post_name')
    .eq('guard_post_id', attempt.guard_post_id)
    .single();

  if (guardPostError || !guardPost) {
    logger.error({ error: guardPostError, guardPostId: attempt.guard_post_id }, 'Failed to fetch guard post details');
    throw createHttpError('Failed to fetch guard handover details', 500);
  }

  const { data: postDetails, error: postDetailsError } = await supabase
    .from('post_public_view')
    .select('post_id, item_id, item_name, item_description, item_image_url, category, last_seen_at, last_seen_location, submission_date')
    .eq('post_id', attempt.post_id)
    .single();

  if (postDetailsError || !postDetails) {
    logger.error({ error: postDetailsError, postId: attempt.post_id }, 'Failed to fetch guard-visible post details');
    throw createHttpError('Failed to fetch post details', 500);
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
  const { getSupabase, now, auditLogger } = resolveDependencies(deps);
  const supabase = getSupabase();
  const decisionAt = now().toISOString();

  let attempt = await getAttemptById(supabase, input.custody_attempt_id);
  let session = await getSessionById(supabase, input.qr_code_session_id);

  if (session.custody_attempt_id !== attempt.custody_attempt_id) {
    throw createHttpError('QR session does not belong to this custody attempt', 400);
  }

  const expirationResult = await expireSessionIfNeeded(
    supabase,
    session,
    attempt,
    now(),
    auditLogger
  );
  session = expirationResult.session;
  attempt = expirationResult.attempt;

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
    logger.error({ error: attemptUpdateError, custodyAttemptId: attempt.custody_attempt_id }, 'Failed to update custody attempt decision');
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
    logger.error({ error: sessionUpdateError, qrCodeSessionId: session.qr_code_session_id }, 'Failed to update QR session decision');
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

  await auditLogger({
    userId: input.actor.user_id,
    actionType: 'custody_attempt_decided',
    tableName: 'custody_attempt_table',
    recordId: attempt.custody_attempt_id,
    details: {
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
  const { getSupabase, now, auditLogger } = resolveDependencies(deps);
  const supabase = getSupabase();
  const currentTime = now();

  const { data: activeSessions, error } = await supabase
    .from('qr_code_session_table')
    .select(
      'qr_code_session_id, custody_attempt_id, session_token_hash, status, expires_at, scanned_by_guard_id, scanned_at, closed_at'
    )
    .eq('status', 'active')
    .lte('expires_at', currentTime.toISOString());

  if (error) {
    logger.error({ error }, 'Failed to fetch expired custody sessions');
    throw createHttpError('Failed to expire custody sessions', 500);
  }

  let expiredCount = 0;
  for (const row of (activeSessions ?? []) as SessionRow[]) {
    const attempt = await getAttemptById(supabase, row.custody_attempt_id);
    const result = await expireSessionIfNeeded(
      supabase,
      row,
      attempt,
      currentTime,
      auditLogger
    );

    if (result.expired) {
      expiredCount += 1;
    }
  }

  return {
    expired_count: expiredCount,
  };
}
