export interface SendNotificationRequest {
  user_id: string;
  title: string;
  body: string;
  description?: string | null;
  type: string;
  data?: Record<string, unknown>;
  image_url?: string | null;
}

export interface NotificationRecord {
  notification_id: number;
  user_id: string;
  title: string;
  body: string;
  type: string;
  is_read: boolean;
  created_at: string;
  image_url?: string | null;
}

export interface SendGlobalAnnouncementRequest {
  user_id: string;
  message: string;
  description?: string | null;
  image_url?: string | null;
}

export interface AnnouncementRecord {
  id: number;
  message: string;
  description: string | null;
  created_at: string;
  image_url?: string | null;
}

export interface GenerateMetadataBatchResponse {
  processed: number;
  succeeded: number;
  failed: number;
  results: Array<{
    item_id: string;
    success: boolean;
    error?: string | null;
  }>;
}

export interface ProcessPendingMatchResponse {
  total_pending: number;
  processed: number;
  failed: number;
  remaining: number;
  timed_out: boolean;
  rate_limit_stopped: boolean;
}
