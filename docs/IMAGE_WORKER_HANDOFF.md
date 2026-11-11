# LOKAL AI image worker — project checkpoint

Last reviewed: 2026-11-11

## Fixed decisions

- The planned real worker service is **Weblines Medium: 2 vCPU, 4 GB RAM, 20 GB disk**.
- Medium is a CPU job coordinator/worker, not a GPU inference host. The current image provider remains Cloudflare Workers AI; this is not yet LOKAL AI's own model inference engine.
- Keep the existing test service `lokal-ai-test-worker` on Nano stopped and unchanged.
- Do not create/start a paid Medium service until the branch passes review and the user explicitly authorizes the production rollout.
- Do not apply the migration to the live Supabase project, deploy `armex-api`, merge this branch, or activate infrastructure without separate explicit approval.
- Never request or place service-role keys/provider tokens in chat, browser code, Git, logs, or build arguments. Configure them only as server-side runtime secrets when deployment is approved.

## Git checkpoint

- Repository: `behnamrazavi8-ship-it/armex-ai-studio`
- Working branch: `feat/lokal-medium-image-worker`
- Base: `main`
- At the code-review checkpoint, GitHub compare showed **31 commits ahead** and **0 commits behind** `main`.
- Code-review head at that checkpoint: `161eedf43454cbb311d792b264bf9a6300d24741`.
- Its parent was `9639980339cc3ebfae97a09f23a9c315ee71213b`; that parent was the previous checkpoint, not the code-review head.
- Documentation-only checkpoint sync commits were added afterward. Because each such commit changes the ahead count and branch head, use the live GitHub compare and branch page for the current values rather than treating this historical count as current.
- Keep the work isolated on this branch until review is complete.

## Implementation currently on the branch

- Durable PostgreSQL image-job table and service-role-only RPCs:
  `supabase/migrations/20261111010000_lokal_async_image_worker.sql`
- Node.js 22 worker and root Dockerfile.
- Async image enqueue/status API and frontend polling.
- Worker cleanup now treats upload timeouts as ambiguous and checks job completion before deleting an object.
- Privileged migration RPCs use `pg_catalog, public, pg_temp` search path ordering.
- Worker uses attempt-specific object paths, 180-second leases, heartbeats, bounded retry, and stable per-job refund idempotency key.

## Verification added

- `tests/worker-db-contract.sql` creates a disposable PostgreSQL contract fixture and applies the migration without touching the live Supabase project.
- It checks enqueue idempotency, insufficient balance, claim/heartbeat, retry, terminal failure/refund exactly once, successful completion without refund, lease exhaustion/refund, and RPC execution privileges.
- GitHub Actions now has a separate PostgreSQL 16 service job for this contract test, alongside Deno and JavaScript syntax checks.
- The latest GitHub status had not yet been verified at the time of this checkpoint. Do not describe the new database-contract workflow as passing until a successful run is observed.

## Review pass — 2026-11-11

- Reviewed the current migration, worker, Edge Function, browser flow, Dockerfile, database contract test, and GitHub Actions workflow.
- Fixed a configuration coupling bug: the Edge Function no longer requires `OPENROUTER_API_KEY` for image enqueue, image status, or image history. The key is read only by OpenRouter chat/model-catalog routes.
- Fixed an ambiguous-enqueue billing retry risk in the browser: the image request UUID is retained while the result is uncertain, retries reuse the same UUID, and a different prompt is blocked until the pending request is resolved. Terminal failure and insufficient-credit responses release the in-memory pending request.
- Cloudflare's official FLUX.1 schnell documentation confirms the REST result contains a base64 `image` value; the worker's JSON/base64 decoding path matches that documented response. The model output is JPEG.
- Supabase Storage's documented object-removal endpoint uses `DELETE /object/{bucket}` with a `prefixes` array; the worker cleanup request matches this contract.
- At the code-review checkpoint, branch comparison was **31 commits ahead, 0 behind** `main`. The code-review head was `161eedf43454cbb311d792b264bf9a6300d24741`, parent `9639980339cc3ebfae97a09a315ee71213b`. Documentation-only checkpoint commits followed; consult the live compare for the current count/head. No merge or PR was created.
- GitHub connector currently exposes commit status and PR-associated workflow runs, but not the push-run listing needed to verify this branch's latest Actions execution. The latest combined commit status returned no status entries. Therefore the new PostgreSQL contract job, Deno check, browser syntax check, and Docker build remain **unverified** until a run is visibly successful in GitHub Actions.
- The SQL contract test is a disposable vanilla PostgreSQL fixture. It is useful for transaction/queue/refund logic but does not fully emulate Supabase roles, default grants, Storage, Edge Runtime, or the Cloudflare provider.
- Browser idempotency state is currently in-memory. It protects retries while the page remains open, but a full page reload loses the pending UUID; a durable server-side request recovery path or carefully scoped browser persistence is still a pre-production hardening item.

## Remaining review gates

1. Verify the latest push-triggered GitHub Actions run and fix any failure on this branch only.
2. Execute the SQL migration and ACL checks in a disposable Supabase-compatible environment, not the live project.
3. Validate the Cloudflare token's Workers AI permissions, model access/limits, and actual REST response using a controlled non-production test.
4. Verify the existing `lokal-ai-images` bucket is private and that its object policies and signed-URL behavior match the API.
5. Complete a full non-production test: enqueue -> debit once -> claim -> provider output -> upload -> complete -> signed URL -> terminal failure/refund -> retry/idempotency.
6. Only then present the exact production rollout steps for explicit approval.

## Live Supabase read-only findings

- Existing `armex_debit_credits`: five arguments, returns boolean; existing idempotency key causes it to return true without another debit.
- Existing `armex_grant_credits`: six arguments, returns boolean; an existing idempotency key returns false and does not add credits again.
- `armex_wallets.balance` is bigint with a non-negative check.
- `armex_credit_transactions` has unique `(user_id, idempotency_key)`.
- Existing image status check allowed pending/completed/failed; the branch migration replaces it to include processing.
- Existing debit/grant functions are not callable by anon/authenticated; service_role can execute them.

## Existing Supabase advisor findings (not introduced by this branch)

- Security advisor reports `public.rls_auto_enable()` as a SECURITY DEFINER function executable by anon and authenticated. Read-only inspection confirms it returns the special `event_trigger` type and is attached to the enabled `ensure_rls` DDL event trigger (`ddl_command_end`). This is likely a generic advisor false positive for RPC exposure, not a normal callable RPC. Do not revoke or alter it without a separate PostgreSQL event-trigger review. It was not modified during this worker task.
- Auth leaked-password protection is disabled; review separately.
- Performance advisor reports existing RLS init-plan and unindexed foreign-key recommendations on other project tables. These are not part of the image-worker migration and must not be changed as incidental scope.

## Do not repeat

- Do not restart the project from scratch or redo domain/DNS/auth setup unless explicitly requested.
- Do not suggest previously rejected/closed infrastructure options.
- Do not change `main`, the stopped Nano test service, live Supabase schema, Edge Function deployment, or paid Weblines services during branch-only preparation.
