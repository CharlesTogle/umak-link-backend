import { FastifyRequest } from 'fastify';

type HeaderValue = string | string[] | undefined;
type HeaderMap = Record<string, HeaderValue>;

function getFirstHeaderValue(value: HeaderValue): string | undefined {
  if (Array.isArray(value)) {
    return value.find((entry): entry is string => typeof entry === 'string');
  }

  return typeof value === 'string' ? value : undefined;
}

export function getAuthorizationHeader(
  request: Pick<FastifyRequest, 'headers' | 'raw'>
): string | undefined {
  const requestHeaders = request.headers as HeaderMap;
  const rawHeaders = request.raw.headers as HeaderMap;

  return (
    getFirstHeaderValue(requestHeaders.authorization) ??
    getFirstHeaderValue(requestHeaders.Authorization) ??
    getFirstHeaderValue(rawHeaders.authorization) ??
    getFirstHeaderValue(rawHeaders.Authorization)
  );
}

export function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader) return null;

  const match = authHeader.trim().match(/^Bearer\s+(.+)$/i);
  if (!match) return null;

  const token = match[1].trim();
  return token.length > 0 ? token : null;
}
