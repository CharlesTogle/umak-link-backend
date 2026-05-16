export interface ApiError {
  statusCode: number;
  error: string;
  code: string;
  message?: string;
  requestId?: string;
  retryAfterSeconds?: number;
}

export interface PaginationParams {
  limit?: number;
  offset?: number;
}

export interface PaginatedResponse<T> {
  data: T[];
  count: number;
  hasMore: boolean;
}
