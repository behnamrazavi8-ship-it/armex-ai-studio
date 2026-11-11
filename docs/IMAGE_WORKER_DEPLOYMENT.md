# LOKAL AI Medium Image Worker

This branch adds an asynchronous image-generation worker. It is designed for the Weblines **Medium Worker** service (2 vCPU, 4 GB RAM, 20 GB disk). This is a CPU coordinator/worker; model inference stays remote on Cloudflare Workers AI and no model weights are loaded locally. It coordinates jobs and calls the configured Cloudflare Workers AI REST endpoint.

## Architecture

1. The authenticated `armex-api` Edge Function validates the user session.
2. `armex_enqueue_image_generation` atomically reserves credits, inserts the image-generation row, and inserts the durable job row in one Postgres transaction.
3. The worker claims jobs through a service-role-only RPC using `FOR UPDATE SKIP LOCKED`.
4. A 180-second lease and heartbeat prevent two live workers from owning the same job. Expired leases are reclaimed.
5. Transient provider/storage errors use bounded exponential backoff. Exhausted or terminal failures are marked failed and refunded using one stable idempotency key per job.
6. The frontend receives a job ID and polls the authenticated status endpoint. Only the owner can read the job through the Edge Function.

The database job table is authoritative. Start with one worker process and one active image job. The worker buffers one provider response (up to the bucket's 20 MiB file limit) in memory. The container caps the V8 heap at 2048 MiB as a guardrail. Idle polling defaults to 2.5 seconds.

## Required environment variables

Configure these as **server-side runtime secrets** on the Weblines Worker service (not in the frontend, GitHub, Docker build args, or chat). Never add them to GitHub, frontend config, chat messages, or build arguments.

| Variable | Purpose |
| --- | --- |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SECRET_KEY` | Supabase secret API key (`sb_secret_...`); server-side only |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID |
| `CLOUDFLARE_API_TOKEN` | Cloudflare API token with Account → Workers AI → Read permission |

The worker accepts the legacy `SUPABASE_SERVICE_ROLE_KEY` only as a temporary fallback. Prefer `SUPABASE_SECRET_KEY` for new deployments; Supabase says the legacy `service_role` API key is scheduled to stop working at the end of 2026.

Optional:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8080` | Health endpoint port |
| `WORKER_POLL_MS` | `2500` | Idle queue polling interval (clamped to 1–15 seconds) |

## Container

The repository-root `Dockerfile` builds the worker from `worker/`. Runtime command is `npm start`. The process also listens on `0.0.0.0:8080` and exposes `GET /health` for local diagnostics. Weblines Worker is a background service without a public URL, so do not configure a public route or domain for it.

Create this as a **Weblines Worker** (background worker), not a public Custom App. Weblines documents Worker sources as Docker Image or public Git repository; this repository is public and contains the root Dockerfile. Keep the service on the Micro pack for the initial low-volume validation. Do not create/start the paid Worker until branch review and explicit user approval.

## Database migration

File: `supabase/migrations/20261111010000_lokal_async_image_worker.sql`

The migration creates `armex_image_jobs`, expands image status to include `processing`, and adds enqueue/claim/heartbeat/complete/fail RPCs. It has **not** been applied to the live Supabase project by this branch change.

The RPCs are executable only by `service_role`; the job table has RLS enabled and no client policies. The Edge Function authenticates the user before using the privileged server-side client.

## Deployment sequence (not yet performed)

1. Review the feature branch and validate the SQL migration in a disposable/local Supabase database.
2. Confirm the private Storage bucket `lokal-ai-images` exists and the Cloudflare credentials are ready.
3. Apply the migration to the intended Supabase project.
4. Deploy the updated `armex-api` Edge Function.
5. Build the root Dockerfile and configure the four required runtime secrets on the Medium Worker service.
6. Start exactly one worker instance; inspect logs and, from the container shell if available, confirm the local health endpoint with `curl -fsS http://127.0.0.1:8080/health` and run one end-to-end image job.
7. Test duplicate request IDs, insufficient balance, provider 429/5xx, storage failure, worker restart/lease expiry, retry exhaustion, and exactly-once refund ledger behavior before enabling user traffic.

No production migration, Edge Function deployment, Weblines Worker service creation, or paid service activation is performed by this branch.

## Medium operating envelope

- Weblines Medium: 2 vCPU / 4 GB RAM / 20 GB disk. This is the intended operational CPU worker size for the first production rollout.
- One worker process and one active image job initially. Increase concurrency only after observing memory, CPU, queue age, and provider latency.
- Keep image output capped at the existing private bucket limit (20 MiB). Store outputs in Supabase Storage, never on the container disk.
- Scale beyond Medium only if observed OOM restarts, CPU throttling, sustained queue backlog, or unacceptable queue latency justify it.
