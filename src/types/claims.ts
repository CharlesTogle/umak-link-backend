export interface ClaimDetails {
  claimer_name: string;
  claimer_school_email: string;
  claimer_contact_num: string;
  claimed_at?: string | null;
  poster_name: string;
  staff_id: string;
  staff_name: string;
}

export interface ProcessClaimRequest {
  found_post_id: number;
  missing_post_id?: number | null;
  claim_details: ClaimDetails;
}

export interface ExistingClaimResponse {
  exists: boolean;
  claim?: {
    claim_id: string;
    item_id: string;
    claimer_name: string;
    claimer_email: string;
    claimer_school_email: string;
    claimer_contact_num: string;
    processed_by_staff_id: string;
    claimed_at: string | null;
    staff_name?: string;
  };
}
