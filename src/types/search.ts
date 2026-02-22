import type { ItemStatus } from './posts.js';

export interface SearchItemsRequest {
  query: string;
  limit?: number;
  last_seen_date?: string | null;
  category?: string[] | null;
  location_last_seen?: string | null;
  claim_from?: string | null;
  claim_to?: string | null;
  item_status?: ItemStatus[] | null;
  sort?: 'submission_date';
  sort_direction?: 'asc' | 'desc';
}

export interface SearchItemsStaffRequest extends Omit<SearchItemsRequest, 'sort'> {
  sort?: 'accepted_on_date' | 'submission_date';
}

export interface DashboardStats {
  pending_verifications: number;
  pending_fraud_reports: number;
  claimed_count: number;
  unclaimed_count: number;
  to_review_count: number;
  lost_count: number;
  returned_count: number;
  reported_count: number;
}
