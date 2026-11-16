# LOKAL AI Image-to-Image Editor

This feature is isolated from the existing FLUX.1 Schnell text-to-image pipeline.

## Architecture

- Frontend: `modules/image-editor/image-editor.js`; a separate workspace page, upload/preview, prompt, before/after result, private history, multi-stage edits, and quota display.
- Authenticated API: `supabase/functions/armex-api/image-edit-api.ts`; validates the caller through the existing authenticated Edge Function, validates image MIME/magic bytes and a 5 MiB maximum, uploads input to the existing private `lokal-ai-images` bucket, and issues signed URLs only for the authenticated owner.
- Quota: `armex_image_edit_daily_usage` is keyed by user and UTC date. `armex_enqueue_image_edit` locks the quota row and reserves one of five daily slots atomically. No wallet debit or credit transaction is created.
- Queue: `armex_image_edit_jobs` with lease-based claim, heartbeat, retry and terminal failure state.
- Worker: existing `worker/src/worker.mjs` now checks the image-edit queue after the existing text-to-image queue. It downloads the private source, calls Cloudflare Workers AI FLUX.2 Klein 4B with multipart `input_image_0` + `prompt`, and stores the result privately.
- Model: `@cf/black-forest-labs/flux-2-klein-4b`.

## Free-use policy

- Application limit: five submitted edit jobs per user per UTC day.
- User wallet charge: zero.
- No alternate provider, paid model fallback, or automatic paid route is implemented.
- The Cloudflare Workers AI free allocation is account-wide/shared with other Workers AI inference. The app-level five-per-user limit cannot guarantee that shared account allocation will be available. On provider quota/capacity errors, jobs retry only within the bounded worker retry policy and then fail; they never switch providers.
- Daily app quota resets at 00:00 UTC.

## Required activation steps (not performed by this branch)

1. Review and apply `supabase/migrations/20261116010000_lokal_image_edit_free_quota.sql` to the intended Supabase project.
2. Deploy the updated `armex-api` Edge Function.
3. Rebuild and redeploy the existing image worker from this branch using its existing environment variables: `SUPABASE_URL`, `SUPABASE_SECRET_KEY` (or existing service-role variable), `CLOUDFLARE_ACCOUNT_ID`, and `CLOUDFLARE_API_TOKEN`.
4. Confirm the Cloudflare account is on a plan/configuration that does not permit paid Workers AI overage. This code does not change account billing settings.
5. Test with a signed-in account: quota read, valid JPG/PNG/WebP upload, one edit, output retrieval, history, second-stage edit, six concurrent submissions (only five should be accepted), and a second user (separate quota).
6. Confirm the existing text-to-image queue still claims and completes jobs independently.

The branch does not apply migrations, deploy Supabase functions, rebuild a Weblines worker, publish Cloudflare Pages, merge to `main`, or change any production secrets/configuration.
