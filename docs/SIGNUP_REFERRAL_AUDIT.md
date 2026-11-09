# Signup and referral credit audit

**Status:** staged on `feat/video-and-zarinpal-integration`; not deployed.

## Live Supabase inspection (read-only, 2026-11-09)

- `auth.users` has two active non-internal triggers:
  - `armex_auth_user_handler_trigger`: after insert or update of `email_confirmed_at`.
  - `on_auth_user_created`: after insert.
- `armex_auth_user_handler` creates the wallet and a unique referral code idempotently, accepts a referral code from the new user's metadata only on INSERT, rejects self-referral, and creates at most one referral row per referred user.
- The same handler calls `armex_activate_user` only when an account is already confirmed at INSERT or transitions from unconfirmed to confirmed.
- `armex_activate_user` grants 500 wallet credits with stable key `signup_bonus:{user_id}`. Before the latest staged hardening, it rewarded a referral when the referred account confirmed, without requiring the referrer to be confirmed.
- Database constraints enforce unique referral codes, one referral per referred user, and no self-referral.
- `armex_activate_user` is executable only by its owner role in the inspected ACL; the wallet grant RPC is executable by `service_role` and its owner, not `anon` or `authenticated`.
- The live `armex_grant_credits` currently returns false for any existing idempotency key without checking amount/type. The staged wallet migration `20261109240000_wallet_rpc_idempotency_hardening.sql` tightens that behavior.
- The legacy `on_auth_user_created` trigger calls `handle_new_user`, which inserts a `profiles` row and grants 500 credits into the separate legacy `credit_transactions` / `profiles.credits` ledger immediately on Auth INSERT, before email confirmation. `process_credit_transaction` updates `profiles.credits` and inserts into the legacy ledger. The current `index.html` frontend and `armex-api` Edge Function contain no reads or writes to these legacy tables; active billing uses the wallet RPC and `armex_credit_transactions`. The public RLS policies on legacy tables are owner-scoped, and no public views or triggers on those legacy tables were found in the read-only inspection. External/older clients cannot be ruled out from repository inspection alone.
- Aggregate inspection found one user with a signup bonus in each ledger and no referral rows at inspection time. The two signup entries are separate ledgers; this does not mean the active wallet balance is doubled. Legacy tables and data are intentionally preserved pending a full dependency/decommission review.

## Staged hardening

Migration `20261109250000_signup_referral_idempotency_hardening.sql`:

- Requires a confirmed Auth user before activation.
- Keeps the stable 500-credit signup idempotency key.
- Processes both pending and qualified referrals under row locks.
- After a duplicate referral grant, verifies exact durable ledger evidence (amount, type, referral ID) before marking the referral rewarded.
- Raises a uniqueness conflict and rolls back the state transition if the existing ledger evidence does not match.
- Keeps the activation RPC unavailable to public client roles.


## Legacy dependency review and referral verification policy

Read-only review of the live database and current repository found:

- The only live Auth path writing the legacy credit model is `on_auth_user_created` → `handle_new_user` → `process_credit_transaction`.
- `handle_new_user` inserts a profile and immediately applies the 500-credit legacy signup bonus, before email verification.
- `process_credit_transaction` updates `profiles.credits` and inserts a row into `public.credit_transactions`; it validates amount/type and uses a unique `reference_key`.
- Current `index.html` and `supabase/functions/armex-api/index.ts` have no references to `profiles`, `public.credit_transactions`, or `process_credit_transaction`. Active user-facing balance and billing use `armex_wallets` and `armex_credit_transactions`.
- No views or triggers on the legacy tables were found. Their current RLS policies permit users to read their own profile/legacy transactions and update their own profile; the legacy trigger itself is a privileged server-side path.
- `BACKEND_INTEGRATION.md` was marked as a historical initial plan so it no longer misrepresents the current app architecture.
- This repository inspection cannot rule out older external clients, manual SQL consumers, or integrations outside this GitHub repository. Therefore the legacy trigger, tables, data, and policies remain untouched.

Referral policy adopted in staged code: **both the referrer and referred account must have a confirmed email before the 200-credit reward is granted**. The activation function now examines referral rows when either participant becomes verified. If the referred account verifies first, the referral remains pending; when the referrer later verifies, the same Auth trigger calls activation and the reward is recovered. The inverse order is covered too. The referral ledger key and row lock preserve exactly-once settlement.

The migration is staged only. It does not modify the live database until separately approved and deployed.

## Disposable PostgreSQL coverage

`supabase/tests/signup-referral-fixture.sql` and `signup-referral-invariants.sql` cover:

- no signup grant for unconfirmed users;
- repeated signup activation grants 500 only once;
- repeated referral activation grants 200 only once;
- exact existing referral ledger evidence reconciles referral state without a second grant;
- mismatched existing referral evidence fails closed and rolls back;
- database constraints reject self-referral and a second referral for the same referred user;
- concurrent activation of the same referred user creates one signup grant and one referral reward;
- no referral reward while either account is unverified;
- referral reward is recovered when the second participant verifies, regardless of verification order.

The workflow runs this suite in a separate disposable database after the wallet RPC hardening migration.

## Verification and deployment boundary

- GitHub Actions Run #377 succeeded on commit `4150489e30c0c743ff488fabeab2fb3dea2bda0a`: [workflow run](https://github.com/behnamrazavi8-ship-it/armex-ai-studio/actions/runs/42668801060). The signup/referral SQL suite, wallet RPC suite, chat reconciliation suite, provider concurrency tests, Deno checks, and frontend syntax checks all passed.
- This is disposable PostgreSQL verification, not a Supabase Production migration or live Auth-trigger integration test.
- No production SQL was changed, no migration was applied, no secrets were changed, and no function was deployed.
- PR #30 remains open and Draft. Do not merge without explicit owner approval.

## Remaining review before rollout

1. Obtain evidence about external/older clients and integrations before retiring the legacy signup credit side effect; do not drop legacy tables or data during this phase.
2. Validate the both-accounts-confirmed referral rule against a staging Supabase project and actual Auth insert/confirmation events.
3. Plan backup, migration ordering, and rollback before production changes.
