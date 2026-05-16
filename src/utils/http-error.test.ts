import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildApiErrorResponse,
  createHttpError,
  getErrorCodeForStatus,
  getErrorTitleForStatus,
  isHttpError,
  normalizeUpstreamError,
} from './http-error.js';

test('getErrorTitleForStatus and getErrorCodeForStatus fall back safely', () => {
  assert.equal(getErrorTitleForStatus(403), 'Forbidden');
  assert.equal(getErrorCodeForStatus(403), 'FORBIDDEN');
  assert.equal(getErrorTitleForStatus(999), 'Internal Server Error');
  assert.equal(getErrorCodeForStatus(999), 'INTERNAL_SERVER_ERROR');
});

test('createHttpError produces a typed safe HTTP error', () => {
  const error = createHttpError('Only staff can do this action', 403);

  assert.equal(isHttpError(error), true);
  assert.equal(error.statusCode, 403);
  assert.equal(error.error, 'Forbidden');
  assert.equal(error.code, 'FORBIDDEN');
  assert.equal(error.message, 'Only staff can do this action');
});

test('normalizeUpstreamError maps PostgREST not found errors to a safe 404', () => {
  const error = normalizeUpstreamError(
    { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' },
    { statusCode: 500, message: 'Fallback message' }
  );

  assert.equal(error.statusCode, 404);
  assert.equal(error.error, 'Not Found');
  assert.equal(error.code, 'NOT_FOUND');
  assert.equal(error.message, 'Fallback message');
});

test('normalizeUpstreamError maps configuration-style upstream errors to a safe 500', () => {
  const pgrstError = normalizeUpstreamError(
    { code: 'PGRST202', message: 'Could not find the function public.rpc_name' },
    { statusCode: 500, message: 'Search failed' }
  );
  const postgresError = normalizeUpstreamError(
    { code: '42703', message: 'column private_column does not exist' },
    { statusCode: 500, message: 'Search failed' }
  );

  assert.equal(pgrstError.statusCode, 500);
  assert.equal(pgrstError.error, 'Internal Server Error');
  assert.equal(pgrstError.code, 'BACKEND_CONFIGURATION_ERROR');

  assert.equal(postgresError.statusCode, 500);
  assert.equal(postgresError.error, 'Internal Server Error');
  assert.equal(postgresError.code, 'BACKEND_CONFIGURATION_ERROR');
});

test('normalizeUpstreamError maps duplicate and rate-limited upstream errors', () => {
  const duplicate = normalizeUpstreamError(
    { code: '23505', message: 'duplicate key value violates unique constraint' },
    { statusCode: 500, message: 'Unable to create record' }
  );
  const rateLimited = normalizeUpstreamError(
    { code: 'P0002', message: 'too many requests' },
    { statusCode: 500, message: 'Search failed', retryAfterSeconds: 9 }
  );

  assert.equal(duplicate.statusCode, 409);
  assert.equal(duplicate.error, 'Conflict');
  assert.equal(duplicate.code, 'DUPLICATE_RESOURCE');

  assert.equal(rateLimited.statusCode, 429);
  assert.equal(rateLimited.error, 'Rate Limited');
  assert.equal(rateLimited.code, 'RATE_LIMITED');
  assert.equal(rateLimited.retryAfterSeconds, 9);
});

test('normalizeUpstreamError uses the fallback contract for unknown errors', () => {
  const error = normalizeUpstreamError(
    { code: 'UNKNOWN_UPSTREAM', message: 'relation internal_table does not exist' },
    { statusCode: 503, message: 'Search unavailable', code: 'SERVICE_UNAVAILABLE' }
  );

  assert.equal(error.statusCode, 503);
  assert.equal(error.error, 'Service Unavailable');
  assert.equal(error.code, 'SERVICE_UNAVAILABLE');
  assert.equal(error.message, 'Search unavailable');
});

test('buildApiErrorResponse returns only safe frontend-facing fields', () => {
  const response = buildApiErrorResponse(
    createHttpError('Only admins can search users', 429, {
      retryAfterSeconds: 7,
    }),
    'req-123'
  );

  assert.deepEqual(response, {
    statusCode: 429,
    error: 'Rate Limited',
    code: 'RATE_LIMITED',
    message: 'Rate Limited',
    requestId: 'req-123',
    retryAfterSeconds: 7,
  });
});

test('buildApiErrorResponse hides raw unknown error messages', () => {
  const response = buildApiErrorResponse(
    new Error('relation private_table does not exist'),
    'req-raw'
  );

  assert.deepEqual(response, {
    statusCode: 500,
    error: 'Internal Server Error',
    code: 'INTERNAL_SERVER_ERROR',
    message: 'Internal Server Error',
    requestId: 'req-raw',
  });
});
