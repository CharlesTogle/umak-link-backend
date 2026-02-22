import type { UserProfile } from './auth.js';

export type FraudReportStatus = 'under_review' | 'verified' | 'rejected' | 'resolved' | 'open';

export interface FraudReportCreateRequest {
  post_id: number;
  reason: string;
  proof_image_url?: string | null;
  reported_by?: string | null;
  claim_id?: string | null;
  claimer_name?: string | null;
  claimer_school_email?: string | null;
  claimer_contact_num?: string | null;
  claimed_at?: string | null;
  claim_processed_by_staff_id?: string | null;
}

export interface FraudReportPublic {
  report_id: string;
  post_id: number;
  reason: string;
  status: FraudReportStatus;
  created_at: string;
  reporter: UserProfile | null;
  poster: UserProfile;
  claim_info: Record<string, unknown> | null;
  item_info: Record<string, unknown>;
}

export interface FraudReportListResponse {
  reports: FraudReportPublic[];
  count?: number;
}

export interface FraudReportStatusRequest {
  status: FraudReportStatus;
}

export interface FraudReportResolveRequest {
  delete_claim?: boolean;
}
