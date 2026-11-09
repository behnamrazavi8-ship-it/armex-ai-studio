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

## Remaining work

1. Implement a scheduled/triggered reconciler that claims eligible rows, loads
   the persisted recovery metadata and provider snapshot, derives the response
   fields, and calls the atomic persistence RPC with its lease token.
2. Ensure the reconciler only handles accepted + debited snapshots, confirmed
   rejected/refunded requests, or proven not-started/no-debit requests. It must
   never call OpenRouter. Unknown outcomes stay in manual review.
3. Persist any model-pricing inputs needed to reproduce `actual_cost_usd`
   exactly when the provider response omits its own cost.
4. Add database-level tests for concurrent claims, lease expiry, duplicate
   persistence, partial legacy records, and refund uncertainty before rollout.
5. Run CI and review all staged migrations. SQL migrations have not been
   applied to Supabase; no live data or configuration has been changed.

No existing database rows should be rewritten or deleted as part of this work.
Legacy tables and records remain untouched.
