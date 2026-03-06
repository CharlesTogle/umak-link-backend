# UMak-LINK Backend Routes

Last updated: March 4, 2026.

Base URL: `http://<host>:<port>`

Authentication
- `Authorization: Bearer <jwt>` for authenticated user routes.
- Staff/Admin routes require a JWT with `user_type` of `Staff` or `Admin`.
- Admin-only routes require `user_type` of `Admin`.
- System jobs require `Authorization: Bearer <SYSTEM_TOKEN>`.

---

## Health

**GET `/health`**
Purpose: Health check for load balancers and uptime checks.

Sample response:
```json
{
  "status": "ok",
  "timestamp": "2026-03-04T12:00:00.000Z",
  "uptime": 12345.67
}
```

---

## Auth

**POST `/auth/google`**
Purpose: Log in with a Google ID token and receive a JWT.

Sample payload:
```json
{
  "googleIdToken": "eyJhbGciOiJSUzI1NiIs..."
}
```

Sample response:
```json
{
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "user": {
    "user_id": "google-oauth-sub",
    "user_name": "Juan Dela Cruz",
    "email": "juan@umak.edu.ph",
    "profile_picture_url": "https://lh3.googleusercontent.com/...",
    "user_type": "User",
    "notification_token": null
  }
}
```

**GET `/auth/me`**
Purpose: Fetch the currently authenticated user profile.

Sample response:
```json
{
  "user": {
    "user_id": "google-oauth-sub",
    "user_name": "Juan Dela Cruz",
    "email": "juan@umak.edu.ph",
    "profile_picture_url": "https://lh3.googleusercontent.com/...",
    "user_type": "User",
    "notification_token": null
  }
}
```

---

## Posts

**GET `/posts`**
Purpose: List posts with filtering, sorting, and pagination.

Sample request:
```http
GET /posts?type=public&item_type=found&limit=20&offset=0&order_by=submission_date&order_direction=desc
```

Sample response:
```json
{
  "posts": [
    {
      "post_id": 123,
      "item_id": "item-uuid",
      "poster_name": "Juan Dela Cruz",
      "poster_id": "user-uuid",
      "item_name": "Wallet",
      "item_description": "Black leather wallet with ID",
      "item_type": "found",
      "item_image_url": "https://.../items/wallet.jpg",
      "category": "Accessories",
      "last_seen_at": "2026-03-01T10:15:00.000Z",
      "last_seen_location": "Main Building > Lobby",
      "submission_date": "2026-03-01T10:15:00.000Z",
      "post_status": "accepted",
      "item_status": "unclaimed",
      "accepted_by_staff_name": "Staff Name",
      "accepted_by_staff_email": "staff@umak.edu.ph",
      "claim_id": null,
      "claimed_by_name": null,
      "claimed_by_email": null,
      "claim_processed_by_staff_id": null,
      "accepted_on_date": "2026-03-02T09:00:00.000Z",
      "is_anonymous": false
    }
  ],
  "count": 1
}
```

**GET `/posts/public`**
Purpose: Backward-compatible public posts listing (found + accepted/reported).

Sample response:
```json
{
  "posts": [
    {
      "post_id": 123,
      "item_id": "item-uuid",
      "poster_name": "Juan Dela Cruz",
      "poster_id": "user-uuid",
      "item_name": "Wallet",
      "item_description": "Black leather wallet with ID",
      "item_type": "found",
      "item_image_url": "https://.../items/wallet.jpg",
      "category": "Accessories",
      "last_seen_at": "2026-03-01T10:15:00.000Z",
      "last_seen_location": "Main Building > Lobby",
      "submission_date": "2026-03-01T10:15:00.000Z",
      "post_status": "accepted",
      "item_status": "unclaimed",
      "accepted_by_staff_name": "Staff Name",
      "accepted_by_staff_email": "staff@umak.edu.ph",
      "claim_id": null,
      "claimed_by_name": null,
      "claimed_by_email": null,
      "claim_processed_by_staff_id": null,
      "accepted_on_date": "2026-03-02T09:00:00.000Z",
      "is_anonymous": false
    }
  ],
  "count": 1
}
```

**GET `/posts/count`**
Purpose: Get a post count using the same filters as `/posts`.

Sample request:
```http
GET /posts/count?type=pending&item_type=missing
```

Sample response:
```json
{ "count": 5 }
```

**GET `/posts/by-item/:itemId`**
Purpose: Fetch a single post by item ID from `post_public_view`.

Sample response:
```json
{
  "post_id": 123,
  "item_id": "item-uuid",
  "poster_name": "Juan Dela Cruz",
  "poster_id": "user-uuid",
  "item_name": "Wallet",
  "item_description": "Black leather wallet with ID",
  "item_type": "found",
  "item_image_url": "https://.../items/wallet.jpg",
  "category": "Accessories",
  "last_seen_at": "2026-03-01T10:15:00.000Z",
  "last_seen_location": "Main Building > Lobby",
  "submission_date": "2026-03-01T10:15:00.000Z",
  "post_status": "accepted",
  "item_status": "unclaimed",
  "accepted_by_staff_name": "Staff Name",
  "accepted_by_staff_email": "staff@umak.edu.ph",
  "claim_id": null,
  "claimed_by_name": null,
  "claimed_by_email": null,
  "claim_processed_by_staff_id": null,
  "accepted_on_date": "2026-03-02T09:00:00.000Z",
  "is_anonymous": false
}
```

**GET `/posts/by-item-details/:itemId`**
Purpose: Fetch a detailed post record by item ID from `v_post_records_details`.

Sample response:
```json
{
  "post_id": 123,
  "item_id": "item-uuid",
  "poster_name": "Juan Dela Cruz",
  "poster_id": "user-uuid",
  "item_name": "Wallet",
  "item_description": "Black leather wallet with ID",
  "item_type": "found",
  "item_image_url": "https://.../items/wallet.jpg",
  "category": "Accessories",
  "last_seen_at": "2026-03-01T10:15:00.000Z",
  "last_seen_location": "Main Building > Lobby",
  "submission_date": "2026-03-01T10:15:00.000Z",
  "post_status": "accepted",
  "item_status": "unclaimed",
  "accepted_by_staff_name": "Staff Name",
  "accepted_by_staff_email": "staff@umak.edu.ph",
  "claim_id": null,
  "claimed_by_name": null,
  "claimed_by_email": null,
  "claim_processed_by_staff_id": null,
  "accepted_on_date": "2026-03-02T09:00:00.000Z",
  "is_anonymous": false,
  "linked_lost_item_id": null,
  "returned_at_local": null
}
```

**GET `/posts/:id`**
Purpose: Fetch a single post by post ID from `post_public_view`.

Sample response:
```json
{
  "post_id": 123,
  "item_id": "item-uuid",
  "poster_name": "Juan Dela Cruz",
  "poster_id": "user-uuid",
  "item_name": "Wallet",
  "item_description": "Black leather wallet with ID",
  "item_type": "found",
  "item_image_url": "https://.../items/wallet.jpg",
  "category": "Accessories",
  "last_seen_at": "2026-03-01T10:15:00.000Z",
  "last_seen_location": "Main Building > Lobby",
  "submission_date": "2026-03-01T10:15:00.000Z",
  "post_status": "accepted",
  "item_status": "unclaimed",
  "accepted_by_staff_name": "Staff Name",
  "accepted_by_staff_email": "staff@umak.edu.ph",
  "claim_id": null,
  "claimed_by_name": null,
  "claimed_by_email": null,
  "claim_processed_by_staff_id": null,
  "accepted_on_date": "2026-03-02T09:00:00.000Z",
  "is_anonymous": false
}
```

**GET `/posts/:id/full`**
Purpose: Fetch full post details from `v_post_records_details` (staff only).

Sample response:
```json
{
  "post_id": 123,
  "item_id": "item-uuid",
  "poster_name": "Juan Dela Cruz",
  "poster_id": "user-uuid",
  "item_name": "Wallet",
  "item_description": "Black leather wallet with ID",
  "item_type": "found",
  "item_image_url": "https://.../items/wallet.jpg",
  "category": "Accessories",
  "last_seen_at": "2026-03-01T10:15:00.000Z",
  "last_seen_location": "Main Building > Lobby",
  "submission_date": "2026-03-01T10:15:00.000Z",
  "post_status": "accepted",
  "item_status": "unclaimed",
  "accepted_by_staff_name": "Staff Name",
  "accepted_by_staff_email": "staff@umak.edu.ph",
  "claim_id": null,
  "claimed_by_name": null,
  "claimed_by_email": null,
  "claim_processed_by_staff_id": null,
  "accepted_on_date": "2026-03-02T09:00:00.000Z",
  "is_anonymous": false,
  "linked_lost_item_id": null,
  "returned_at_local": null
}
```

**GET `/posts/user/:userId`**
Purpose: Fetch posts created by a user (self or staff).

Sample response:
```json
{
  "posts": [
    {
      "post_id": 123,
      "item_id": "item-uuid",
      "poster_name": "Juan Dela Cruz",
      "poster_id": "user-uuid",
      "item_name": "Wallet",
      "item_description": "Black leather wallet with ID",
      "item_type": "found",
      "item_image_url": "https://.../items/wallet.jpg",
      "category": "Accessories",
      "last_seen_at": "2026-03-01T10:15:00.000Z",
      "last_seen_location": "Main Building > Lobby",
      "submission_date": "2026-03-01T10:15:00.000Z",
      "post_status": "pending",
      "item_status": "unclaimed",
      "accepted_by_staff_name": null,
      "accepted_by_staff_email": null,
      "claim_id": null,
      "claimed_by_name": null,
      "claimed_by_email": null,
      "claim_processed_by_staff_id": null,
      "accepted_on_date": null,
      "is_anonymous": false
    }
  ],
  "count": 1
}
```

**POST `/posts`**
Purpose: Create a new post (authenticated).

Sample payload:
```json
{
  "p_item_name": "Wallet",
  "p_item_description": "Black leather wallet",
  "p_item_type": "found",
  "p_image_hash": "sha256:...",
  "p_category": "Accessories",
  "p_date_day": 1,
  "p_date_month": 3,
  "p_date_year": 2026,
  "p_time_hour": 10,
  "p_time_minute": 15,
  "p_location_path": [
    { "name": "Main Building", "type": "building" },
    { "name": "Lobby", "type": "area" }
  ],
  "p_is_anonymous": false
}
```

Sample response:
```json
{ "post_id": 123 }
```

**PUT `/posts/:id`**
Purpose: Edit a post (owner or staff).

Sample payload:
```json
{
  "p_item_name": "Wallet",
  "p_item_description": "Black leather wallet with ID",
  "p_item_type": "found",
  "p_category": "Accessories",
  "p_date_day": 1,
  "p_date_month": 3,
  "p_date_year": 2026,
  "p_time_hour": 10,
  "p_time_minute": 15,
  "p_location_path": [
    { "name": "Main Building", "type": "building" },
    { "name": "Lobby", "type": "area" }
  ],
  "p_is_anonymous": false
}
```

Sample response:
```json
{ "success": true, "post_id": 123 }
```

**DELETE `/posts/:id`**
Purpose: Delete a post.

Sample response:
```json
{ "success": true }
```

**PUT `/posts/:id/status`**
Purpose: Update a post status (staff only).

Sample payload:
```json
{ "status": "accepted", "rejection_reason": null }
```

Sample response:
```json
{ "success": true }
```

**PUT `/posts/:id/staff-assignment`**
Purpose: Assign staff to a post (staff only).

Sample payload:
```json
{ "staff_id": "staff-uuid" }
```

Sample response:
```json
{ "success": true }
```

**PUT `/posts/items/:id/status`**
Purpose: Update item status (staff only).

Sample payload:
```json
{ "status": "claimed" }
```

Sample response:
```json
{ "success": true }
```

**PUT `/posts/:id/edit-with-image`**
Purpose: Edit a post and optionally replace the image (authenticated).

Sample payload:
```json
{
  "p_item_name": "Wallet",
  "p_item_description": "Black leather wallet",
  "p_item_type": "found",
  "p_image_hash": "sha256:new",
  "p_image_link": "https://.../items/new-image.jpg",
  "p_last_seen_date": "2026-03-01",
  "p_last_seen_hours": 10,
  "p_last_seen_minutes": 15,
  "p_location_path": [
    { "name": "Main Building", "type": "building" }
  ],
  "p_item_status": "unclaimed",
  "p_category": "Accessories",
  "p_post_status": "pending",
  "p_is_anonymous": false
}
```

Sample response:
```json
{ "success": true, "post_id": 123 }
```

---

## Claims

**POST `/claims/process`**
Purpose: Process a claim linking a found item to a missing item (staff only).

Sample payload:
```json
{
  "found_post_id": 123,
  "missing_post_id": 456,
  "claim_details": {
    "claimer_name": "Juan Dela Cruz",
    "claimer_school_email": "juan@umak.edu.ph",
    "claimer_contact_num": "09171234567",
    "poster_name": "Maria Santos",
    "staff_id": "staff-uuid",
    "staff_name": "Staff Name"
  }
}
```

Sample response:
```json
{ "success": true, "claim_id": "claim-uuid" }
```

**GET `/claims/by-item/:itemId`**
Purpose: Check whether an item already has a claim (staff only).

Sample response:
```json
{
  "exists": true,
  "claim": {
    "claim_id": "claim-uuid",
    "claimer_name": "Juan Dela Cruz",
    "claimer_email": "juan@umak.edu.ph",
    "claimed_at": "2026-03-01T10:15:00.000Z"
  }
}
```

**GET `/claims/by-item/:itemId/full`**
Purpose: Fetch minimal claim detail for an item (staff only).

Sample response:
```json
{ "claim": { "claim_id": "claim-uuid", "linked_lost_item_id": "item-uuid" } }
```

**DELETE `/claims/:id`**
Purpose: Delete a claim by claim ID (staff only).

Sample response:
```json
{ "success": true }
```

**DELETE `/claims/by-item/:itemId`**
Purpose: Delete a claim by item ID and reset linked missing item status (staff only).

Sample response:
```json
{ "success": true }
```

---

## Fraud Reports

**GET `/fraud-reports/check-duplicates`**
Purpose: Check if a user (or other users) already reported a post.

Sample request:
```http
GET /fraud-reports/check-duplicates?post_id=123&user_id=user-uuid&concern=Spam
```

Sample response:
```json
{
  "has_duplicate_self": false,
  "has_duplicate_others": true
}
```

**POST `/fraud-reports`**
Purpose: Create a fraud report (authenticated).

Sample payload:
```json
{
  "post_id": 123,
  "reason": "Suspicious claim",
  "proof_image_url": "https://.../proof.jpg",
  "reported_by": null,
  "claim_id": "claim-uuid",
  "claimer_name": "Juan Dela Cruz",
  "claimer_school_email": "juan@umak.edu.ph",
  "claimer_contact_num": "09171234567",
  "claimed_at": "2026-03-01T10:15:00.000Z",
  "claim_processed_by_staff_id": "staff-uuid"
}
```

Sample response:
```json
{ "success": true, "report_id": "report-uuid" }
```

**GET `/fraud-reports/:id`**
Purpose: Fetch a single fraud report (staff only).

Sample response:
```json
{
  "report_id": "report-uuid",
  "post_id": 123,
  "reason": "Suspicious claim",
  "status": "open",
  "created_at": "2026-03-01T10:15:00.000Z",
  "reporter": {
    "user_id": "user-uuid",
    "user_name": "Juan Dela Cruz",
    "email": "juan@umak.edu.ph",
    "profile_picture_url": "https://.../profile.jpg",
    "user_type": "User",
    "notification_token": null
  },
  "poster": {
    "user_id": "poster-uuid",
    "user_name": "Maria Santos",
    "email": "maria@umak.edu.ph",
    "profile_picture_url": "https://.../profile2.jpg",
    "user_type": "User",
    "notification_token": null
  },
  "claim_info": {
    "claim_id": "claim-uuid",
    "claimer_name": "Juan Dela Cruz",
    "claimer_school_email": "juan@umak.edu.ph",
    "claimer_contact_num": "09171234567"
  },
  "item_info": {
    "item_id": "item-uuid",
    "item_name": "Wallet",
    "category": "Accessories"
  }
}
```

**GET `/fraud-reports`**
Purpose: List fraud reports with pagination or by IDs (staff only).

Sample request:
```http
GET /fraud-reports?limit=20&offset=0&sort=desc
```

Sample response:
```json
{
  "reports": [
    {
      "report_id": "report-uuid",
      "post_id": 123,
      "reason": "Suspicious claim",
      "status": "open",
      "created_at": "2026-03-01T10:15:00.000Z",
      "reporter": {
        "user_id": "user-uuid",
        "user_name": "Juan Dela Cruz",
        "email": "juan@umak.edu.ph",
        "profile_picture_url": "https://.../profile.jpg",
        "user_type": "User",
        "notification_token": null
      },
      "poster": {
        "user_id": "poster-uuid",
        "user_name": "Maria Santos",
        "email": "maria@umak.edu.ph",
        "profile_picture_url": "https://.../profile2.jpg",
        "user_type": "User",
        "notification_token": null
      },
      "claim_info": {
        "claim_id": "claim-uuid",
        "claimer_name": "Juan Dela Cruz"
      },
      "item_info": {
        "item_id": "item-uuid",
        "item_name": "Wallet"
      }
    }
  ],
  "count": 1
}
```

**GET `/fraud-reports/:id/status`**
Purpose: Get a fraud report status (staff only).

Sample response:
```json
{ "report_status": "open" }
```

**PUT `/fraud-reports/:id/status`**
Purpose: Update a fraud report status (staff only).

Sample payload:
```json
{ "status": "under_review", "processed_by_staff_id": "staff-uuid" }
```

Sample response:
```json
{ "success": true }
```

**POST `/fraud-reports/:id/resolve`**
Purpose: Resolve a fraud report via RPC (staff only).

Sample payload:
```json
{ "delete_claim": false }
```

Sample response:
```json
{ "success": true, "data": { "resolved": true } }
```

**DELETE `/fraud-reports/:id`**
Purpose: Delete a fraud report (staff only).

Sample response:
```json
{ "success": true }
```

---

## Search

**POST `/search/items`**
Purpose: Full-text search for users (authenticated).

Sample payload:
```json
{
  "query": "black wallet",
  "limit": 20,
  "last_seen_date": "2026-03-01",
  "category": ["Accessories"],
  "location_last_seen": "Main Building",
  "claim_from": "2026-02-01",
  "claim_to": "2026-03-01",
  "item_status": ["unclaimed"],
  "sort": "submission_date",
  "sort_direction": "desc"
}
```

Sample response:
```json
{ "results": [{ "post_id": 123, "item_name": "Wallet" }] }
```

**POST `/search/items/staff`**
Purpose: Full-text search for staff.

Sample payload:
```json
{
  "query": "black wallet",
  "limit": 20,
  "last_seen_date": "2026-03-01",
  "category": ["Accessories"],
  "location_last_seen": "Main Building",
  "claim_from": "2026-02-01",
  "claim_to": "2026-03-01",
  "item_status": ["unclaimed"],
  "sort": "accepted_on_date",
  "sort_direction": "desc"
}
```

Sample response:
```json
{ "results": [{ "post_id": 123, "item_name": "Wallet" }] }
```

**POST `/search/match-missing-item`**
Purpose: Find matching found items for a missing post (staff only).

Sample payload:
```json
{ "post_id": "456" }
```

Sample response:
```json
{
  "success": true,
  "matches": [
    {
      "post_id": 123,
      "item_type": "found",
      "item_name": "Wallet",
      "category": "Accessories"
    }
  ],
  "missing_post": {
    "post_id": 456,
    "item_type": "missing",
    "item_name": "Wallet",
    "category": "Accessories"
  },
  "total_matches": 1
}
```

---

## Notifications

**POST `/notifications/send`**
Purpose: Create and send a notification to a user (staff only).

Sample payload:
```json
{
  "user_id": "user-uuid",
  "title": "Item Update",
  "body": "Your item has been marked as claimed",
  "description": "Please visit the office to claim it.",
  "type": "item_status",
  "data": { "post_id": 123, "item_id": "item-uuid" },
  "image_url": "https://.../items/wallet.jpg"
}
```

Sample response:
```json
{ "success": true, "notification_id": "notif-uuid" }
```

**GET `/notifications`**
Purpose: List the current user notifications.

Sample response:
```json
{
  "notifications": [
    {
      "notification_id": 1,
      "user_id": "user-uuid",
      "title": "Item Update",
      "body": "Your item has been marked as claimed",
      "type": "item_status",
      "is_read": false,
      "created_at": "2026-03-01T10:15:00.000Z",
      "image_url": "https://.../items/wallet.jpg"
    }
  ]
}
```

**GET `/notifications/count`**
Purpose: Get unread notification count.

Sample response:
```json
{ "unread_count": 3 }
```

**PATCH `/notifications/:id/read`**
Purpose: Mark a notification as read.

Sample response:
```json
{ "success": true }
```

**DELETE `/notifications/:id`**
Purpose: Delete a notification.

Sample response:
```json
{ "success": true }
```

---

## Announcements

**POST `/announcements/send`**
Purpose: Send a global announcement (staff only).

Sample payload:
```json
{
  "user_id": "staff-uuid",
  "message": "System maintenance at 6 PM",
  "description": "Expect brief downtime.",
  "image_url": "https://.../announcements/maintenance.jpg"
}
```

Sample response:
```json
{ "success": true }
```

**GET `/announcements`**
Purpose: List announcements with pagination.

Sample request:
```http
GET /announcements?limit=20&offset=0
```

Sample response:
```json
{
  "announcements": [
    {
      "id": 1,
      "created_at": "2026-03-01T10:15:00.000Z",
      "message": "System maintenance at 6 PM",
      "description": "Expect brief downtime.",
      "image_url": "https://.../announcements/maintenance.jpg"
    }
  ],
  "count": 1
}
```

---

## Jobs (System Token)

**POST `/jobs/metadata-batch`**
Purpose: Generate metadata for items missing metadata.

Sample request:
```http
POST /jobs/metadata-batch
Authorization: Bearer <SYSTEM_TOKEN>
```

Sample response:
```json
{
  "processed": 10,
  "succeeded": 9,
  "failed": 1,
  "results": [
    { "item_id": "item-uuid", "success": true, "error": null },
    { "item_id": "item-uuid-2", "success": false, "error": "Timeout" }
  ]
}
```

**POST `/jobs/pending-match`**
Purpose: Trigger pending match processing (placeholder).

Sample request:
```http
POST /jobs/pending-match
Authorization: Bearer <SYSTEM_TOKEN>
```

Sample response:
```json
{
  "total_pending": 12,
  "processed": 0,
  "failed": 0,
  "remaining": 12,
  "timed_out": false,
  "rate_limit_stopped": false
}
```

---

## Storage

**POST `/storage/upload-url`**
Purpose: Generate a signed upload URL for storage.

Sample payload:
```json
{
  "bucket": "items",
  "fileName": "wallet.jpg",
  "contentType": "image/jpeg"
}
```

Sample response:
```json
{
  "signedUrl": "https://...",
  "path": "items/2026/03/wallet.jpg",
  "token": "..."
}
```

**POST `/storage/confirm-upload`**
Purpose: Confirm an upload has completed.

Sample payload:
```json
{ "bucket": "items", "objectPath": "items/2026/03/wallet.jpg" }
```

Sample response:
```json
{ "success": true, "publicUrl": "https://.../wallet.jpg" }
```

**DELETE `/storage`**
Purpose: Delete a storage object (staff only).

Sample payload:
```json
{ "bucket": "items", "objectPath": "items/2026/03/wallet.jpg" }
```

Sample response:
```json
{ "success": true }
```

---

## Users

**GET `/users/:id`**
Purpose: Fetch a user profile (staff only).

Sample response:
```json
{
  "user_id": "user-uuid",
  "user_name": "Juan Dela Cruz",
  "email": "juan@umak.edu.ph",
  "profile_picture_url": "https://.../profile.jpg",
  "user_type": "User"
}
```

**GET `/users/search`**
Purpose: Search users by name or email (staff/admin only).

Sample request:
```http
GET /users/search?query=juan
```

Sample response:
```json
{
  "results": [
    {
      "user_id": "user-uuid",
      "user_name": "Juan Dela Cruz",
      "email": "juan@umak.edu.ph",
      "profile_picture_url": "https://.../profile.jpg",
      "user_type": "User",
      "notification_token": null
    }
  ]
}
```

---

## Admin

**GET `/admin/users`**
Purpose: List users filtered by role (admin only).

Sample request:
```http
GET /admin/users?user_type=User,Staff
```

Sample response:
```json
{
  "users": [
    {
      "user_id": "user-uuid",
      "user_name": "Staff Name",
      "email": "staff@umak.edu.ph",
      "profile_picture_url": "https://.../profile.jpg",
      "user_type": "Staff"
    }
  ]
}
```

**PUT `/admin/users/:id/role`**
Purpose: Update a user's role (admin only).

Sample payload:
```json
{ "role": "Staff", "previous_role": "User" }
```

Sample response:
```json
{ "success": true }
```

**GET `/admin/dashboard-stats`**
Purpose: Return dashboard stats (admin only).

Sample response:
```json
{
  "pending_verifications": 2,
  "pending_fraud_reports": 1,
  "claimed_count": 12,
  "unclaimed_count": 7,
  "to_review_count": 3,
  "lost_count": 4,
  "returned_count": 5,
  "reported_count": 1
}
```

**POST `/admin/audit-logs`**
Purpose: Insert an audit log entry (staff only).

Sample payload:
```json
{
  "user_id": "staff-uuid",
  "action": "update",
  "table_name": "post_table",
  "record_id": "123",
  "changes": { "post_status": "accepted", "accepted_on_date": "2026-03-02T09:00:00.000Z" }
}
```

Sample response:
```json
{ "success": true, "audit_id": "audit-uuid" }
```

**GET `/admin/audit-logs`**
Purpose: List audit logs (admin only).

Sample request:
```http
GET /admin/audit-logs?limit=20&offset=0
```

Sample response:
```json
{
  "logs": [
    {
      "audit_id": "audit-uuid",
      "timestamp": "2026-03-01T10:15:00.000Z",
      "action": "update",
      "table_name": "post_table",
      "record_id": "123",
      "changes": { "post_status": "accepted" },
      "user_table": {
        "user_id": "staff-uuid",
        "user_name": "Staff Name",
        "email": "staff@umak.edu.ph"
      }
    }
  ]
}
```

**GET `/admin/audit-logs/:id`**
Purpose: Fetch a single audit log (admin only).

Sample response:
```json
{
  "audit_id": "audit-uuid",
  "timestamp": "2026-03-01T10:15:00.000Z",
  "action": "update",
  "table_name": "post_table",
  "record_id": "123",
  "changes": { "post_status": "accepted" },
  "user_table": {
    "user_id": "staff-uuid",
    "user_name": "Staff Name",
    "email": "staff@umak.edu.ph"
  }
}
```

**GET `/admin/audit-logs/user/:userId`**
Purpose: List audit logs for a user (staff only).

Sample request:
```http
GET /admin/audit-logs/user/user-uuid?limit=20&offset=0
```

Sample response:
```json
{
  "logs": [
    {
      "audit_id": "audit-uuid",
      "timestamp": "2026-03-01T10:15:00.000Z",
      "action": "update",
      "table_name": "post_table",
      "record_id": "123",
      "changes": { "post_status": "accepted" },
      "user_table": {
        "user_id": "staff-uuid",
        "user_name": "Staff Name",
        "email": "staff@umak.edu.ph"
      }
    }
  ]
}
```

**GET `/admin/audit-logs/action/:actionType`**
Purpose: List audit logs by action (admin only).

Sample request:
```http
GET /admin/audit-logs/action/update?limit=20&offset=0
```

Sample response:
```json
{
  "logs": [
    {
      "audit_id": "audit-uuid",
      "timestamp": "2026-03-01T10:15:00.000Z",
      "action": "update",
      "table_name": "post_table",
      "record_id": "123",
      "changes": { "post_status": "accepted" },
      "user_table": {
        "user_id": "staff-uuid",
        "user_name": "Staff Name",
        "email": "staff@umak.edu.ph"
      }
    }
  ]
}
```

**GET `/admin/stats/weekly`**
Purpose: Weekly stats for charts (admin only).

Sample response:
```json
{
  "weeks": ["Feb 2", "Feb 9"],
  "series": {
    "missing": [3, 2],
    "found": [5, 6],
    "reports": [1, 0],
    "pending": [2, 1]
  }
}
```

**GET `/admin/stats/export`**
Purpose: Export data for CSV (admin only).

Sample request:
```http
GET /admin/stats/export?start_date=2026-02-01&end_date=2026-02-29
```

Sample response:
```json
{
  "rows": [
    {
      "poster_name": "Juan Dela Cruz",
      "item_name": "Wallet",
      "item_description": "Black leather wallet",
      "last_seen_location": "Main Building",
      "accepted_by_staff_name": "Staff Name",
      "submission_date": "2026-02-10T10:15:00.000Z",
      "claimed_by_name": "Maria Santos",
      "claimed_by_email": "maria@umak.edu.ph",
      "accepted_on_date": "2026-02-11T09:00:00.000Z"
    }
  ]
}
```

---

## Items

**GET `/items/:id`**
Purpose: Fetch item details (staff only).

Sample response:
```json
{
  "item_id": "item-uuid",
  "item_name": "Wallet",
  "item_description": "Black leather wallet",
  "item_type": "found",
  "category": "Accessories",
  "item_status": "unclaimed",
  "item_metadata": { "brand": "Generic", "color": "Black" }
}
```

**PUT `/items/:id/metadata`**
Purpose: Update item metadata (staff only).

Sample payload:
```json
{ "item_metadata": { "brand": "Generic", "color": "Black" } }
```

Sample response:
```json
{ "success": true }
```

---

## Pending Matches

**POST `/pending-matches`**
Purpose: Add a post to the pending match retry queue (staff only).

Sample payload:
```json
{
  "post_id": 123,
  "poster_id": "user-uuid",
  "status": "queued",
  "is_retriable": true,
  "failed_reason": "Rate limit hit"
}
```

Sample response:
```json
{ "success": true, "id": 1 }
```

**GET `/pending-matches`**
Purpose: List pending matches (staff only).

Sample request:
```http
GET /pending-matches?limit=20&offset=0&status=queued
```

Sample response:
```json
{
  "pending_matches": [
    {
      "id": 1,
      "post_id": 123,
      "poster_id": "user-uuid",
      "status": "queued",
      "is_retriable": true,
      "failed_reason": null,
      "created_at": "2026-03-01T10:15:00.000Z"
    }
  ],
  "count": 1
}
```

**PUT `/pending-matches/:id/status`**
Purpose: Update a pending match status (staff only).

Sample payload:
```json
{ "status": "resolved" }
```

Sample response:
```json
{ "success": true }
```

---

## Email

**POST `/email/send`**
Purpose: Send an email via Resend (staff only).

Sample payload:
```json
{
  "to": "recipient@umak.edu.ph",
  "subject": "Item Claim Update",
  "html": "<p>Your item is ready for pickup.</p>",
  "senderUuid": "staff-uuid",
  "from": "UMak LINK <noreply@umaklink.com>"
}
```

Sample response:
```json
{ "success": true, "message": "Email sent successfully", "to": "recipient@umak.edu.ph" }
```
