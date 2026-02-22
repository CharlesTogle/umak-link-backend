export interface ClaimDetails {
  claimer_name: string;
  claimer_school_email: string;
  claimer_contact_num: string;
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
    claimer_name: string;
    claimer_email: string;
    claimed_at: string;
  };
}
