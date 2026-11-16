# Chat media and image editor integration

## Scope

This branch joins the independent Smart Chat module, private media upload API, and the existing image-to-image editor. It does not merge to main, apply database migrations, deploy the Edge Function, or modify a live worker.

## Request flows

### Chat attachments

1. The browser asks the authenticated armex-api for a conversation-bound upload slot.
2. The API checks ownership, allowed MIME type and declared size, creates a private metadata row, and returns a short-lived signed upload token.
3. The browser uploads directly to the private lokal-chat-media bucket using the signed token.
4. The browser asks the API to finalize the upload.
5. The API downloads the object, checks actual size and file signature, calculates SHA-256, and marks it ready.
6. When the message is sent, the API verifies attachment ownership and conversation association again. Images are supplied to the vision-capable chat model through a short-lived signed URL. Videos are retained and previewable, but are explicitly not passed off as understood by the text model.
7. The existing chat request claim, debit evidence, provider evidence and atomic response persistence path remains responsible for billing and reconciliation.

Limits: images up to 20 MB; videos up to 50 MB. Supported types: JPEG, PNG, WebP, MP4, WebM and QuickTime MOV. Only one pending attachment is supported by the current chat UI at a time.

### Image-to-image editor

The editor remains an independent module with its own queue and private image bucket. It reserves at most five edits per user per UTC day and does not debit wallet credits. The existing text-to-image queue and its 20-credit billing are not replaced.

## Database changes

The chat media migration creates armex_chat_attachments, enables RLS, revokes direct access from anon/authenticated roles, and provisions a private lokal-chat-media bucket. The image-edit migration separately provisions image-edit jobs and atomic daily quota functions.

Migrations are versioned in source only. Apply neither migration to the live project until the complete staging test plan has passed and the user explicitly approves the database change.

## Staging acceptance checklist

- [ ] Confirm the intended staging Supabase project and environment variables.
- [ ] Apply migrations only to disposable/staging database first.
- [ ] Deploy the Edge Function to staging and allow the exact staging frontend origin through ALLOWED_ORIGINS.
- [ ] Verify signed upload rejects unauthenticated, cross-user, cross-conversation, oversized and MIME-spoofed files.
- [ ] Verify private bucket objects cannot be read through public URLs.
- [ ] Verify valid image attachments reach the vision model and the response is persisted once.
- [ ] Verify video attachment UI and private playback, while the assistant clearly states that video understanding is unavailable.
- [ ] Verify duplicate request IDs do not trigger a second provider call or a second debit.
- [ ] Verify image edit quota concurrency never exceeds five per user/day and image edits never debit wallet credits.
- [ ] Verify the original FLUX.1 Schnell generation queue still works and charges its existing 20 credits.
- [ ] Verify no paid fallback is used when the shared Cloudflare Workers AI free quota is exhausted.
- [ ] Run GitHub Actions and inspect all failures before creating a release candidate.

## Operational constraints

Do not reuse or repoint the existing Weblines worker service as part of this branch-only integration. Keep the Medium service and Nano test service unchanged until their roles and staging deployment are explicitly approved. No production deploy, live migration, service reconfiguration, or merge to main is included here.
