# Alpha AI · Wan 2.2 integration

This branch contains the first implementation slice for image-to-video generation with Alpha AI's `video-wan22` model.

## Verified provider contract

- API base: `https://api.appalpha.ir/v1`
- Create: `POST /generations`
- Status: `GET /generations/{id}`
- Progress: `GET /generations/{id}/progress`
- Model: `video-wan22`
- Request fields: `model`, `image`, `prompt`, optional `cinematic`
- Provider price shown in Alpha docs: 5,000 toman per successful video.
- Provider input accepts a public URL, data URI, or base64; max file size 40 MB.
- Provider generation can take up to 25 minutes. Poll status every 3–5 seconds; progress is optional and may be null.
- Alpha's output URL is temporary. LOKAL AI copies the validated MP4 (up to the existing 50 MB private-bucket limit) to its own private Storage bucket immediately.

Official docs: https://api.appalpha.ir/docs

## Files in this implementation

- `supabase/functions/armex-api/alpha-video-api.ts`: authenticated create/status/history API.
- `supabase/functions/alpha-video-worker/index.ts`: one short worker tick per invocation; submits new jobs, polls existing jobs, validates and saves MP4 output.
- `modules/video/video-studio.js`: browser upload, job submission, status tracking, and private video history.
- `docs/alpha-video/alpha-video-schema-draft.sql`: schema/RPC draft. It is intentionally not a production migration.

## Required server configuration (not set by this code change)

1. `ALPHA_API_KEY`: Alpha provider key. Worker-only secret.
2. `ALPHA_VIDEO_WORKER_SECRET`: independent random secret checked by the worker.
3. `ALPHA_VIDEO_CREDIT_COST`: positive integer in LOKAL AI credits. There is deliberately no default: Alpha's 5,000-toman provider price is not automatically equal to 5,000 LOKAL credits.
4. `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`: standard server-side Supabase environment values for the worker. Never expose either secret to the browser.

## Database preparation required before deployment

The SQL file in this folder is a review draft, not an applied migration. Before it can be used:

1. On a local checkout, create the migration through the Supabase CLI (`supabase migration new alpha_video_jobs`).
2. Move the reviewed SQL into the generated timestamped migration.
3. Review it against the live Production schema and Supabase security advisors.
4. Obtain explicit approval before applying the migration to Production.

The draft adds `public.armex_video_generations` with RLS enabled with service-role-only table access, API-enforced owner scoping, and a unique per-user request ID. The existing private bucket has a 50 MB object limit; no bucket setting is changed., atomic wallet debit/job creation, worker leases, safe terminal refund, and chat-message/attachment persistence. It uses the existing private `lokal-chat-media` bucket and does not create or modify buckets.

## Worker scheduling required before live processing

No scheduler is configured by this code change. Invoke the deployed Edge Function `alpha-video-worker` from a trusted external scheduler about every 5 seconds:

- URL: `https://<project-ref>.supabase.co/functions/v1/alpha-video-worker`
- Method: POST
- `apikey`: Supabase service-role key
- `Authorization`: `Bearer <service-role-key>` (for the Supabase Edge gateway)
- `x-worker-secret`: same value as `ALPHA_VIDEO_WORKER_SECRET`
- JSON body: `{}`

Keep all keys in the scheduler's secret store. Do not use a browser or public client to invoke the worker.

Each invocation claims at most one due job and exits quickly. Repeated invocations resume the provider job after the user closes the app. The function does not keep a single request alive for the 25-minute provider generation.

## Billing and failure safety

- LOKAL AI credit cost is a required server setting; no rate conversion is assumed.
- Job creation and LOKAL wallet debit occur in one database transaction through `armex_create_video_job`.
- A definite provider rejection or invalid output marks the job failed and refunds the reserved LOKAL credits through an idempotent ledger key.
- A timeout or ambiguous response to Alpha's POST is marked `submission_unknown`. The worker does not submit again because the provider docs do not establish an idempotency-key contract. Reconcile against Alpha's request list before any manual retry.
- A successful provider output is downloaded, checked for MP4 signature and size, stored privately, and attached to an assistant message in the related conversation.
- The provider's temporary output URL is never returned to the browser; the API issues a short-lived signed URL from LOKAL Storage.

## Not performed

No Production migration, Edge Function deployment, secret creation, scheduler setup, Worker activation, payment, Alpha request, credit consumption, PR creation, or merge was performed by this implementation.
