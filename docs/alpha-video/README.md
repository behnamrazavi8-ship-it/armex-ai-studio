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
- `supabase/functions/alpha-video-worker/pinned-http.ts`, `http-headers.mjs`, and `ip-safety.mjs`: pinned-IP HTTPS output transport, strict HTTP response framing, and public IPv4 range validation.
- `modules/video/video-studio.js`: browser upload, job submission, status tracking, and private video history.
- `docs/alpha-video/alpha-video-schema-draft.sql`: schema/RPC draft. It is intentionally not a production migration.

## Required server configuration (not set by this code change)

1. `ALPHA_API_KEY`: Alpha provider key. Worker-only secret.
2. `ALPHA_VIDEO_WORKER_SECRET`: independent random secret checked by the worker.
3. `ALPHA_VIDEO_CREDIT_COST`: positive integer in LOKAL AI credits. There is deliberately no default: Alpha's 5,000-toman provider price is not automatically equal to 5,000 LOKAL credits.
4. `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`: standard server-side Supabase environment values for the worker. Never expose either secret to the browser.
5. `ALPHA_OUTPUT_HOSTS`: comma-separated exact hostnames approved for Alpha's temporary output files (only after Alpha confirms the official CDN hostname). Wildcards, IP literals, and unlisted redirect hosts are rejected. This setting is mandatory; if it is missing or empty, the worker fails closed before claiming a job.

## Database preparation required before deployment

The SQL file in this folder is a review draft, not an applied migration. Before it can be used:

1. On a local checkout, create the migration through the Supabase CLI (`supabase migration new alpha_video_jobs`).
2. Move the reviewed SQL into the generated timestamped migration.
3. Review it against the live Production schema and Supabase security advisors. Confirm the migration role owns the `SECURITY DEFINER` functions and that only `service_role` can execute them.
4. Obtain explicit approval before applying the migration to Production.

The draft adds `public.armex_video_generations` with RLS enabled and service-role-only table access, API-enforced owner scoping, and a unique per-user request ID. It uses the existing private `lokal-chat-media` bucket (50 MB limit) and does not create or modify buckets. Job creation serializes duplicate `(user_id, request_id)` submissions with a transaction-scoped advisory lock, verifies that the ready image attachment belongs to the exact selected conversation, and checks conversation ownership. It performs the wallet debit before inserting the user message and job. Because all operations run in one PostgreSQL transaction, a later insert failure rolls back the debit as well; insufficient balance leaves no new message or conversation-side mutation. Worker leases, safe terminal refunds, and chat-message/attachment persistence are included.

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
- Job creation and LOKAL wallet debit occur in one database transaction through `armex_create_video_job`; duplicate user/request pairs are serialized before the idempotency check, and image/conversation ownership is enforced inside the database function.
- A definite provider rejection or invalid output marks the job failed and refunds the reserved LOKAL credits through an idempotent ledger key.
- A timeout or ambiguous response to Alpha's POST is marked `submission_unknown`. The worker does not submit again because the provider docs do not establish an idempotency-key contract. Reconcile against Alpha's request list before any manual retry.
- A successful provider output is downloaded, checked for MP4 signature and size, stored privately, and attached to an assistant message in the related conversation. Failed HTTP responses and rejected content types cancel their socket streams immediately.
- The provider's temporary output URL is never returned to the browser; the API issues a short-lived signed URL from LOKAL Storage. Output downloads require an exact `ALPHA_OUTPUT_HOSTS` hostname allowlist and revalidate every redirect against the same list. The dedicated `pinned-http.ts` transport resolves A records only, rejects missing or non-public IPv4 answers, never opens an IPv6 connection, and opens TCP directly to one validated IPv4 literal, verifies the connected peer IP, then performs TLS using the original hostname for SNI and certificate hostname verification. It sends a minimal HTTPS GET with `Accept-Encoding: identity`, rejects unsupported transfer/content encodings, and streams a bounded response body. Redirects are handled manually and each new host goes through the same allowlist and pinned-connection process. Do not populate `ALPHA_OUTPUT_HOSTS` from a job response or user input. The transport intentionally fails closed for chunked responses; those require a separately reviewed decoder before support is enabled. The dedicated header parser rejects interim/invalid status lines, folded or malformed headers, duplicate framing headers, invalid Content-Length values, transfer encoding, and compressed responses. The video pipeline accepts only a complete HTTP 200 response with an explicit MP4 or generic binary content type (not partial 206 responses or missing content types). The public IPv4 filter includes special-use, private, link-local, documentation, benchmarking, multicast, and reserved ranges; malformed/non-canonical IPv4 strings are rejected.

## Not performed

No Production migration, Edge Function deployment, secret creation, scheduler setup, Worker activation, payment, Alpha request, credit consumption, PR creation, or merge was performed by this implementation.


## Output-fetch SSRF hardening status

The branch now includes a pinned-IP HTTPS transport rather than standard `fetch()` for Alpha output files. It uses only A records and connects to a validated IPv4 literal; AAAA records are neither needed nor used, checks the peer address, and retains TLS SNI/certificate verification against the allowlisted hostname. Chunked transfer encoding is intentionally rejected pending a dedicated decoder. This closes the DNS re-resolution gap for the output socket, but it is not yet a live-provider validation: the exact official CDN hostnames still need to be configured from trusted documentation/observed provider metadata, and the raw HTTP transport must pass runtime integration tests before activation. Do not deploy or enable it until those checks and separate approval are complete.
