# LOKAL AI

**Persian-first modular AI creative workspace**

LOKAL AI is a Persian-first, RTL, mobile-responsive workspace. Its public brand is LOKAL AI; repository and backend identifiers retain their historical ARMEX names.

## Current branch capabilities

This integration branch combines the existing workspace and secure API with the image editor and private chat media flow:

- Authenticated Smart Chat with private conversation history.
- Existing one-credit chat billing and request reconciliation; media upload does not add a separate credit charge.
- Private image/video attachments using short-lived signed uploads, server-side MIME signature checks, SHA-256 verification and owner-scoped access.
- Image attachments are passed to the configured vision-capable chat model. Video files can be stored and previewed, but this release does not analyze or edit video.
- Image Studio keeps its existing FLUX.1 Schnell generation flow and 20-credit price.
- Image-to-image editing uses a separate queued worker and a maximum of five free edits per user per UTC day; it does not debit wallet credits and has no paid fallback.

## Important release status

**This branch is integration work, not a production release.**

- The chat-media and image-edit migrations are present in the repository but have not been applied to the live Supabase project.
- The updated armex-api Edge Function and worker have not been deployed by this change.
- Provider inference, signed upload/preview, quota concurrency, retry/reconciliation, and end-to-end browser flows still require staging verification.
- Cloudflare Workers AI account quota is shared with other account workloads. When the free allowance is exhausted, image edits must fail closed; this code does not switch to a paid provider.
- Do not collect payments or promise availability of an unverified feature.

## Security principles

- Never place Supabase service-role/secret keys, provider keys, or payment secrets in browser code.
- All chat media is stored in a private bucket; access is mediated by authenticated API routes and short-lived signed URLs.
- The server verifies file size and file signatures before marking an attachment ready.
- Image editing uses a separate queue, atomic per-user UTC quota reservation and private storage.
- Credit debits/refunds and ambiguous provider outcomes remain on the existing server-side ledger/reconciliation path.
- Keep RLS enabled and avoid direct client grants on private metadata tables.

## Local checks

The repository's GitHub Actions workflow runs Deno type checks, browser/worker syntax checks, worker auth tests, chat-media security contract tests, database contract tests, and container build checks.

## Architecture notes

- [Image editing engine](./docs/IMAGE_EDITING_ENGINE.md)
- [Chat/media and image-editor integration](./docs/CHAT_MEDIA_IMAGE_EDITOR_INTEGRATION.md)
- [Image worker deployment](./docs/IMAGE_WORKER_DEPLOYMENT.md)

## Brand

LOKAL AI — CREATE · IMAGINE · INNOVATE
