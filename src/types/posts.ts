export type ItemType = 'found' | 'lost' | 'missing';
export type ItemStatus = 'claimed' | 'unclaimed' | 'discarded' | 'returned' | 'lost';
export type PostStatus =
  | 'pending'
  | 'accepted'
  | 'rejected'
  | 'archived'
  | 'deleted'
  | 'reported'
  | 'fraud';

export interface LocationPath {
  name: string;
  type: string;
}

export interface CreatePostRequest {
  p_item_name: string;
  p_item_description?: string;
  p_item_type: ItemType;
  p_poster_id: string;
  p_image_hash: string;
  p_category?: string;
  p_date_day?: number;
  p_date_month?: number;
  p_date_year?: number;
  p_time_hour?: number;
  p_time_minute?: number;
  p_location_path: LocationPath[];
  p_is_anonymous?: boolean;
}

export interface EditPostRequest extends Partial<CreatePostRequest> {
  post_id: number;
  // Additional fields for edit-with-image endpoint
  p_image_link?: string;
  p_last_seen_date?: string;
  p_last_seen_hours?: number;
  p_last_seen_minutes?: number;
  p_post_status?: PostStatus;
  p_item_status?: ItemStatus;
}

export interface PostRecord {
  post_id: number;
  item_id: string;
  poster_name: string;
  poster_id: string;
  item_name: string;
  item_description: string | null;
  item_type: ItemType;
  item_image_url: string;
  category: string | null;
  last_seen_at: string | null;
  last_seen_location: string | null;
  submission_date: string;
  post_status: PostStatus;
  item_status: ItemStatus;
  accepted_by_staff_name: string | null;
  accepted_by_staff_email: string | null;
  claim_id: string | null;
  claimed_by_name: string | null;
  claimed_by_email: string | null;
  claim_processed_by_staff_id: string | null;
  accepted_on_date: string | null;
  is_anonymous: boolean;
}

export interface PostRecordDetails extends PostRecord {
  linked_lost_item_id: string | null;
  returned_at_local: string | null;
}

export interface PostListResponse {
  posts: PostRecord[];
  count?: number;
}

export interface UpdatePostStatusRequest {
  status: PostStatus;
  rejection_reason?: string;
}

export interface UpdateItemStatusRequest {
  status: ItemStatus;
}
