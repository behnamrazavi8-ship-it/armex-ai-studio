# LOKAL AI Chat and Media Workspace

## Phase 1 — authenticated text chat (implemented in this PR)

- Persian-first Chat workspace with conversation list, new conversation, history, and follow-up turns.
- Reuses the existing `armex-api` OpenRouter chat flow, one-credit idempotent billing, and existing conversation/message/usage tables.
- Owner-scoped history reads.
- No provider credential is exposed to the browser.

## Phase 2 — private media intake (implemented in this PR; migration not deployed)

- Dedicated private Storage bucket: `lokal-chat-media`.
- Attachment metadata table with owner, conversation, optional message, private storage path, MIME type, size, SHA-256 digest, and verification status.
- The API creates short-lived signed upload tokens only after checking the authenticated owner and conversation.
- Browser uploads directly to the private bucket using the signed token; no service-role key or public object URL reaches the browser.
- The API downloads and verifies file size and file signatures before marking an attachment ready.
- Allowed types: JPEG, PNG, WebP, MP4, WebM, QuickTime MOV.
- Application limits: images up to 20 MB; videos up to 50 MB (also bounded by the Supabase project's global Storage limit).
- Conversation history returns short-lived signed preview URLs only after ownership checks.
- Image attachments are passed to the existing image-capable chat model as visual context.
- Video attachments are securely stored and shown in chat, but the text model is explicitly told not to claim it viewed or edited the video.

## Phase 3 — actual media editing (not implemented)

1. Verify and add an image-to-image contract to the independent Image Engine. Current FLUX text-to-image endpoint is not an image editor.
2. Add asynchronous media-edit job records with idempotent job IDs, queued/running/completed/failed states, progress, cancellation, and output attachment references.
3. Connect video edit jobs to the independent Wan 2.2 Worker only after GPU capacity and worker execution are available.
4. Define separate credit reservation, settlement, and refund rules for each edit operation before enabling paid jobs.
5. Add quotas, abandoned-upload cleanup, retention/deletion controls, and malware/content scanning appropriate to the accepted media types.

## Release gates

- GitHub Actions must pass Edge Function type-check, inline browser JavaScript syntax checks, and media security contract checks.
- Verify upload, byte-signature rejection, preview URL expiry, conversation ownership isolation, and re-opened attachment history in a staging project.
- Apply the SQL migration and deploy the Edge Function only after explicit production approval.
- Do not merge to `main`, deploy Edge Functions, apply migrations, or modify production Storage without explicit approval.
