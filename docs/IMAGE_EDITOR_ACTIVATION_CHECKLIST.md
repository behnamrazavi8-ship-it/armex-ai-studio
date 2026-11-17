# Image editor integration — activation and verification

## What is fixed in this branch

The browser previously treated any HTTP-200 response as a valid quota response. The deployed legacy API can answer an unknown GET action with a generic `{ success, service, status: "online" }` health payload. The editor converted its missing `remaining` field to zero and displayed a false “daily quota exhausted” state, disabling the submit button.

This branch now validates the quota, history, and job-status response contracts. A generic health response is shown as an inactive/not-yet-wired image-edit API, never as a real quota result. The browser remains fail-closed until a valid quota response is returned.

## Intended request path

1. Authenticated browser editor prepares a JPEG and submits `edit_image` to the Supabase Edge Function.
2. `image-edit-api.ts` validates the image, writes it to the private `lokal-ai-images` bucket, and calls `armex_enqueue_image_edit`.
3. The durable Supabase queue enforces five free edits per user per UTC day; no wallet credits are deducted.
4. The **Weblines Medium background worker** claims the queue job, downloads the private input, and calls the Cloudflare Workers AI FLUX.2 Klein 4B inference REST API using multipart `input_image_0`.
5. The worker stores the result privately and completes the job. The authenticated API returns signed URLs to the owner; the browser polls status and displays the result.

## Important infrastructure distinction

- This flow does **not** use or deploy the retired Cloudflare service named `armex-ai-studio`.
- The Weblines Medium service is a separate queue coordinator. It is not a GPU host; model inference is a remote Cloudflare Workers AI API request.
- The Nano test service `lokal-ai-test-worker` remains untouched.
- RunPod remains out of this flow.

## Activation gates — not performed by this branch

1. Review and explicitly approve the migration `20261116010000_lokal_image_edit_free_quota.sql` for the intended Supabase project.
2. After approval, deploy the branch's `armex-api` Edge Function and verify the authenticated quota endpoint returns numeric `used`, `limit`, and `remaining`.
3. After separate approval, update/restart the existing Weblines Medium coordinator from this branch with its already-managed runtime secrets. Do not create another paid service.
4. Verify the Cloudflare Workers AI token/model access and account-level usage limits before a live image request.
5. Test: valid JPG/PNG/WebP upload, one edit, status polling, signed output URL, private history, chained second edit, quota boundary, and two-user isolation.
6. Verify the existing text-to-image queue still processes jobs independently.

No migration is applied, no Edge Function is deployed, no Weblines service is changed, no Cloudflare service is deployed, no production secret/configuration is changed, and no merge to `main` is performed by this branch.

## Local verification

Run:

```sh
node --test tests/image-editor-api-contract.test.mjs
node --check modules/image-editor/image-editor.js
node --check worker/src/worker.mjs
```
