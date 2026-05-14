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

export type StudentCustodyHistoryEventType =
  | 'item_reported'
  | 'handover_attempted'
  | 'guard_rejected'
  | 'guard_accepted'
  | 'session_timed_out'
  | 'security_office_received'
  | 'attempt_cancelled'
  | 'under_investigation'
  | 'physical_take_reported';

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

export interface CustodySessionRetryMetadata {
  number_of_attempts: number;
  max_number_of_attempts: number;
  retries_remaining: number;
}

export interface CreateCustodyAttemptResponse extends CustodySessionRetryMetadata {
  custody_attempt_id: string;
  qr_code_session_id: string;
  attempt_status: CustodyAttemptStatus;
  qr_status: QrCodeSessionStatus;
  custody_status: CustodyStatus;
  expires_at: string;
}

export interface CustodySessionStatusResponse extends CustodySessionRetryMetadata {
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
  current_window_expired: boolean;
  can_retry: boolean;
}

export interface RetryCustodySessionRequest {
  session_token: string;
}

export interface RetryCustodySessionResponse extends CustodySessionRetryMetadata {
  qr_code_session_id: string;
  custody_attempt_id: string;
  attempt_status: CustodyAttemptStatus;
  qr_status: QrCodeSessionStatus;
  custody_status: CustodyStatus;
  expires_at: string;
}

export interface CancelCustodySessionResponse {
  qr_code_session_id: string;
  custody_attempt_id: string;
  attempt_status: CustodyAttemptStatus;
  qr_status: QrCodeSessionStatus;
  custody_status: CustodyStatus;
  cancelled_at: string;
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

export interface EscalateStaleAcceptedCustodyAttemptsResponse {
  escalated_count: number;
}

export interface StaffCustodyPostRequest {
  post_id: number;
}

export interface PhysicalTakeReportRequest extends StaffCustodyPostRequest {
  guard_id: string;
}

export interface SecurityOfficeReceiptResponse {
  post_id: number;
  custody_attempt_id: string;
  custody_status: CustodyStatus;
  office_received_at: string;
}

export interface OpenCustodyInvestigationResponse {
  post_id: number;
  custody_attempt_id: string;
  custody_status: CustodyStatus;
  investigation_opened_at: string;
}

export interface PhysicalTakeReportResponse {
  post_id: number;
  custody_attempt_id: string;
  guard_id: string;
  custody_status: CustodyStatus;
  reported_at: string;
}

export interface NotifyGuardRequest extends StaffCustodyPostRequest {}

export interface NotifyGuardResponse {
  post_id: number;
  custody_attempt_id: string;
  guard_id: string;
  notification_id: string | number;
  notification_status: 'created';
  requested_at: string;
}

export interface StudentCustodyHistoryEntry {
  history_id: string;
  event_type: StudentCustodyHistoryEventType;
  source_record_type: string | null;
  message: string;
  occurred_at: string;
  custody_attempt_id: string | null;
  qr_code_session_id: string | null;
  attempt_number: number | null;
  guard_post_id: string | null;
  guard_post_name: string | null;
  full_location_name: string | null;
  handover_image_url: string | null;
  actor_user_id: string | null;
  actor_name: string | null;
}

export interface StudentCustodyHistoryResponse {
  post_id: number;
  item_id: string;
  post_status: string | null;
  custody_status: CustodyStatus;
  history: StudentCustodyHistoryEntry[];
}
