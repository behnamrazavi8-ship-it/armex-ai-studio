# LOKAL AI initial chat billing policy

Status: approved product decision for the first release.

- Charge: exactly 1 credit for each accepted chat message.
- Billing source of truth: public.armex_wallets.balance.
- Ledger: every debit must be recorded in public.armex_credit_transactions.
- Idempotency: one debit per authenticated user and request_id; retries must not charge again.
- Failure handling: if the provider request fails after a debit, issue exactly one compensating refund through the trusted server-side credit operation.
- Insufficient balance: reject before calling OpenRouter.
- Client: must never submit a trusted price or write wallet/ledger rows directly.
- Configuration: CHAT_CREDIT_COST=1 is a server-side setting; never expose provider or service-role secrets to the browser.

Do not deploy or enable paid chat until the Edge Function's actual RPC signatures and table columns have been checked against the live Supabase schema and end-to-end tests pass.
