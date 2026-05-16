# UMak-LINK Backend (Fastify BFF)

Backend-for-Frontend (BFF) API server for the UMak-LINK lost-and-found system. Built with Fastify, TypeScript, and Supabase.

## Architecture

This backend serves as a Backend-for-Frontend (BFF) that:
- Centralizes all Supabase access with service role key (server-side only)
- Manages Google OAuth authentication and JWT sessions
- Handles Gemini AI operations server-side
- Provides Firebase Cloud Messaging (FCM) push notifications
- Controls file uploads to Supabase Storage

## Tech Stack

- **Runtime**: Node.js 20+
- **Framework**: Fastify 5
- **Database**: Supabase (PostgreSQL 17)
- **Auth**: Google OAuth + JWT
- **AI**: Google Gemini API
- **Notifications**: Firebase Admin SDK
- **Language**: TypeScript

## Getting Started

### Prerequisites

- Node.js 20 or higher
- npm or pnpm
- Supabase project with service role key
- Google OAuth Client ID
- Gemini API key (optional, for AI features)
- Firebase service account (optional, for push notifications)

### Installation

```bash
# Install dependencies
npm install

# Copy environment variables
cp .env.example .env

# Edit .env with your configuration
nano .env
```

### Development

```bash
# Run in development mode with hot reload
npm run dev

# Type checking
npm run typecheck

# Lint
npm run lint

# Format code
npm run format
```

### Build

```bash
# Build TypeScript
npm run build

# Run production build
npm start
```

### Docker

```bash
# Build image
docker build -t umak-link-backend .

# Run container
docker run -p 8080:8080 --env-file .env umak-link-backend
```

## API Endpoints

### Authentication
- `POST /auth/google` - Login with Google ID token
- `GET /auth/me` - Get current user profile

### Posts & Items
- `GET /posts/public` - List all public posts
- `GET /posts/:id` - Get single post
- `GET /posts/:id/full` - Get full post details (staff only)
- `POST /posts` - Create new post
- `PUT /posts/:id` - Edit post
- `DELETE /posts/:id` - Delete post
- `PUT /posts/:id/status` - Update post status (staff)
- `PUT /items/:id/status` - Update item status (staff)

### Claims
- `POST /claims/process` - Process item claim (staff)
- `GET /claims/by-item/:itemId` - Check existing claim (staff)

### Fraud Reports
- `POST /fraud-reports` - Create fraud report
- `GET /fraud-reports` - List fraud reports (staff)
- `PATCH /fraud-reports/:id/status` - Update status (staff)
- `POST /fraud-reports/:id/resolve` - Resolve report (staff)

### Search
- `POST /search/items` - User search
- `POST /search/items/staff` - Staff search with filters

### Notifications
- `POST /notifications/send` - Send notification (staff)
- `GET /notifications` - List user notifications
- `GET /notifications/count` - Unread count
- `PATCH /notifications/:id/read` - Mark as read
- `DELETE /notifications/:id` - Delete notification

### Announcements
- `POST /announcements/send` - Send global announcement (staff)
- `GET /announcements` - List announcements

### Storage
- `POST /storage/upload-url` - Generate signed upload URL
- `POST /storage/confirm-upload` - Confirm upload
- `DELETE /storage` - Delete storage object (staff)

### Users
- `GET /users/search` - Search users (staff/admin)

### Admin
- `GET /admin/dashboard-stats` - Dashboard statistics (admin)
- `POST /admin/audit-logs` - Insert audit log (staff)
- `GET /admin/audit-logs` - List audit logs (admin)

### Custody
- `GET /custody/guard-posts` - List active guard posts for student handover
- `POST /custody/attempts` - Start a student custody handover session
- `GET /custody/sessions/:qrCodeSessionId/status` - Poll live custody session state
- `POST /custody/sessions/:qrCodeSessionId/retry` - Retry QR issuance inside the same session
- `POST /custody/sessions/:qrCodeSessionId/cancel` - Cancel the current student handover session
- `GET /custody/posts/:postId/history` - Read student-facing custody history
- `POST /guard/custody/scan` - Guard scan QR and load handover details
- `POST /guard/custody/attempts/:custodyAttemptId/decision` - Guard accept or reject handover
- `POST /staff/custody/security-office/receive` - Mark item as received in Security Office
- `POST /staff/custody/investigations/open` - Open custody investigation
- `POST /staff/custody/physical-takes/report` - Report physical take without QR acceptance
- `POST /staff/custody/guards/notify` - Create an in-app follow-up notification for the accepted guard

### Background Jobs
- `POST /jobs/metadata-batch` - Generate AI metadata (system)
- `POST /jobs/pending-match` - Match lost/found items (system)
- `POST /jobs/custody/expire-sessions` - Finalize expired custody QR sessions after retry exhaustion
- `POST /jobs/custody/escalate-stale-accepted` - Auto-open investigation for overdue accepted handovers

### AI
- `POST /ai/create-post-autofill` - Generate item title/description/category from image (auth required)

### Health
- `GET /health` - Health check

## Environment Variables

See `.env.example` for required configuration.

**Critical**: Never expose `SUPABASE_SERVICE_ROLE_KEY` to clients!

Custody-related backend variables:

- `SYSTEM_TOKEN`: required for all system job routes
- `CUSTODY_AUTOMATION_STAFF_USER_ID`: required for automated stale accepted custody escalation
- `CUSTODY_STALE_ACCEPTED_ESCALATION_HOURS`: optional, defaults to `48`
- `CUSTODY_QR_TTL_SECONDS`: optional, defaults to `300`
- `CUSTODY_QR_MAX_ATTEMPTS`: optional, defaults to `5`
- `CUSTODY_SESSION_LIMIT_PER_HOUR`: optional, defaults to `2`

## Deployment

### Cloud Run

```bash
# Build and deploy
gcloud run deploy umak-link-backend \
  --source . \
  --platform managed \
  --region asia-southeast1 \
  --allow-unauthenticated \
  --set-env-vars="NODE_ENV=production"
```

Set environment variables in Cloud Run console or via `--env-vars-file`.

### Scheduled Jobs

Scheduled jobs are provisioned through SQL migrations, not copied from this README.

Current custody cron definitions live in:

- [`20260514143000_schedule_custody_stale_accepted_escalation_job.sql`](../UMak-LINK/supabase/migrations/20260514143000_schedule_custody_stale_accepted_escalation_job.sql)

The stale-accepted custody escalation job depends on:

- Supabase Vault secret `umak_link_backend_system_token`
- backend env `CUSTODY_AUTOMATION_STAFF_USER_ID`
- deployed backend route `https://umak-link-backend.onrender.com/jobs/custody/escalate-stale-accepted`

## Security

- All sensitive keys (Supabase service role, Gemini API) stay server-side
- JWT tokens expire after 7 days by default
- Role-based access control (User/Staff/Admin)
- Rate limiting enabled (100 req/min per IP)
- CORS configured (update `ALLOWED_ORIGINS` for production)
- Helmet.js security headers

## Troubleshooting

### Firebase Push Notifications

**Error**: "Service account object must contain a string 'private_key' property"

**Cause**: The `FIREBASE_SERVICE_ACCOUNT` environment variable is missing, malformed, or incomplete.

**Solution**:

1. Go to [Firebase Console](https://console.firebase.google.com/)
2. Select your project
3. Go to Project Settings (gear icon) > Service Accounts
4. Click "Generate New Private Key"
5. Download the JSON file
6. Convert it to a single-line JSON string:

```bash
# On Linux/Mac
cat firebase-service-account.json | jq -c . | sed 's/"/\\"/g'

# Or manually ensure it's valid JSON on one line
```

7. Set in `.env`:
```bash
FIREBASE_SERVICE_ACCOUNT='{"type":"service_account","project_id":"your-project-id","private_key_id":"...","private_key":"-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n","client_email":"...@...iam.gserviceaccount.com","client_id":"...","auth_uri":"https://accounts.google.com/o/oauth2/auth","token_uri":"https://oauth2.googleapis.com/token","auth_provider_x509_cert_url":"https://www.googleapis.com/oauth2/v1/certs","client_x509_cert_url":"..."}'
```

Do not paste the JSON as a raw multi-line object directly after `FIREBASE_SERVICE_ACCOUNT=`. With `dotenv`, that form gets truncated and the app only receives `{`.

**Required fields**:
- `type`: Must be "service_account"
- `project_id`: Your Firebase project ID
- `private_key`: The RSA private key (must contain "-----BEGIN PRIVATE KEY-----")
- `client_email`: Service account email

**Note**: The private key contains `\n` characters for newlines - these must be preserved in the JSON string.

### Common Issues

**JWT Secret Not Set**
- Ensure `JWT_SECRET` is a strong random string (use `openssl rand -base64 32`)

**CORS Errors**
- Update `ALLOWED_ORIGINS` to match your frontend URL(s) (comma-separated)
- Example: `ALLOWED_ORIGINS=https://app.example.com,https://www.example.com`

**Supabase Connection Failed**
- Verify `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`
- Check if your IP is allowed in Supabase dashboard

## License

ISC
