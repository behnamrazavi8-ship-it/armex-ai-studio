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
- At last compare: branch was 24 commits ahead and 0 behind `main`.
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

## Live Supabase read-only findings

- Existing `armex_debit_credits`: five arguments, returns boolean; existing idempotency key causes it to return true without another debit.
- Existing `armex_grant_credits`: six arguments, returns boolean; an existing idempotency key returns false and does not add credits again.
- `armex_wallets.balance` is bigint with a non-negative check.
- `armex_credit_transactions` has unique `(user_id, idempotency_key)`.
- Existing image status check allowed pending/completed/failed; the branch migration replaces it to include processing.
- Existing debit/grant functions are not callable by anon/authenticated; service_role can execute them.

## Existing Supabase advisor findings (not introduced by this branch)

- Security advisor reports `public.rls_auto_enable()` as a SECURITY DEFINER function executable by anon and authenticated. This is a pre-existing project-level issue; it was not modified during this worker task. Review it separately before production security sign-off.
- Auth leaked-password protection is disabled; review separately.
- Performance advisor reports existing RLS init-plan and unindexed foreign-key recommendations on other project tables. These are not part of the image-worker migration and must not be changed as incidental scope.

## Remaining gates — in order

1. Observe the GitHub Actions run for the new PostgreSQL contract test and all existing quality checks; repair failures on this branch only.
2. Review worker/Edge Function/frontend behavior and the exact Storage API semantics; add focused tests for ambiguous completion and stale-worker cleanup where practical.
3. Run the migration against a disposable Supabase-compatible environment and verify actual role grants/RLS behavior.
4. Review the existing `rls_auto_enable()` advisor finding as a separate security item.
5. Only after the above, present a production rollout plan for explicit approval. Rollout would require migration, Edge Function deploy, server-side secrets, then creation/start of exactly one Medium worker and controlled end-to-end tests.

## Do not repeat

- Do not restart the project from scratch or redo domain/DNS/auth setup unless explicitly requested.
- Do not suggest previously rejected/closed infrastructure options.
- Do not change `main`, the stopped Nano test service, live Supabase schema, Edge Function deployment, or paid Weblines services during branch-only preparation.
