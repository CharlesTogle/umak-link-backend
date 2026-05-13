import { UserType } from './auth.js';

export type CustodyStatus =
  | 'untracked'
  | 'with_reporter'
  | 'handover_in_progress'
  | 'with_guard'
  | 'in_security_office'
  | 'under_investigation';

export type CustodyAttemptStatus =
  | 'open'
  | 'accepted'
  | 'rejected'
  | 'timed_out'
  | 'cancelled';

export type QrCodeSessionStatus =
  | 'active'
  | 'accepted'
  | 'rejected'
  | 'expired'
  | 'cancelled';

export type CustodyDecision = 'accepted' | 'rejected';

export interface CustodyActor {
  user_id: string;
  email: string | null;
  user_type: UserType;
}

export interface GuardPostRecord {
  guard_post_id: string;
  guard_post_name: string;
  location_id: number;
  full_location_name: string | null;
  is_active: boolean;
}

export interface CreateCustodyAttemptRequest {
  post_id: number;
  guard_post_id: string;
  handover_image_url: string;
  handover_image_hash: string;
  session_token: string;
}

export interface CreateCustodyAttemptResponse {
  custody_attempt_id: string;
  qr_code_session_id: string;
  attempt_status: CustodyAttemptStatus;
  qr_status: QrCodeSessionStatus;
  custody_status: CustodyStatus;
  expires_at: string;
}

export interface CustodySessionStatusResponse {
  qr_code_session_id: string;
  custody_attempt_id: string;
  post_id: number;
  item_id: string;
  qr_status: QrCodeSessionStatus;
  attempt_status: CustodyAttemptStatus;
  custody_status: CustodyStatus;
  expires_at: string;
  scanned_at: string | null;
  decision_at: string | null;
}

export interface GuardScanRequest {
  qr_code_session_id: string;
  session_token: string;
}

export interface GuardScanResponse {
  qr_code_session_id: string;
  custody_attempt_id: string;
  post_id: number;
  item_id: string;
  item_name: string;
  item_description: string | null;
  item_image_url: string | null;
  handover_image_url: string | null;
  category: string | null;
  last_seen_at: string | null;
  last_seen_location: string | null;
  submission_date: string;
  guard_post_id: string;
  guard_post_name: string | null;
  attempt_number: number;
  custody_status: CustodyStatus;
  qr_status: QrCodeSessionStatus;
  attempt_status: CustodyAttemptStatus;
}

export interface GuardDecisionRequest {
  qr_code_session_id: string;
  decision: CustodyDecision;
  decision_reason?: string;
}

export interface GuardDecisionResponse {
  custody_attempt_id: string;
  qr_code_session_id: string;
  attempt_status: CustodyAttemptStatus;
  qr_status: QrCodeSessionStatus;
  custody_status: CustodyStatus;
  decision_at: string;
}

export interface ExpireCustodySessionsResponse {
  expired_count: number;
}
