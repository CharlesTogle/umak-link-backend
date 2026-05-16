import { FastifyInstance } from 'fastify';
import { getSupabaseClient } from '../services/supabase.js';
import { requireAuth, requireGuardOrStaffOrAdmin, requireStaff } from '../middleware/auth.js';
import { canGuardAccessClaimReview } from '../services/claim-verification.js';
import { UserSearchResponse } from '../types/auth.js';
import { createHttpError, normalizeUpstreamError } from '../utils/http-error.js';
import { generateClaimCode, normalizeClaimCodeInput } from '../utils/claim-code.js';
import logger from '../utils/logger.js';

const DEFAULT_USER_SEARCH_LIMIT = 20;
const MAX_CLAIM_CODE_GENERATION_ATTEMPTS = 10;
const CLAIM_CODE_TTL_MS = 5 * 60 * 1000;

type UsersRouteSupabaseClient = Pick<ReturnType<typeof getSupabaseClient>, 'from' | 'rpc'>;

export interface UserRouteServices {
  getSupabaseClient: () => UsersRouteSupabaseClient;
  generateClaimCode: () => string;
  canGuardAccessClaimReview?: (
    postId: number,
    guardUserId: string
  ) => Promise<boolean>;
}

interface UserRouteOptions {
  services?: Partial<UserRouteServices>;
}

const defaultServices: UserRouteServices = {
  getSupabaseClient,
  generateClaimCode,
  canGuardAccessClaimReview: async (postId, guardUserId) =>
    await canGuardAccessClaimReview(postId, guardUserId, {
      getSupabase: getSupabaseClient,
    }),
};

type UserSearchRpcError = {
  code?: string;
  message: string;
  details?: string | null;
  hint?: string | null;
};

type UserSearchRpcResult = {
  data: UserSearchResponse['results'] | null;
  error: UserSearchRpcError | null;
};

type UserSearchRpcClient = {
  rpc(functionName: string, args: Record<string, unknown>): PromiseLike<UserSearchRpcResult>;
};

function isRpcSignatureMismatch(error: UserSearchRpcError | null): boolean {
  if (!error) return false;

  return (
    error.code === 'PGRST202' ||
    error.details?.includes('Searched for the function') === true ||
    error.message.includes('schema cache')
  );
}

function isUserSearchAuthorizationError(error: UserSearchRpcError | null): boolean {
  if (!error) return false;

  return error.code === 'P0001';
}

function isNoRowsError(error: { code?: string } | null | undefined): boolean {
  return error?.code === 'PGRST116';
}

function isUniqueConstraintError(error: { code?: string } | null | undefined): boolean {
  return error?.code === '23505';
}

async function loadUserClaimCodeState(
  supabase: UsersRouteSupabaseClient,
  userId: string
): Promise<{
  user_id: string;
  user_type: string;
  claim_manual_entry_code: string | null;
  claim_manual_entry_code_expires_at: string | null;
}> {
  const { data, error } = await supabase
    .from('user_table')
    .select(
      'user_id, user_type, claim_manual_entry_code, claim_manual_entry_code_expires_at'
    )
    .eq('user_id', userId)
    .single();

  if (error || !data) {
    logger.error({ error, userId }, 'Failed to load user claim code state');
    throw createHttpError('User not found.', 404);
  }

  return data;
}

function isClaimCodeExpired(
  expiresAt: string | null | undefined,
  now = new Date()
): boolean {
  if (!expiresAt) {
    return true;
  }

  const expiresAtTimestamp = Date.parse(expiresAt);
  if (Number.isNaN(expiresAtTimestamp)) {
    return true;
  }

  return expiresAtTimestamp <= now.getTime();
}

function getClaimCodeExpiresAt(now = new Date()): string {
  return new Date(now.getTime() + CLAIM_CODE_TTL_MS).toISOString();
}

async function ensureUserClaimCode(
  supabase: UsersRouteSupabaseClient,
  userId: string,
  codeGenerator: () => string
): Promise<{
  claimManualEntryCode: string;
  expiresAt: string;
}> {
  const now = new Date();
  const currentUser = await loadUserClaimCodeState(supabase, userId);

  if (
    currentUser.claim_manual_entry_code &&
    !isClaimCodeExpired(currentUser.claim_manual_entry_code_expires_at, now)
  ) {
    return {
      claimManualEntryCode: currentUser.claim_manual_entry_code,
      expiresAt: currentUser.claim_manual_entry_code_expires_at!,
    };
  }

  for (
    let attemptIndex = 0;
    attemptIndex < MAX_CLAIM_CODE_GENERATION_ATTEMPTS;
    attemptIndex += 1
  ) {
    const nextCode = normalizeClaimCodeInput(codeGenerator());
    if (nextCode.length !== 6) {
      continue;
    }

    const nextExpiresAt = getClaimCodeExpiresAt(now);
    const { data, error } = await supabase
      .from('user_table')
      .update({
        claim_manual_entry_code: nextCode,
        claim_manual_entry_code_expires_at: nextExpiresAt,
      })
      .eq('user_id', userId)
      .select('claim_manual_entry_code, claim_manual_entry_code_expires_at');

    if (!error && data && data.length > 0) {
      return {
        claimManualEntryCode: nextCode,
        expiresAt: nextExpiresAt,
      };
    }

    if (isUniqueConstraintError(error)) {
      continue;
    }

    const refreshedUser = await loadUserClaimCodeState(supabase, userId);
    if (
      refreshedUser.claim_manual_entry_code &&
      !isClaimCodeExpired(refreshedUser.claim_manual_entry_code_expires_at, now)
    ) {
      return {
        claimManualEntryCode: refreshedUser.claim_manual_entry_code,
        expiresAt: refreshedUser.claim_manual_entry_code_expires_at!,
      };
    }

    if (error) {
      logger.error({ error, userId }, 'Failed to issue claim manual entry code');
      throw createHttpError('Failed to issue claim code.', 500);
    }
  }

  logger.error({ userId }, 'Failed to generate a unique claim manual entry code');
  throw createHttpError('Failed to issue claim code.', 500);
}

export async function searchUsersWithCompatibleRpcSignature(
  supabase: UserSearchRpcClient,
  rpcFunction: 'search_users_secure' | 'search_users_secure_staff',
  query: string,
  limit = DEFAULT_USER_SEARCH_LIMIT
): Promise<UserSearchRpcResult> {
  const primaryAttempt = await supabase.rpc(rpcFunction, {
    search_query: query,
    search_limit: limit,
  });

  if (!primaryAttempt.error || !isRpcSignatureMismatch(primaryAttempt.error)) {
    return primaryAttempt;
  }

  logger.warn(
    { error: primaryAttempt.error, rpcFunction },
    'User search RPC signature mismatch, retrying with legacy search_term argument'
  );

  return supabase.rpc(rpcFunction, {
    search_term: query,
  });
}

export default async function usersRoutes(server: FastifyInstance, options: UserRouteOptions = {}) {
  const services: UserRouteServices = {
    ...defaultServices,
    ...options.services,
  };
  const canGuardAccess =
    services.canGuardAccessClaimReview ?? defaultServices.canGuardAccessClaimReview!;

  server.get(
    '/me/claim-code',
    {
      preHandler: [requireAuth],
    },
    async (request) => {
      if (!request.user) {
        throw createHttpError('Unauthorized', 401);
      }

      if (request.user.user_type !== 'User') {
        throw createHttpError('Only student users can open claim QR.', 403);
      }

      const supabase = services.getSupabaseClient();
      const claimCodeState = await ensureUserClaimCode(
        supabase,
        request.user.user_id,
        services.generateClaimCode
      );

      return {
        claim_manual_entry_code: claimCodeState.claimManualEntryCode,
        expires_at: claimCodeState.expiresAt,
      };
    }
  );

  // GET /users/:id - Get user profile (staff only)
  server.get<{ Params: { id: string } }>(
    '/:id',
    {
      preHandler: [requireStaff],
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
      const userId = request.params.id;

      const { data: user, error } = await supabase
        .from('user_table')
        .select('user_id, user_name, email, profile_picture_url, user_type')
        .eq('user_id', userId)
        .single();

      if (error || !user) {
        logger.error({ error, userId }, 'Failed to fetch user');
        throw new Error('User not found');
      }

      return user;
    }
  );

  // GET /users/search - Search users (staff/admin only)
  server.get<{ Querystring: { query: string } }>(
    '/search',
    {
      preHandler: [requireStaff],
      schema: {
        querystring: {
          type: 'object',
          required: ['query'],
          properties: {
            query: { type: 'string', minLength: 1 },
          },
        },
      },
    },
    async (request): Promise<UserSearchResponse> => {
      const supabase = services.getSupabaseClient();
      const { query } = request.query;

      const rpcFunction =
        request.user?.user_type === 'Admin' ? 'search_users_secure' : 'search_users_secure_staff';

      const { data, error } = await searchUsersWithCompatibleRpcSignature(
        supabase,
        rpcFunction,
        query
      );

      if (error) {
        logger.error({ error }, 'User search failed');
        if (isUserSearchAuthorizationError(error)) {
          throw normalizeUpstreamError(error, {
            statusCode: 403,
            message: 'Forbidden',
            code: 'FORBIDDEN',
            error: 'Forbidden',
          });
        }

        throw normalizeUpstreamError(error, {
          statusCode: 500,
          message: 'Search failed',
          code: 'USER_SEARCH_FAILED',
        });
      }

      return { results: data || [] };
    }
  );

  server.get<{ Params: { code: string }; Querystring: { found_post_id?: number } }>(
    '/claim-code/:code',
    {
      preHandler: [requireGuardOrStaffOrAdmin],
      schema: {
        params: {
          type: 'object',
          required: ['code'],
          properties: {
            code: { type: 'string', minLength: 1 },
          },
        },
        querystring: {
          type: 'object',
          properties: {
            found_post_id: { type: 'number' },
          },
          additionalProperties: false,
        },
      },
    },
    async (request) => {
      if (!request.user) {
        throw createHttpError('Unauthorized', 401);
      }

      if (request.user.user_type === 'Guard') {
        const foundPostId = request.query.found_post_id ?? null;

        if (!foundPostId || foundPostId <= 0) {
          throw createHttpError(
            'Guard claim code resolution requires a valid found_post_id.',
            400
          );
        }

        const canAccess = await canGuardAccess(
          foundPostId,
          request.user.user_id
        );

        if (!canAccess) {
          throw createHttpError(
            'Guard can only resolve claim codes for items still in their custody review.',
            403
          );
        }
      }

      const supabase = services.getSupabaseClient();
      const normalizedCode = normalizeClaimCodeInput(request.params.code);

      if (normalizedCode.length !== 6) {
        throw createHttpError('Claim code must be 6 characters.', 400);
      }

      const { data, error } = await supabase
        .from('user_table')
        .select(
          'user_id, user_name, email, profile_picture_url, user_type, claim_manual_entry_code_expires_at'
        )
        .eq('user_type', 'User')
        .eq('claim_manual_entry_code', normalizedCode)
        .single();

      if (error || !data) {
        if (isNoRowsError(error)) {
          throw createHttpError('Claim code not found.', 404);
        }

        logger.error({ error, normalizedCode }, 'Failed to resolve claim code');
        throw createHttpError('Failed to resolve claim code.', 500);
      }

      if (isClaimCodeExpired(data.claim_manual_entry_code_expires_at)) {
        throw createHttpError(
          'Claim QR expired. Ask the student to open the claim QR again.',
          410
        );
      }

      return {
        user_id: data.user_id,
        user_name: data.user_name,
        email: data.email,
        profile_picture_url: data.profile_picture_url,
        user_type: data.user_type,
      };
    }
  );
}
