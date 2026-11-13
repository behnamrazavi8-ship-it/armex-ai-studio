# Semantic Prompt IR → Image Generation

This document describes the Staging-only integration path. It does not authorize a Production rollout.

## Request flow

1. A signed-in user enters an image request in Image Studio.
2. The browser calls the authenticated Staging `prompt-understanding` Edge Function.
3. The function returns a validated, provider-neutral Semantic Prompt IR. A deterministic renderer turns the original request plus extracted IR fields into the prompt sent to the image provider. The renderer does not invent missing scene details.
4. If the IR contains an ambiguity marked `blocks_execution: true`, the UI stops and asks for correction. No image job is enqueued.
5. Otherwise, the UI shows the original request and the rendered prompt. The user must explicitly approve it.
6. Only after approval does the browser call Staging `armex-api` with `action: generate_image`.
7. The existing durable image queue reserves 20 image credits, the Worker claims the job, Cloudflare Workers AI runs FLUX.1 Schnell, and the output is uploaded to the private `lokal-ai-images` bucket.
8. The authenticated status endpoint returns a short-lived signed URL for the completed image.

## Billing boundary

- Prompt analysis does not debit the user's wallet. It does consume the Prompt Intelligence quota and incurs the configured model-provider API cost.
- The image job is not created until the user approves the rendered prompt.
- The existing image-generation API reserves 20 credits when the image job is enqueued. Existing retry/refund idempotency remains the authority for failed jobs.
- Never describe analysis as free: it is wallet-credit-free, not provider-cost-free.

## Separation of concerns

- `prompt-intelligence/staging-test.html` remains an analysis-only laboratory. It must continue to state that it does not generate images or debit image credits.
- Image generation is integrated into the authenticated Image Studio in `index.html`.
- Semantic IR remains provider-neutral. The deterministic renderer is the adapter between the IR and the current FLUX prompt input.
- The first renderer preserves the original input language; it does not yet add a separate Persian-to-English translation pass. Validate actual image quality before deciding whether a dedicated rendering/translation stage is needed.
- The raw user request is retained in the rendered prompt so explicit constraints are not lost when an individual IR field is incomplete.
- The request UUID is reused in in-memory page state after uncertain enqueue/poll results. A full page reload currently loses that pending state; durable reload recovery is a pre-production hardening item.

## Staging rollout gates

Before an end-to-end image can be generated from this branch:

1. Review the integration branch and run the IR and renderer contract tests.
2. Confirm the Staging `prompt-understanding` function is active with JWT verification.
3. Confirm the Staging `armex-api` contains the image enqueue/status routes.
4. Apply and verify the image-job migration on Staging only; do not run it against Production.
5. Configure the Worker with Staging-only Supabase credentials and the required Cloudflare Workers AI runtime secrets. Secrets belong only in server-side runtime settings.
6. Start one Worker process with one active job and verify enqueue → debit once → claim → FLUX output → private upload → completion → signed URL, plus terminal failure/refund and duplicate-request behavior.

The existing worker deployment notes contain an older Medium sizing reference. Reconcile those notes with the latest approved operational target before creating or starting any paid Worker service. The Nano test service must remain stopped and untouched.

## Explicitly not performed

- No Supabase migration was applied.
- No Edge Function was deployed or changed.
- No Worker service was created, started, or reconfigured.
- No Production resource was modified.
- No pull request was merged; PR #35 remains open and draft.
