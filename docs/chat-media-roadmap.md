# LOKAL AI Chat and Media Workspace

## Phase 1 — authenticated text chat

- Adds a Persian-first Chat workspace page to the existing authenticated single-page app.
- Uses the existing `armex-api` OpenRouter chat endpoint and existing one-credit, idempotent wallet billing.
- Adds owner-scoped API reads for the user's recent conversations and one conversation's message history.
- Keeps the existing `armex_conversations`, `armex_messages`, and `armex_usage` tables; no database migration is required for this phase.
- No service-role key or provider credential is exposed to the browser.

## Media attachment status

The file picker is intentionally a local-only preview placeholder in Phase 1. Selecting a file does not upload it, send its bytes to OpenRouter, or create an edit job. The UI clearly tells the user that media upload/editing is not yet active. Do not describe the picker as a working upload feature.

## Phase 2 — secure media intake (not included)

Before enabling photo/video uploads:

1. Add a private Storage bucket with strict MIME allowlist, size limits, and per-user folder policies.
2. Add an attachment metadata table with owner, conversation, storage path, MIME, size, checksum, processing state, and timestamps.
3. Validate file type from bytes on the server; never trust the browser filename or MIME header.
4. Use short-lived signed URLs and ownership checks; never make uploaded user media public.
5. For image understanding, verify the selected OpenRouter model supports image input and send only validated private media via short-lived signed URLs.
6. For actual image editing, route to the existing Image Engine only after its supported image-to-image contract is verified.
7. For video editing, create an asynchronous job contract and connect to the independent video Worker only after GPU capacity and worker execution are available.
8. Add upload cancellation, retry-safe job IDs, progress, and cleanup/retention rules before charging for edits.

## Release gates

- Run the repository Edge Function and browser JavaScript checks.
- Verify history is isolated by authenticated user.
- Verify chat creation, follow-up turns, refresh/reopen, and duplicate request behavior.
- Confirm a signed-out user cannot open the workspace.
- Do not merge to `main`, deploy Edge Functions, apply migrations, or modify production Storage without explicit approval.
