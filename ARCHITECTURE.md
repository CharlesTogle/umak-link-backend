# Backend Architecture

## Overview
`umak-link-backend` is a Fastify BFF that centralizes:
- Authentication and authorization
- Supabase data/storage access
- AI orchestration (Gemini)
- Notification and email delivery

The API is organized by domain routes and thin transport handlers that delegate to services.

## Runtime Layers
1. Entry Layer (`src/index.ts`)
- Bootstraps Fastify, security plugins, CORS, rate limit, and route registration.

2. Route Layer (`src/routes/**`)
- Owns HTTP schemas, request parsing, and response shape.
- Delegates business operations to services or Supabase RPCs.

3. Middleware Layer (`src/middleware/**`)
- `requireAuth`, `requireStaff`, and `requireAdmin` enforce role-based access.
- Global error handler standardizes API error responses.

4. Service Layer (`src/services/**`)
- `supabase.ts`: typed Supabase client with timeout-safe fetch.
- `storage.ts`: signed upload/confirm/delete with WebP enforcement.
- `gemini.ts`: Gemini orchestration, token-bucket rate limiting, retry queue.
- `notifications.ts`: push + database notifications.

5. Type Layer (`src/types/**`)
- Shared route contracts and Fastify request augmentation.

## Request Flow (Create Post + AI Autofill)
1. Web client requests `POST /ai/create-post-autofill` with image data URL.
2. `routes/ai.ts` validates payload and calls `services/gemini.ts`.
3. Gemini returns structured draft content (`itemName`, `itemDescription`, `itemCategory`).
4. Web client compresses image to WebP and uploads via:
- `POST /storage/upload-url`
- direct `PUT` to signed URL
- `POST /storage/confirm-upload`
5. Web client creates post via `POST /posts`.
6. Post/item metadata and status workflows continue through existing jobs and staff flows.

## Security and Guardrails
- JWT auth required for protected routes.
- Staff/admin guards for privileged operations.
- WebP-only upload policy enforced server-side.
- Global rate limit on API + token-bucket rate limit in Gemini service.
- Centralized timeout wrapper for outbound calls.

## Route Domains
- `auth`, `posts`, `claims`, `fraud-reports`, `search`, `notifications`
- `announcements`, `storage`, `users`, `admin`, `items`, `pending-matches`
- `jobs` (system-triggered)
- `ai` (Gemini-powered user-facing AI actions)
