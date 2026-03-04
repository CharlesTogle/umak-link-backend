export interface PaginationOptions {
  defaultLimit?: number;
  maxLimit?: number;
  defaultOffset?: number;
}

export function parsePagination(
  limit: string | number | undefined,
  offset: string | number | undefined,
  options: PaginationOptions = {}
): { limit: number; offset: number } {
  const {
    defaultLimit = 20,
    maxLimit = 100,
    defaultOffset = 0,
  } = options;

  const parsedLimit = typeof limit === 'string' ? parseInt(limit, 10) : limit;
  const parsedOffset = typeof offset === 'string' ? parseInt(offset, 10) : offset;

  const safeLimit = Number.isFinite(parsedLimit) ? parsedLimit : defaultLimit;
  const safeOffset = Number.isFinite(parsedOffset) ? parsedOffset : defaultOffset;

  return {
    limit: Math.min(Math.max(safeLimit, 1), maxLimit),
    offset: Math.max(safeOffset, 0),
  };
}
