import type { ApiError } from '../types/common.js';

export interface HttpError extends Error {
  statusCode: number;
  error: string;
  code: string;
  retryAfterSeconds?: number;
}

interface HttpErrorOptions {
  code?: string;
  error?: string;
  retryAfterSeconds?: number;
}

interface ErrorFallback {
  statusCode: number;
  message: string;
  code?: string;
  error?: string;
  retryAfterSeconds?: number;
}

interface SupabaseErrorLike {
  code?: string;
  message?: string;
  details?: string | null;
  hint?: string | null;
}

const DEFAULT_RATE_LIMIT_SECONDS = 5;

const STATUS_ERROR_TITLES: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  408: 'Request Timeout',
  409: 'Conflict',
  410: 'Gone',
  422: 'Validation Failed',
  429: 'Rate Limited',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
};

const STATUS_ERROR_CODES: Record<number, string> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  408: 'REQUEST_TIMEOUT',
  409: 'CONFLICT',
  410: 'GONE',
  422: 'VALIDATION_FAILED',
  429: 'RATE_LIMITED',
  500: 'INTERNAL_SERVER_ERROR',
  503: 'SERVICE_UNAVAILABLE',
  504: 'REQUEST_TIMEOUT',
};

export function getErrorTitleForStatus(statusCode: number): string {
  return STATUS_ERROR_TITLES[statusCode] ?? STATUS_ERROR_TITLES[500];
}

export function getErrorCodeForStatus(statusCode: number): string {
  return STATUS_ERROR_CODES[statusCode] ?? STATUS_ERROR_CODES[500];
}

export function createHttpError(
  message: string,
  statusCode: number,
  options: HttpErrorOptions = {}
): HttpError {
  const error = new Error(message || getErrorTitleForStatus(statusCode)) as HttpError;
  error.statusCode = statusCode;
  error.error = options.error ?? getErrorTitleForStatus(statusCode);
  error.code = options.code ?? getErrorCodeForStatus(statusCode);

  if (typeof options.retryAfterSeconds === 'number') {
    error.retryAfterSeconds = options.retryAfterSeconds;
  }

  return error;
}

export function isHttpError(error: unknown): error is HttpError {
  if (!error || typeof error !== 'object') return false;

  const typed = error as Partial<HttpError>;
  return (
    typeof typed.statusCode === 'number' &&
    typeof typed.error === 'string' &&
    typeof typed.code === 'string'
  );
}

function isSupabaseErrorLike(error: unknown): error is SupabaseErrorLike {
  if (!error || typeof error !== 'object') return false;

  const typed = error as SupabaseErrorLike;
  return (
    typeof typed.code === 'string' ||
    typeof typed.message === 'string' ||
    typeof typed.details === 'string' ||
    typeof typed.hint === 'string'
  );
}

export function normalizeUpstreamError(
  error: unknown,
  fallback: ErrorFallback
): HttpError {
  if (isSupabaseErrorLike(error)) {
    switch (error.code) {
      case 'PGRST116':
        return createHttpError(fallback.message, 404, {
          code: 'NOT_FOUND',
          error: 'Not Found',
        });
      case 'PGRST202':
      case 'PGRST204':
      case '42703':
        return createHttpError(fallback.message, 500, {
          code: 'BACKEND_CONFIGURATION_ERROR',
          error: 'Internal Server Error',
        });
      case '23505':
        return createHttpError(fallback.message, 409, {
          code: 'DUPLICATE_RESOURCE',
          error: 'Conflict',
        });
      case 'P0001':
        return createHttpError(fallback.message, 403, {
          code: 'FORBIDDEN',
          error: 'Forbidden',
        });
      case 'P0002':
        return createHttpError(fallback.message, 429, {
          code: 'RATE_LIMITED',
          error: 'Rate Limited',
          retryAfterSeconds: fallback.retryAfterSeconds ?? DEFAULT_RATE_LIMIT_SECONDS,
        });
      case 'P0003':
        return createHttpError(fallback.message, 403, {
          code: 'SYSTEM_LOCKED',
          error: 'Forbidden',
        });
      default:
        break;
    }
  }

  return createHttpError(fallback.message, fallback.statusCode, {
    code: fallback.code,
    error: fallback.error,
    retryAfterSeconds: fallback.retryAfterSeconds,
  });
}

export function buildApiErrorResponse(
  error: unknown,
  requestId?: string
): ApiError {
  const statusCode =
    typeof (error as { statusCode?: unknown })?.statusCode === 'number'
      ? (error as { statusCode: number }).statusCode
      : 500;

  const errorTitle = isHttpError(error)
    ? error.error
    : getErrorTitleForStatus(statusCode);
  const code = isHttpError(error)
    ? error.code
    : getErrorCodeForStatus(statusCode);

  const safeMessage = isHttpError(error)
    ? statusCode < 500
      ? error.message || errorTitle
      : errorTitle
    : getErrorTitleForStatus(statusCode);

  const response: ApiError = {
    statusCode,
    error: errorTitle,
    code,
    message: safeMessage,
  };

  if (requestId) {
    response.requestId = requestId;
  }

  if (isHttpError(error) && typeof error.retryAfterSeconds === 'number') {
    response.retryAfterSeconds = error.retryAfterSeconds;
  }

  return response;
}
