import { FastifyInstance } from 'fastify';
import { getSupabaseClient } from '../services/supabase.js';
import {
  canGuardAccessClaimReview,
  verifyClaimSubmission,
} from '../services/claim-verification.js';
import { requireGuardOrStaffOrAdmin, requireStaff } from '../middleware/auth.js';
import type { VerifiedClaimSubmissionContext } from '../services/claim-verification.js';
import { ProcessClaimRequest, ExistingClaimResponse } from '../types/claims.js';
import logger from '../utils/logger.js';
import { logAudit, getUserName } from '../utils/audit-logger.js';
import { createHttpError, normalizeUpstreamError } from '../utils/http-error.js';

const UMAK_EMAIL_PATTERN = /^[a-zA-Z0-9._-]+@umak\.edu\.ph$/;

function normalizePhoneNumber(input: string): string | null {
  const digits = input.replace(/[^0-9]/g, '');
  if (/^63\d{10}$/.test(digits)) return `0${digits.slice(2)}`;
  if (/^9\d{9}$/.test(digits)) return `0${digits}`;
  if (/^0\d{10}$/.test(digits)) return digits;
  return null;
}

function formatPhoneNumber(local: string): string {
  return local.length === 11 ? `${local.slice(0, 4)} ${local.slice(4, 7)} ${local.slice(7)}` : local;
}

function getClaimVerificationUpdate(
  actorUserType: string,
  finalizedVerification: VerifiedClaimSubmissionContext | null
):
  | {
      verification_method: 'manual_staff' | 'staff_qr' | 'guard_qr';
      verified_claimer_user_id?: string;
      claim_verification_session_id?: string;
      claim_qr_session_id?: string | null;
    }
  | null {
  if (finalizedVerification) {
    return {
      verified_claimer_user_id: finalizedVerification.verified_claimer.user_id,
      claim_verification_session_id: finalizedVerification.claim_verification_session_id,
      claim_qr_session_id: finalizedVerification.claim_qr_session_id,
      verification_method: finalizedVerification.verification_method,
    };
  }

  if (actorUserType === 'Guard') {
    return {
      verification_method: 'guard_qr',
    };
  }

  return null;
}

interface ClaimableFoundPostRow {
  post_id: number;
  item_id: string;
  item_name: string | null;
  poster_name: string | null;
  is_anonymous: boolean;
  item_type: string | null;
  post_status: string | null;
  item_status: string | null;
  custody_status: string | null;
}

interface LinkableMissingPostRow {
  post_id: number;
  item_id: string;
  item_type: string | null;
  post_status: string | null;
  item_status: string | null;
}

interface ExistingClaimRow {
  claim_id: string;
  item_id: string;
  claimer_name: string;
  claimer_school_email: string;
  claimer_contact_num: string;
  processed_by_staff_id: string;
  claimed_at: string | null;
  verification_method?: 'manual_staff' | 'staff_qr' | 'guard_qr' | null;
  verified_claimer_user_id?: string | null;
  claim_verification_session_id?: string | null;
}

export interface ClaimsRouteOptions {
  getSupabase?: typeof getSupabaseClient;
  getUserName?: typeof getUserName;
  logAudit?: typeof logAudit;
  verifyClaimSubmission?: typeof verifyClaimSubmission;
  canGuardAccessClaimReview?: typeof canGuardAccessClaimReview;
}

async function writeClaimProcessedAudit({
  writeAuditLog,
  staffId,
  staffName,
  existingClaim,
  normalizedClaimDetails,
  foundPost,
  found_post_id,
  effectiveMissingPostId,
  claimId,
}: {
  writeAuditLog: typeof logAudit;
  staffId: string;
  staffName: string;
  existingClaim: ExistingClaimRow | null;
  normalizedClaimDetails: {
    claimer_name: string;
    claimer_school_email: string;
    claimer_contact_num: string;
    claimed_at: string | null;
    staff_name: string;
  };
  foundPost: ClaimableFoundPostRow;
  found_post_id: number;
  effectiveMissingPostId: number | null;
  claimId: string;
}): Promise<void> {
  const itemName = foundPost.item_name || 'Unknown Item';

  if (existingClaim) {
    await writeAuditLog({
      userId: staffId,
      actionType: 'claim_overwritten',
      details: {
        message: `${staffName} overrode the existing claim for ${itemName}`,
        item_id: foundPost.item_id,
        item_name: itemName,
        found_post_id,
        missing_post_id: effectiveMissingPostId,
        old_claim: {
          claim_id: existingClaim.claim_id,
          claimer_name: existingClaim.claimer_name,
          claimer_email: existingClaim.claimer_school_email,
          claimer_contact: existingClaim.claimer_contact_num,
          claimed_at: existingClaim.claimed_at,
        },
        new_claim: {
          claimer_name: normalizedClaimDetails.claimer_name,
          claimer_email: normalizedClaimDetails.claimer_school_email,
          claimer_contact: normalizedClaimDetails.claimer_contact_num,
          claimed_at: normalizedClaimDetails.claimed_at,
          processed_by_staff: normalizedClaimDetails.staff_name,
        },
        timestamp: new Date().toISOString(),
      },
      recordId: claimId,
    });

    return;
  }

  await writeAuditLog({
    userId: staffId,
    actionType: 'claim_processed',
    details: {
      message: `${staffName} processed ${normalizedClaimDetails.claimer_name}'s claim for ${itemName}`,
      item_id: foundPost.item_id,
      item_name: itemName,
      found_post_id,
      missing_post_id: effectiveMissingPostId,
      claimer_name: normalizedClaimDetails.claimer_name,
      claimer_email: normalizedClaimDetails.claimer_school_email,
      claimer_contact: normalizedClaimDetails.claimer_contact_num,
      claimed_at: normalizedClaimDetails.claimed_at,
      processed_by_staff: normalizedClaimDetails.staff_name,
      timestamp: new Date().toISOString(),
    },
    recordId: claimId,
  });
}

export default async function claimsRoutes(server: FastifyInstance, options: ClaimsRouteOptions = {}) {
  const getSupabase = options.getSupabase ?? getSupabaseClient;
  const resolveUserName = options.getUserName ?? getUserName;
  const writeAuditLog = options.logAudit ?? logAudit;
  const verifyClaimVerification =
    options.verifyClaimSubmission ?? verifyClaimSubmission;
  const canGuardAccess = options.canGuardAccessClaimReview ?? canGuardAccessClaimReview;

  // POST /claims/process - Process a claim
  server.post<{ Body: ProcessClaimRequest }>(
    '/process',
    {
      preHandler: [requireGuardOrStaffOrAdmin],
      schema: {
        body: {
          type: 'object',
          required: ['found_post_id', 'claim_details'],
          properties: {
            found_post_id: { type: 'number' },
            missing_post_id: { type: ['number', 'null'] },
            claim_details: {
              type: 'object',
              required: [
                'claimer_name',
                'claimer_school_email',
                'claimer_contact_num',
              ],
              properties: {
                claimer_name: { type: 'string', minLength: 1 },
                claimer_school_email: { type: 'string', minLength: 1 },
                claimer_contact_num: { type: 'string', minLength: 1 },
                claimed_at: { type: ['string', 'null'] },
                poster_name: { type: 'string', minLength: 1 },
                staff_id: { type: 'string', minLength: 1 },
                staff_name: { type: 'string', minLength: 1 },
              },
            },
            claim_verification: {
              type: 'object',
              required: ['claim_verification_session_id', 'verification_method'],
              properties: {
                claim_verification_session_id: { type: 'string', minLength: 1 },
                verification_method: { type: 'string', enum: ['staff_qr', 'guard_qr'] },
              },
            },
          },
          additionalProperties: false,
        },
      },
    },
    async (request) => {
      const supabase = getSupabase();
      const { found_post_id, missing_post_id, claim_details, claim_verification } = request.body;
      const actor = request.user;
      const staffId = actor?.user_id;

      if (!actor || !staffId) {
        throw createHttpError('Unauthorized', 401);
      }

      const claimerName = claim_details.claimer_name.trim();
      const claimerEmail = claim_details.claimer_school_email.trim();
      const normalizedPhoneNumber = normalizePhoneNumber(claim_details.claimer_contact_num);
      const isGuardClaim = actor.user_type === 'Guard';
      const isQrAssistedClaim = Boolean(claim_verification);

      if (claim_verification) {
        if (isGuardClaim && claim_verification.verification_method !== 'guard_qr') {
          throw createHttpError('Guard claims must use the guard_qr verification method.', 400);
        }

        if (!isGuardClaim && claim_verification.verification_method !== 'staff_qr') {
          throw createHttpError('Only guards can use the guard_qr verification method.', 400);
        }
      }

      if (!isQrAssistedClaim && !claimerName) {
        throw createHttpError('Please select a claimer', 400);
      }

      if (!isQrAssistedClaim && !UMAK_EMAIL_PATTERN.test(claimerEmail)) {
        throw createHttpError('Please enter a valid UMak email (e.g., user@umak.edu.ph)', 400);
      }

      if (!normalizedPhoneNumber) {
        throw createHttpError(
          'Please enter a valid Philippine mobile number (examples: 09123456789, 0912 345 6789, +639123456789, +63 912-345-6789)',
          400
        );
      }

      const requestedClaimedAt = claim_details.claimed_at ?? null;
      let normalizedClaimedAt: string | null = null;
      if (requestedClaimedAt) {
        const parsedClaimedAt = new Date(requestedClaimedAt);
        if (Number.isNaN(parsedClaimedAt.getTime())) {
          throw createHttpError('Invalid claimed_at value', 400);
        }
        normalizedClaimedAt = parsedClaimedAt.toISOString();
      }

      const { data: postData, error: postError } = await supabase
        .from('post_public_view')
        .select(
          'post_id, item_id, item_name, poster_name, is_anonymous, item_type, post_status, item_status, custody_status'
        )
        .eq('post_id', found_post_id)
        .single();

      if (postError || !postData) {
        throw createHttpError('Post not found', 404);
      }

      const foundPost = postData as ClaimableFoundPostRow;

      if (foundPost.item_type !== 'found') {
        throw createHttpError('Only found items can be claimed.', 400);
      }

      if (!isGuardClaim && foundPost.post_status !== 'accepted') {
        throw createHttpError('This found post must be accepted before it can be claimed.', 400);
      }

      if (foundPost.item_status !== 'unclaimed') {
        throw createHttpError('This found post is no longer available for claim.', 400);
      }

      if (isGuardClaim) {
        const canAccess = await canGuardAccess(found_post_id, actor.user_id, { getSupabase });
        if (!canAccess || foundPost.custody_status !== 'with_guard') {
          throw createHttpError(
            'This found post cannot be claimed by the requesting guard in its current custody state.',
            400
          );
        }
      } else if (foundPost.custody_status !== 'in_security_office') {
        throw createHttpError(
          'This found post cannot be claimed until the item is received in the Security Office.',
          400
        );
      }

      if (isGuardClaim && missing_post_id !== undefined && missing_post_id !== null) {
        throw createHttpError('Guard claims cannot link a lost post.', 400);
      }

      if (!isGuardClaim && missing_post_id !== undefined && missing_post_id !== null) {
        const { data: missingPostData, error: missingPostError } = await supabase
          .from('post_public_view')
          .select('post_id, item_id, item_type, post_status, item_status')
          .eq('post_id', missing_post_id)
          .single();

        if (missingPostError || !missingPostData) {
          throw createHttpError('Referenced lost item not found. Please verify the Item ID.', 404);
        }

        const missingPost = missingPostData as LinkableMissingPostRow;

        if (missingPost.item_type !== 'missing') {
          throw createHttpError('This is a Found item post. Please enter a Missing item ID instead.', 400);
        }

        const normalizedMissingPostStatus = (missingPost.post_status ?? '').toLowerCase();
        const normalizedMissingItemStatus = (missingPost.item_status ?? '').toLowerCase();

        if (normalizedMissingItemStatus === 'discarded') {
          throw createHttpError('This item cannot be linked because it was discarded.', 400);
        }

        if (normalizedMissingItemStatus === 'returned') {
          throw createHttpError('This item has already been returned and cannot be linked.', 400);
        }

        if (
          normalizedMissingPostStatus !== 'accepted' &&
          normalizedMissingPostStatus !== 'pending'
        ) {
          throw createHttpError(
            'This post cannot be linked unless it is pending or accepted.',
            400
          );
        }
      }
      const effectiveMissingPostId = isGuardClaim ? null : (missing_post_id ?? null);

      const staffName = await resolveUserName(staffId);
      let finalizedVerification: VerifiedClaimSubmissionContext | null = null;
      let normalizedClaimerName = claimerName;
      let normalizedClaimerEmail = claimerEmail;

      if (claim_verification) {
        finalizedVerification = await verifyClaimVerification({
          actor,
          found_post_id,
          claim_verification,
        }, {
          getSupabase,
          auditLogger: writeAuditLog,
        });

        normalizedClaimerName = finalizedVerification.verified_claimer.user_name;
        normalizedClaimerEmail = finalizedVerification.verified_claimer.email;
      }

      const normalizedClaimDetails = {
        ...claim_details,
        claimer_name: normalizedClaimerName,
        claimer_school_email: normalizedClaimerEmail,
        claimer_contact_num: formatPhoneNumber(normalizedPhoneNumber),
        claimed_at: normalizedClaimedAt,
        poster_name:
          foundPost.is_anonymous
            ? 'Anonymous'
            : foundPost.poster_name || claim_details.poster_name,
        staff_id: staffId,
        staff_name: staffName,
      };

      let existingClaim: ExistingClaimRow | null = null;
      if (foundPost.item_id) {
        const { data: claimData, error: claimLookupError } = await supabase
          .from('claim_table')
          .select(
            'claim_id, item_id, claimer_name, claimer_school_email, claimer_contact_num, processed_by_staff_id, claimed_at, verification_method, verified_claimer_user_id, claim_verification_session_id'
          )
          .eq('item_id', foundPost.item_id)
          .single();

        if (claimLookupError && claimLookupError.code !== 'PGRST116') {
          logger.error({ error: claimLookupError, itemId: foundPost.item_id }, 'Failed to fetch existing claim');
          throw new Error('Failed to check existing claim');
        }

        existingClaim = claimData as ExistingClaimRow | null;
      }

      const { data, error } = await supabase.rpc('process_claim', {
        found_post_id,
        missing_post_id: effectiveMissingPostId,
        claim_details: normalizedClaimDetails,
        claim_verification: getClaimVerificationUpdate(actor.user_type, finalizedVerification),
      });

      if (error) {
        logger.error({ error }, 'Failed to process claim');
        throw normalizeUpstreamError(error, {
          statusCode: 500,
          message: 'Failed to process claim',
          code: 'CLAIM_PROCESS_FAILED',
        });
      }

      const processedClaimId = typeof data === 'string' ? data : null;

      if (!processedClaimId) {
        logger.error(
          {
            foundPostId: found_post_id,
            itemId: foundPost.item_id,
            rpcResult: data,
          },
          'process_claim returned an invalid claim id'
        );
        throw createHttpError('Failed to process claim', 500);
      }

      try {
        await writeClaimProcessedAudit({
          writeAuditLog,
          staffId,
          staffName,
          existingClaim,
          normalizedClaimDetails,
          foundPost,
          found_post_id,
          effectiveMissingPostId,
          claimId: processedClaimId,
        });
      } catch (auditError) {
        logger.error(
          {
            error: auditError,
            foundPostId: found_post_id,
            itemId: foundPost.item_id,
            claimId: processedClaimId,
          },
          'Failed to write secondary claim audit entry after successful claim processing'
        );
      }

      logger.info({ foundPostId: found_post_id }, 'Claim processed');
      return { success: true, claim_id: processedClaimId };
    }
  );

  // GET /claims/by-item/:itemId - Check if item has existing claim
  server.get<{ Params: { itemId: string } }>(
    '/by-item/:itemId',
    {
      preHandler: [requireGuardOrStaffOrAdmin],
    },
    async (request): Promise<ExistingClaimResponse> => {
      const supabase = getSupabase();
      const itemId = request.params.itemId;

      const { data: claim, error } = await supabase
        .from('claim_table')
        .select(
          'claim_id, item_id, claimer_name, claimer_school_email, claimer_contact_num, processed_by_staff_id, claimed_at, verification_method, verified_claimer_user_id, claim_verification_session_id'
        )
        .eq('item_id', itemId)
        .single();

      if (error && error.code !== 'PGRST116') {
        logger.error({ error, itemId }, 'Failed to check existing claim');
        throw new Error('Failed to check claim status');
      }

      const claimRow = claim as ExistingClaimRow | null;
      const staffName =
        claimRow?.processed_by_staff_id ? await resolveUserName(claimRow.processed_by_staff_id) : undefined;

      return {
        exists: !!claimRow,
        claim: claimRow
          ? {
              claim_id: claimRow.claim_id,
              item_id: claimRow.item_id,
              claimer_name: claimRow.claimer_name,
              claimer_email: claimRow.claimer_school_email,
              claimer_school_email: claimRow.claimer_school_email,
              claimer_contact_num: claimRow.claimer_contact_num,
              processed_by_staff_id: claimRow.processed_by_staff_id,
              claimed_at: claimRow.claimed_at,
              staff_name: staffName,
              verification_method: claimRow.verification_method ?? undefined,
            }
          : undefined,
      };
    }
  );

  // GET /claims/by-item/:itemId/full - Get full claim details by item ID
  server.get<{ Params: { itemId: string } }>(
    '/by-item/:itemId/full',
    {
      preHandler: [requireStaff],
    },
    async (request) => {
      const supabase = getSupabase();
      const itemId = request.params.itemId;

      const { data: claim, error } = await supabase
        .from('claim_table')
        .select('claim_id, linked_lost_item_id')
        .eq('item_id', itemId)
        .single();

      if (error && error.code !== 'PGRST116') {
        logger.error({ error, itemId }, 'Failed to fetch claim details');
        throw new Error('Failed to fetch claim');
      }

      return { claim: claim || null };
    }
  );

  // DELETE /claims/:id - Delete a claim record
  server.delete<{ Params: { id: string } }>(
    '/:id',
    {
      preHandler: [requireStaff],
    },
    async (request) => {
      const supabase = getSupabase();
      const claimId = request.params.id;

      const { error } = await supabase.from('claim_table').delete().eq('claim_id', claimId);

      if (error) {
        logger.error({ error, claimId }, 'Failed to delete claim');
        throw new Error('Failed to delete claim');
      }

      logger.info({ claimId }, 'Claim deleted');
      return { success: true };
    }
  );

  // DELETE /claims/by-item/:itemId - Delete claim by item ID and update linked item
  server.delete<{ Params: { itemId: string } }>(
    '/by-item/:itemId',
    {
      preHandler: [requireStaff],
    },
    async (request) => {
      const supabase = getSupabase();
      const itemId = request.params.itemId;

      // Get the claim record to find linked_lost_item_id
      const { data: claimData, error: claimFetchError } = await supabase
        .from('claim_table')
        .select('linked_lost_item_id')
        .eq('item_id', itemId)
        .single();

      if (claimFetchError && claimFetchError.code !== 'PGRST116') {
        logger.error({ error: claimFetchError, itemId }, 'Failed to fetch claim');
        throw new Error('Failed to fetch claim');
      }

      const linkedLostItemId = claimData?.linked_lost_item_id;

      // If there's a linked missing item, reset it to 'lost' status
      if (linkedLostItemId) {
        const { error: updateLinkedError } = await supabase
          .from('item_table')
          .update({
            status: 'lost',
            returned_at: null,
            returned_at_local: null,
          })
          .eq('item_id', linkedLostItemId);

        if (updateLinkedError) {
          logger.error({ error: updateLinkedError, linkedLostItemId }, 'Failed to update linked item');
          throw new Error('Failed to update linked missing item');
        }
      }

      // Delete the claim record
      const { error: deleteClaimError } = await supabase
        .from('claim_table')
        .delete()
        .eq('item_id', itemId);

      if (deleteClaimError) {
        logger.error({ error: deleteClaimError, itemId }, 'Failed to delete claim');
        throw new Error('Failed to delete claim record');
      }

      logger.info({ itemId, linkedLostItemId }, 'Claim deleted and linked item updated');
      return { success: true };
    }
  );
}
