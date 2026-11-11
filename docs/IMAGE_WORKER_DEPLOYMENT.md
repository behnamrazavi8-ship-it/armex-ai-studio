# LOKAL AI Medium Image Worker

This branch adds an asynchronous image-generation worker. It is designed for the planned Weblines **Medium** service (2 vCPU, 4 GB RAM, 20 GB disk). It does not execute model weights locally; it coordinates jobs and calls the configured Cloudflare Workers AI REST endpoint.

## Architecture

1. The authenticated `armex-api` Edge Function validates the user session.
2. `armex_enqueue_image_generation` atomically reserves credits, inserts the image-generation row, and inserts the durable job row in one Postgres transaction.
3. The worker claims jobs through a service-role-only RPC using `FOR UPDATE SKIP LOCKED`.
4. A 180-second lease and heartbeat prevent two live workers from owning the same job. Expired leases are reclaimed.
5. Transient provider/storage errors use bounded exponential backoff. Exhausted or terminal failures are marked failed and refunded using one stable idempotency key per job.
6. The frontend receives a job ID and polls the authenticated status endpoint. Only the owner can read the job through the Edge Function.

The database job table is authoritative. The worker is intentionally single-concurrency by default; increase concurrency only after observing provider limits and memory use.

## Required environment variables

Configure these as **server-side secrets** in the Weblines service. Never add them to GitHub, frontend config, chat messages, or build arguments.

| Variable | Purpose |
| --- | --- |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service-role secret; server-side only |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID |
| `CLOUDFLARE_API_TOKEN` | Cloudflare API token with the required Workers AI run permission |

Optional:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8080` | Health endpoint port |
| `WORKER_POLL_MS` | `2500` | Idle queue polling interval (clamped to 1–15 seconds) |

## Container

The repository-root `Dockerfile` builds the worker from `worker/`. Runtime command is `npm start`. Expose port `8080`; configure the platform health check as `GET /health`.

Use the public Git repository and the default branch only after this feature branch has been reviewed and merged. Do not create or start the paid Medium service until the migration and end-to-end tests have passed.

## Database migration

File: `supabase/migrations/20261111010000_lokal_async_image_worker.sql`

The migration creates `armex_image_jobs`, expands image status to include `processing`, and adds enqueue/claim/heartbeat/complete/fail RPCs. It has **not** been applied to the live Supabase project by this branch change.

The RPCs are executable only by `service_role`; the job table has RLS enabled and no client policies. The Edge Function authenticates the user before using the privileged server-side client.

## Deployment sequence (not yet performed)

1. Review the feature branch and validate the SQL migration in a disposable/local Supabase database.
2. Confirm the private Storage bucket `lokal-ai-images` exists and the Cloudflare credentials are ready.
3. Apply the migration to the intended Supabase project.
4. Deploy the updated `armex-api` Edge Function.
5. Build the root Dockerfile and configure the four required runtime secrets on the Medium service.
6. Start one worker instance; confirm `GET /health` and a single end-to-end image job.
7. Test duplicate request IDs, insufficient balance, provider 429/5xx, storage failure, worker restart/lease expiry, retry exhaustion, and exactly-once refund ledger behavior before enabling user traffic.

No production migration, Edge Function deployment, Worker service creation, or paid service activation is performed by this branch.
