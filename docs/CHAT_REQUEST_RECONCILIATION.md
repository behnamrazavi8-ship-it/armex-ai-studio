# Chat request reconciliation design

Status: staged schema and Edge Function changes only. No production migration,
deployment, provider call, credit debit, or refund is authorized by this document.

## Safety invariants

1. A request in `processing` is not evidence that the provider did not accept it.
2. Reconciliation must never call OpenRouter again for an existing request ID.
3. A timeout, connection reset, HTTP 408, HTTP 5xx, malformed response, or lost
   response body is an ambiguous provider outcome. Keep the request held.
4. A refund is permitted only when provider non-acceptance is definitive, the
   debit is independently confirmed, and the idempotent refund transaction is
   independently confirmed.
5. A successful provider response is recoverable automatically only if its
   complete response snapshot was durably persisted before downstream writes.
6. Messages, usage, and request finalization must be committed in one database
   transaction and tied to the same request ID.
7. Reconciliation claims must be atomic and lease-based so two workers cannot
   repair the same request concurrently.
8. Ambiguous provider outcomes remain manual-review cases. No provider retry.

## Staged evidence and recovery data

The staged migrations add to `armex_chat_requests`:
- provider outcome: `not_started | unknown | rejected | accepted`;
- provider response snapshot and provider HTTP status;
- debit outcome: `not_attempted | not_debited | debited | unknown`;
- reconciliation attempt count, lease token/expiry, completion timestamp and
  bounded diagnostic code;
- the original user message, requested model, optional conversation ID,
  reserved credits and attempt ID.

The Edge Function writes recovery metadata before debit/provider work, records
the confirmed debit before contacting OpenRouter, and stores the complete
provider response snapshot immediately after a successful HTTP response.
Network exceptions after submission are recorded as `unknown` when possible.
Failure to persist evidence leaves the request pending; it never authorizes a
second provider call.

## Atomic local persistence

The staged migration
`20261109220000_chat_atomic_recovery_persistence.sql`:
- adds nullable `request_id` to `armex_messages`; existing rows remain NULL;
- adds a partial unique index for one user and one assistant message per
  `(user_id, request_id)`;
- adds `armex_persist_chat_response_atomic(...)`, restricted to
  `service_role` and using `SECURITY INVOKER`.

The RPC locks the request row, verifies accepted provider evidence and a
confirmed debit, verifies the lease token, creates or validates the conversation,
persists both messages and the usage row, updates the conversation, and marks
the request completed in a single transaction. Repeated calls return the
already-completed response. Partial or conflicting request-linked writes fail
closed for manual review.

The chat handler now uses this RPC instead of separate message, usage, and
request-finalization writes. The provider is not called again when this local
transaction fails.

Legacy messages keep `request_id = NULL`. Historical partial writes that cannot
be reliably associated with a request are not auto-repaired; they require
manual review rather than guessing.

## Decision policy

The pure decision function in
`chat-request-reconciliation.ts` chooses only among local recovery actions.
It never retries the provider and never initiates a refund.

- Complete debit + usage + both messages: finalize request metadata.
- Accepted provider response + durable response snapshot + confirmed debit:
  resume local persistence idempotently.
- Definitive provider rejection + independently confirmed refund: mark failed.
- Proven pre-provider failure + confirmed absence of debit: mark failed without
  refund.
- All other combinations: manual review; do not change credits or provider work.

## Staged reconciliation worker

The new Edge Function at
`supabase/functions/armex-chat-reconciler/index.ts` is a staged, internal
worker. It requires the platform's service-role JWT, claims a bounded batch
using the lease RPC, reloads recovery metadata, and then:
- accepted + debited: derives the response from the stored provider snapshot
  and calls the atomic local persistence RPC with the lease token;
- rejected + debited: retries the same idempotent refund key, then marks failed
  only after the refund is independently confirmed;
- not-started + debited: refunds using the original pre-provider idempotency key;
- proven no-debit: marks failed without issuing a refund;
- unknown or conflicting evidence: releases the lease into a
  `manual_review:` diagnostic state, which is excluded from future automatic
  claims.

The worker contains no OpenRouter request path. It is not deployed or scheduled,
and its first invocation is not authorized yet. The existing Edge Function
handler also persists model pricing and estimated input-token metadata before
debit/provider work so recovery can reproduce the normal usage accounting.

## Remaining work

1. Add a scheduled trigger only after the migrations and worker have been
   reviewed and tested; keep invocation credentials in a protected server-side
   secret store.
2. Add database-level tests for concurrent claims, lease expiry, duplicate
   persistence, partial legacy records, and refund uncertainty before rollout.
3. Run the updated CI checks and review SQL migration syntax/privileges. The
   migrations have not been applied to Supabase; no live data or configuration
   has been changed.

No existing database rows should be rewritten or deleted as part of this work.
Legacy tables and records remain untouched.


## Read-only schema review

The staged SQL dependency order is:
1. `20261109190000_durable_chat_request_idempotency.sql` creates
   `public.armex_chat_requests` and its service-role-only RPCs.
2. `20261109200000_chat_request_reconciliation_evidence.sql` adds provider
   evidence and lease primitives to that table.
3. `20261109210000_chat_recovery_metadata.sql` adds the recovery inputs.
4. `20261109220000_chat_atomic_recovery_persistence.sql` adds the
   request-linked message uniqueness guard and atomic persistence RPC.

A read-only inspection of the connected live project found:
- `public.armex_chat_requests` does not exist yet, as expected because the
  staged base migration has not been applied.
- `public.armex_messages.request_id` does not exist yet; the final staged
  migration adds it without rewriting legacy rows (NULL remains allowed).
- `public.armex_usage.request_id` already exists and has a unique constraint,
  so the staged migration correctly does not add a duplicate usage index.
- The current `armex_messages`, `armex_usage`, and
  `armex_conversations` columns used by the atomic function were confirmed
  through read-only catalog queries.

This is a source/schema compatibility review, not a PostgreSQL execution test.
The staged migrations remain unapplied. Before rollout, run the complete ordered
migration set against an isolated disposable database, add database-level tests
for concurrent claims and atomic persistence, then review Supabase advisors.
Do not apply only the later migrations: the reconciliation migrations depend
on the base `armex_chat_requests` migration.
