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

### Background Jobs
- `POST /jobs/metadata-batch` - Generate AI metadata (system)
- `POST /jobs/pending-match` - Match lost/found items (system)

### AI
- `POST /ai/create-post-autofill` - Generate item title/description/category from image (auth required)

### Health
- `GET /health` - Health check

## Environment Variables

See `.env.example` for required configuration.

**Critical**: Never expose `SUPABASE_SERVICE_ROLE_KEY` to clients!

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

Configure pg_cron in Supabase to trigger background jobs:

```sql
-- Generate metadata every 10 minutes
SELECT cron.schedule(
  'metadata-batch',
  '*/10 * * * *',
  $$SELECT net.http_post(
    url := 'https://your-backend-url/jobs/metadata-batch',
    headers := '{"Authorization": "Bearer YOUR_SYSTEM_TOKEN"}'::jsonb
  )$$
);
```

## Security

- All sensitive keys (Supabase service role, Gemini API) stay server-side
- JWT tokens expire after 7 days by default
- Role-based access control (User/Staff/Admin)
- Rate limiting enabled (100 req/min per IP)
- CORS configured (update `CORS_ORIGIN` for production)
- Helmet.js security headers

## License

ISC
