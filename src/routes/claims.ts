import { FastifyInstance } from 'fastify';
import { getSupabaseClient } from '../services/supabase.js';
import { updateClaimedCustodyStatus } from '../services/custody.js';
import { requireStaff } from '../middleware/auth.js';
import { ProcessClaimRequest, ExistingClaimResponse } from '../types/claims.js';
import logger from '../utils/logger.js';
import { logAudit, getUserName } from '../utils/audit-logger.js';

const UMAK_EMAIL_PATTERN = /^[a-zA-Z0-9._-]+@umak\.edu\.ph$/;

function createHttpError(message: string, statusCode: number): Error & { statusCode: number } {
  const error = new Error(message) as Error & { statusCode: number };
  error.statusCode = statusCode;
  return error;
}

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
}

export interface ClaimsRouteOptions {
  getSupabase?: typeof getSupabaseClient;
  getUserName?: typeof getUserName;
  logAudit?: typeof logAudit;
}

export default async function claimsRoutes(server: FastifyInstance, options: ClaimsRouteOptions = {}) {
  const getSupabase = options.getSupabase ?? getSupabaseClient;
  const resolveUserName = options.getUserName ?? getUserName;
  const writeAuditLog = options.logAudit ?? logAudit;

  // POST /claims/process - Process a claim
  server.post<{ Body: ProcessClaimRequest }>(
    '/process',
    {
      preHandler: [requireStaff],
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
          },
          additionalProperties: false,
        },
      },
    },
    async (request) => {
      const supabase = getSupabase();
      const { found_post_id, missing_post_id, claim_details } = request.body;
      const actor = request.user;
      const staffId = actor?.user_id;

      if (!actor || !staffId) {
        throw createHttpError('Unauthorized', 401);
      }

      const claimerName = claim_details.claimer_name.trim();
      const claimerEmail = claim_details.claimer_school_email.trim();
      const normalizedPhoneNumber = normalizePhoneNumber(claim_details.claimer_contact_num);

      if (!claimerName) {
        throw createHttpError('Please select a claimer', 400);
      }

      if (!UMAK_EMAIL_PATTERN.test(claimerEmail)) {
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

      if (foundPost.post_status !== 'accepted') {
        throw createHttpError('This found post must be accepted before it can be claimed.', 400);
      }

      if (foundPost.item_status !== 'unclaimed') {
        throw createHttpError('This found post is no longer available for claim.', 400);
      }

      if (foundPost.custody_status !== 'in_security_office') {
        throw createHttpError(
          'This found post cannot be claimed until the item is received in the Security Office.',
          400
        );
      }

      let linkedLostItemId: string | null = null;

      if (missing_post_id !== undefined && missing_post_id !== null) {
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

        if (missingPost.post_status !== 'accepted') {
          throw createHttpError('This post is not accepted yet. Only accepted posts can be claimed.', 400);
        }

        if (missingPost.item_status === 'returned') {
          throw createHttpError('This item has already been returned and cannot be linked.', 400);
        }

        linkedLostItemId = missingPost.item_id;
      }

      const staffName = await resolveUserName(staffId);
      const normalizedClaimDetails = {
        ...claim_details,
        claimer_name: claimerName,
        claimer_school_email: claimerEmail,
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
            'claim_id, item_id, claimer_name, claimer_school_email, claimer_contact_num, processed_by_staff_id, claimed_at'
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
        missing_post_id,
        claim_details: normalizedClaimDetails,
      });

      if (error) {
        logger.error({ error }, 'Failed to process claim');
        throw new Error(error.message || 'Failed to process claim');
      }

      if (foundPost.item_id && (normalizedClaimedAt || linkedLostItemId)) {
        const { error: updateClaimError } = await supabase
          .from('claim_table')
          .update({
            ...(normalizedClaimedAt ? { claimed_at: normalizedClaimedAt } : {}),
            ...(linkedLostItemId ? { linked_lost_item_id: linkedLostItemId } : {}),
          })
          .eq('item_id', foundPost.item_id);

        if (updateClaimError) {
          logger.error(
            { error: updateClaimError, itemId: foundPost.item_id },
            'Failed to update claim details after processing claim'
          );
          throw new Error(updateClaimError.message || 'Failed to update claim details');
        }
      }

      let processedClaimId: string | null = null;
      if (foundPost.item_id) {
        const { data: processedClaim } = await supabase
          .from('claim_table')
          .select('claim_id')
          .eq('item_id', foundPost.item_id)
          .single();

        processedClaimId = processedClaim?.claim_id ?? null;
      }

      await updateClaimedCustodyStatus({
        actor,
        post_id: found_post_id,
        custody_status: 'claimed_by_student',
        occurred_at: normalizedClaimedAt ?? new Date().toISOString(),
        details: {
          claim_id: processedClaimId,
          claimer_name: normalizedClaimDetails.claimer_name,
          claimer_school_email: normalizedClaimDetails.claimer_school_email,
          claimer_contact_num: normalizedClaimDetails.claimer_contact_num,
        },
      }, {
        getSupabase,
        auditLogger: writeAuditLog,
      });

      // Log to audit trail
      const itemName = foundPost.item_name || 'Unknown Item';

      if (existingClaim) {
        await writeAuditLog({
          userId: staffId,
          actionType: 'claim_overwritten',
          details: {
            message: `${staffName} overwritten claim for ${itemName}`,
            item_id: foundPost.item_id,
            item_name: itemName,
            found_post_id,
            missing_post_id,
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
          recordId: processedClaimId || found_post_id.toString(),
        });
      } else {
        await writeAuditLog({
          userId: staffId,
          actionType: 'claim_processed',
          details: {
            message: `${staffName} processed claim for ${itemName}`,
            item_id: foundPost.item_id,
            item_name: itemName,
            found_post_id,
            missing_post_id,
            claimer_name: normalizedClaimDetails.claimer_name,
            claimer_email: normalizedClaimDetails.claimer_school_email,
            claimer_contact: normalizedClaimDetails.claimer_contact_num,
            claimed_at: normalizedClaimDetails.claimed_at,
            processed_by_staff: normalizedClaimDetails.staff_name,
            timestamp: new Date().toISOString(),
          },
          recordId: processedClaimId || found_post_id.toString(),
        });
      }

      logger.info({ foundPostId: found_post_id }, 'Claim processed');
      return { success: true, claim_id: processedClaimId ?? (data as string | null) ?? null };
    }
  );

  // GET /claims/by-item/:itemId - Check if item has existing claim
  server.get<{ Params: { itemId: string } }>(
    '/by-item/:itemId',
    {
      preHandler: [requireStaff],
    },
    async (request): Promise<ExistingClaimResponse> => {
      const supabase = getSupabase();
      const itemId = request.params.itemId;

      const { data: claim, error } = await supabase
        .from('claim_table')
        .select(
          'claim_id, item_id, claimer_name, claimer_school_email, claimer_contact_num, processed_by_staff_id, claimed_at'
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
