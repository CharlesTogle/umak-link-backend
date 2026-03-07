import { FastifyInstance } from 'fastify';
import { getSupabaseClient } from '../services/supabase.js';
import { requireStaff } from '../middleware/auth.js';
import { ProcessClaimRequest, ExistingClaimResponse } from '../types/claims.js';
import logger from '../utils/logger.js';
import { logAudit, getUserName } from '../utils/audit-logger.js';

export default async function claimsRoutes(server: FastifyInstance) {
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
                'poster_name',
                'staff_id',
                'staff_name',
              ],
              properties: {
                claimer_name: { type: 'string', minLength: 1 },
                claimer_school_email: { type: 'string', minLength: 1 },
                claimer_contact_num: { type: 'string', minLength: 1 },
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
      const supabase = getSupabaseClient();
      const { found_post_id, missing_post_id, claim_details } = request.body;
      const staffId = request.user?.user_id || claim_details.staff_id;

      // Check if claim already exists (for overwrite detection)
      const { data: postData } = await supabase
        .from('post_public_view')
        .select('item_id, item_name')
        .eq('post_id', found_post_id)
        .single();

      let existingClaim = null;
      if (postData?.item_id) {
        const { data: claimData } = await supabase
          .from('claim_table')
          .select('claim_id, claimer_name, claimer_school_email, claimer_contact_num, claimed_at')
          .eq('item_id', postData.item_id)
          .single();

        existingClaim = claimData;
      }

      const { data, error } = await supabase.rpc('process_claim', {
        p_found_post_id: found_post_id,
        p_missing_post_id: missing_post_id,
        p_claim_details: claim_details,
      });

      if (error) {
        logger.error({ error }, 'Failed to process claim');
        throw new Error(error.message || 'Failed to process claim');
      }

      // Log to audit trail
      if (staffId) {
        const staffName = await getUserName(staffId);
        const itemName = postData?.item_name || 'Unknown Item';

        if (existingClaim) {
          // Claim overwrite
          await logAudit({
            userId: staffId,
            actionType: 'claim_overwritten',
            details: {
              message: `${staffName} overwritten claim for ${itemName}`,
              item_id: postData?.item_id,
              item_name: itemName,
              found_post_id: found_post_id,
              missing_post_id: missing_post_id,
              old_claim: {
                claim_id: existingClaim.claim_id,
                claimer_name: existingClaim.claimer_name,
                claimer_email: existingClaim.claimer_school_email,
                claimer_contact: existingClaim.claimer_contact_num,
                claimed_at: existingClaim.claimed_at,
              },
              new_claim: {
                claimer_name: claim_details.claimer_name,
                claimer_email: claim_details.claimer_school_email,
                claimer_contact: claim_details.claimer_contact_num,
                processed_by_staff: claim_details.staff_name,
              },
              timestamp: new Date().toISOString(),
            },
            recordId: data?.toString() || found_post_id.toString(),
          });
        } else {
          // New claim
          await logAudit({
            userId: staffId,
            actionType: 'claim_processed',
            details: {
              message: `${staffName} processed claim for ${itemName}`,
              item_id: postData?.item_id,
              item_name: itemName,
              found_post_id: found_post_id,
              missing_post_id: missing_post_id,
              claimer_name: claim_details.claimer_name,
              claimer_email: claim_details.claimer_school_email,
              claimer_contact: claim_details.claimer_contact_num,
              processed_by_staff: claim_details.staff_name,
              timestamp: new Date().toISOString(),
            },
            recordId: data?.toString() || found_post_id.toString(),
          });
        }
      }

      logger.info({ foundPostId: found_post_id }, 'Claim processed');
      return { success: true, claim_id: data };
    }
  );

  // GET /claims/by-item/:itemId - Check if item has existing claim
  server.get<{ Params: { itemId: string } }>(
    '/by-item/:itemId',
    {
      preHandler: [requireStaff],
    },
    async (request): Promise<ExistingClaimResponse> => {
      const supabase = getSupabaseClient();
      const itemId = request.params.itemId;

      const { data: claim, error } = await supabase
        .from('claim_table')
        .select('claim_id, claimer_name, claimer_school_email, claimed_at')
        .eq('item_id', itemId)
        .single();

      if (error && error.code !== 'PGRST116') {
        logger.error({ error, itemId }, 'Failed to check existing claim');
        throw new Error('Failed to check claim status');
      }

      return {
        exists: !!claim,
        claim: claim
          ? {
              claim_id: claim.claim_id,
              claimer_name: claim.claimer_name,
              claimer_email: claim.claimer_school_email,
              claimed_at: claim.claimed_at,
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
      const supabase = getSupabaseClient();
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
      const supabase = getSupabaseClient();
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
      const supabase = getSupabaseClient();
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
            item_status: 'lost',
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
