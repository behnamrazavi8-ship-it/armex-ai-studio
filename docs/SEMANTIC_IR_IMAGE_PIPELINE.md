# Semantic Prompt IR → Image Generation

This document describes the Staging-only integration path. It does not authorize a Production rollout.

## Request flow

1. A signed-in user enters an image request in Image Studio.
2. The browser calls the authenticated Staging `prompt-understanding` Edge Function.
3. The function returns a validated, provider-neutral Semantic Prompt IR. A deterministic renderer combines the original request with extracted IR fields without inventing missing scene details.
4. If the IR contains an ambiguity marked `blocks_execution: true`, the UI stops. No image job is enqueued.
5. Otherwise, the original request and rendered prompt are shown for explicit user approval.
6. Only after approval does the browser call Staging `armex-api` with `action: generate_image`.
7. The queue reserves 20 image credits. The Worker claims the job, Cloudflare Workers AI runs FLUX.1 Schnell, and the output is uploaded to the private `lokal-ai-images` bucket.
8. The authenticated status endpoint returns a short-lived signed URL for the completed image.

## Billing boundary

- Prompt analysis does not debit wallet credits. It consumes Prompt Intelligence quota and incurs provider API cost.
- No image job exists until the user approves the rendered prompt.
- The queue atomically reserves 20 credits with the job record. Retry and terminal failure refunds use stable idempotency keys.
- Never describe analysis as free: it is wallet-credit-free, not provider-cost-free.

## Separation of concerns

- `prompt-intelligence/staging-test.html` remains an analysis-only laboratory.
- Image generation is integrated into the authenticated Image Studio in `index.html`.
- Semantic IR remains provider-neutral; the deterministic renderer adapts it to the current FLUX prompt input.
- The renderer preserves the original input language. A separate Persian-to-English translation stage has not yet been added.
- The raw user request is retained so explicit constraints are not lost when an IR field is incomplete.
- Request UUID retry state is currently in memory. A full page reload loses that pending state; durable reload recovery is a pre-production hardening item.

## Completed Staging work

- `lokal_async_image_worker` migration applied to Staging only.
- `lokal_image_jobs_user_index` migration applied to Staging only.
- `armex_image_jobs` exists with RLS enabled and no client grants.
- All five queue RPCs exist. Execute privilege is granted only to `service_role`; `public`, `anon`, and `authenticated` have no execute permission.
- Staging `armex-api` version 7 is ACTIVE. It enqueues image jobs and exposes the authenticated job-status route; synchronous Cloudflare image execution has been removed from this Edge Function.
- Staging `prompt-understanding` version 7 remains ACTIVE with JWT verification enabled.

## Remaining Worker rollout

The approved first smoke-test target is Weblines **Micro** (0.5 vCPU, 1 GB RAM, 5 GB disk), one process, one active job. This is a constrained smoke test, not a production sizing claim. Inference runs remotely on Cloudflare Workers AI; monitor memory/CPU and stop if limits are approached.

Create a Weblines **Worker** (not Custom App), from the public Git repository `behnamrazavi8-ship-it/armex-ai-studio`, branch `feat/staging-semantic-ir-image-pipeline`, using the root Dockerfile and Micro pack. It should have no public address. The local health listener on port 8080 is for diagnostics only.

Configure only Staging credentials in Weblines runtime Environment. Required variable names:

- `SUPABASE_URL`
- `SUPABASE_SECRET_KEY`
- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`

Optional: `PORT=8080`, `WORKER_POLL_MS=2500`. Never place values in Git, browser code, build arguments, logs, or chat. The Worker sends new `sb_secret_` keys only in the `apikey` header; it adds `Authorization: Bearer` only for the legacy JWT `service_role` key. The Dockerfile Node heap cap is 640 MiB for the 1 GB Micro test.

After the Worker is healthy and its Staging-only secrets are configured, run one controlled end-to-end image request and verify enqueue → debit once → claim → FLUX output → private upload → complete → signed URL, plus retry, duplicate-request, and terminal failure/refund behavior.

Weblines documents Micro as 0.5 vCPU / 1 GB / 5 GB and recommends Medium+ for heavy Workers. The Micro configuration is approved only for this bounded smoke test; increase resources only after measuring real usage. The Nano test service must remain stopped and untouched.

## Not performed

- No Production resource or schema was modified.
- No Worker service has yet been created or started.
- No runtime secret values have been configured.
- No end-to-end image has yet been generated.
- PR #35 remains open and draft; nothing has been merged.
