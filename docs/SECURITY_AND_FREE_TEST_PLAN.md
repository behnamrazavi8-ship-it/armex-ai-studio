# LOKAL AI Security and No-Cost Integration Test Plan

This plan is for PR #30 and its feature branch. It is documentation only: it does not authorize production deployment, production migrations, secrets changes, provider calls, or paid infrastructure.

## Guardrails

- Run tests only against local mocks or a separately approved disposable test database.
- Never use the production Supabase project for mutation-based tests.
- Do not call OpenRouter, Cloudflare Workers AI, RunPod, or Zarinpal real endpoints during mock tests.
- Do not use real user accounts, tokens, payment authorities, or production secrets in fixtures.
- Keep PR #30 open and Draft. No merge or production deploy is part of this plan.

## Test matrix

| ID | Area | Scenario | Expected result |
|---|---|---|---|
| AUTH-01 | API auth | Missing, malformed, expired JWT | 401; no data mutation |
| AUTH-02 | Owner isolation | User A requests User B conversation/image/video/order IDs | 404/403; no cross-user data |
| CORS-01 | CORS | Preview origin not allowlisted; preflight and actual request | Rejected until exact preview origin is intentionally allowlisted |
| CHAT-01 | Idempotency | Repeat identical request_id after completed usage exists | Cached prior response; no second provider call or debit |
| CHAT-02 | Idempotency | Concurrent requests with same request_id before usage row exists | Exactly one provider invocation and one debit; second request receives in-progress/duplicate response |
| CHAT-03 | Recovery | Provider error or timeout after debit | One refund; repeat retry does not add extra refund |
| CHAT-04 | Persistence | Conversation/message/usage write fails at each boundary | Durable, discoverable state; no silent duplicate charge; reconciliation path documented |
| WALLET-01 | Ledger | Insufficient balance | 402; no debit ledger entry |
| PAY-01 | Zarinpal mock | Provider request rejected or malformed JSON | Order transitions to explicit failed/recoverable state; no credits granted |
| PAY-02 | Zarinpal mock | Authority persistence fails after authority issuance | Order remains traceable and support/reconciliation path is available |
| PAY-03 | Callback | Verify mismatch / amount mismatch / invalid authority | No wallet grant |
| PAY-04 | Callback idempotency | Repeat verified callback after grant | 200 success/duplicate; exactly one wallet grant |
| PAY-05 | Callback recovery | Payment marked verified but grant RPC transiently fails | Retry can grant once; no duplicate grant |
| VIDEO-01 | RunPod mock | Non-JSON, malformed, or missing job ID from submit response | Explicit safe state; no untracked charge |
| VIDEO-02 | RunPod mock | Submit accepted but response lost; webhook arrives | Correlate request ID, persist provider job ID/status |
| VIDEO-03 | Webhook | Invalid signature, request ID mismatch, provider job ID mismatch | Reject without state change |
| VIDEO-04 | Webhook | Duplicate/out-of-order terminal callback | Terminal state remains stable; refund/grant side effects happen once |
| VIDEO-05 | Polling | Timeout, malformed status JSON, provider unavailable | Retryable error; no incorrect terminal transition |
| VIDEO-06 | Result | Completed response lacks durable HTTPS output URL | Fail safely and refund idempotently |
| IMG-01 | Image billing | Duplicate request_id while pending/completed/failed | No second provider call or debit; clear client response |
| DB-01 | Migration | Apply migration to disposable DB with baseline schema | Migration succeeds; constraints/indexes/policies verified |
| DB-02 | RLS | Two synthetic users query each other's rows | No cross-user reads |
| UI-01 | Preview | Mobile and desktop chat history, errors, loading, balance display | Usable and no misleading success states |

## Recommended execution order

1. Static checks (type-check, syntax-check, lint if configured).
2. Unit tests for pure helpers: signatures, status mapping, URL validation, package parsing.
3. Mock-based Edge Function tests for auth, billing, callbacks, and failure injection.
4. Disposable database tests for migration, constraints, idempotency, and RLS.
5. Preview UI smoke tests with test-only credentials after CORS and API deployment are approved.
6. Paid provider sandbox/real tests only after separate explicit approval and a cost ceiling.

## Blocking design questions before live tests

- Chat needs a durable request reservation/lock so concurrent retries cannot trigger multiple provider calls. A stable debit key alone is insufficient because the debit RPC treats an existing idempotency key as success.
- Payment callback should treat an already-granted idempotency key as successful duplicate processing, while distinguishing true grant errors.
- Payment order creation needs recovery for an uncertain Zarinpal request/authority persistence.
- Video submission and status JSON parsing need explicit recovery handling and reconciliation for uncertain provider acceptance.
- Preview CORS must be scoped to the exact preview hostname, not a broad wildcard.
- Migration must be reviewed for redundant indexes and deployed only to a disposable test database first.

## Completion criteria

- All mock tests pass with no external provider requests.
- Duplicate/concurrent request tests prove exactly-once billing and provider invocation, or the design remains blocked.
- Ownership tests show no cross-user access.
- Migration is validated on a disposable database only.
- Any unresolved case is listed as a release blocker; no production rollout is implied.
