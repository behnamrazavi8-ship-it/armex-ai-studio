# Chat request reconciliation design

Status: design and policy tests only. This document does not authorize a live
database migration, deployment, provider call, credit debit, or refund.

## Safety invariants

1. A request in `processing` is not evidence that the provider did not accept it.
2. Reconciliation must never call OpenRouter again for an existing request ID.
3. A timeout, connection reset, HTTP 408, HTTP 5xx, malformed response, or lost
   response body is an ambiguous provider outcome. Keep the request held.
4. A refund is permitted only when provider non-acceptance is definitive, the
   debit is independently confirmed, and the idempotent refund transaction is
   independently confirmed.
5. A successful provider response is recoverable automatically only if its
   complete response snapshot was durably persisted before downstream message
   and usage writes.
6. A request may be finalized from local records only when the debit, usage row,
   user message, and assistant message can all be tied to the same request.
7. Reconciliation claims must be atomic and lease-based so two workers cannot
   repair the same request concurrently.

## Evidence required

The current `armex_chat_requests` table stores request status and a completed
response payload, but does not persist the provider outcome, provider response
snapshot, debit outcome, or a reconciliation lease. The current request handler
also writes usage and messages after receiving the provider response. Therefore
some historical pending requests cannot be safely reconstructed.

The next schema/API increment should add durable fields for:
- provider outcome: `not_started | unknown | rejected | accepted`;
- provider response snapshot and provider HTTP status;
- debit outcome: `not_attempted | not_debited | debited | unknown`;
- reconciliation attempt count and lease token/expiry;
- last reconciliation timestamp and a bounded diagnostic code.

The Edge Function should persist `accepted` plus the provider response snapshot
immediately after validating the provider response and before writing messages
or usage. Network exceptions after submission must persist `unknown` when
possible. Failure to persist this evidence remains a manual-review case.

## Decision policy

The pure decision function in
`chat-request-reconciliation.ts` intentionally chooses only among local
recovery actions. It never retries the provider and never initiates a refund.

- Complete debit + usage + both messages: finalize request metadata.
- Accepted provider response + durable response snapshot + confirmed debit:
  resume local persistence idempotently.
- Definitive provider rejection + independently confirmed refund: mark failed.
- Proven pre-provider failure + confirmed absence of debit: mark failed without
  refund.
- All other combinations: manual review; do not change credits or provider work.

## Rollout sequence

1. Review this policy and its Deno tests.
2. Add a staged migration with evidence columns, atomic lease/claim RPCs, and
   narrowly scoped service-role grants.
3. Update the Edge Function to persist provider/debit evidence and make local
   persistence idempotent by request ID.
4. Add tests for concurrent claims, lease expiry, duplicate reconciliation,
   partial message/usage writes, and refund transaction uncertainty.
5. Run CI on this experimental branch.
6. Only after review, separately approve any migration or production rollout.

No existing database rows should be rewritten or deleted as part of the staged
work. Legacy tables and records remain untouched.
