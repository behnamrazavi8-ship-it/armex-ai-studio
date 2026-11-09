# Signup and referral credit audit

**Status:** staged on `feat/video-and-zarinpal-integration`; not deployed.

## Live Supabase inspection (read-only, 2026-11-09)

- `auth.users` has two active non-internal triggers:
  - `armex_auth_user_handler_trigger`: after insert or update of `email_confirmed_at`.
  - `on_auth_user_created`: after insert.
- `armex_auth_user_handler` creates the wallet and a unique referral code idempotently, accepts a referral code from the new user's metadata only on INSERT, rejects self-referral, and creates at most one referral row per referred user.
- The same handler calls `armex_activate_user` only when an account is already confirmed at INSERT or transitions from unconfirmed to confirmed.
- `armex_activate_user` grants 500 wallet credits with stable key `signup_bonus:{user_id}`; it qualifies pending referrals and grants 200 credits to the referrer with key `referral_bonus:{referral_id}`.
- Database constraints enforce unique referral codes, one referral per referred user, and no self-referral.
- `armex_activate_user` is executable only by its owner role in the inspected ACL; the wallet grant RPC is executable by `service_role` and its owner, not `anon` or `authenticated`.
- The live `armex_grant_credits` currently returns false for any existing idempotency key without checking amount/type. The staged wallet migration `20261109240000_wallet_rpc_idempotency_hardening.sql` tightens that behavior.
- The legacy `on_auth_user_created` trigger calls `handle_new_user`, which inserts a `profiles` row and grants 500 credits into the separate legacy `credit_transactions` / `profiles.credits` ledger immediately on Auth INSERT, before email confirmation. The active frontend and `armex-api` Edge Function do not read `profiles` or the legacy ledger; they use the wallet RPC and `armex_credit_transactions`.
- Aggregate inspection found one user with a signup bonus in each ledger and no referral rows at inspection time. The two signup entries are separate ledgers; this does not mean the active wallet balance is doubled. Legacy tables and data are intentionally preserved pending a full dependency/decommission review.

## Staged hardening

Migration `20261109250000_signup_referral_idempotency_hardening.sql`:

- Requires a confirmed Auth user before activation.
- Keeps the stable 500-credit signup idempotency key.
- Processes both pending and qualified referrals under row locks.
- After a duplicate referral grant, verifies exact durable ledger evidence (amount, type, referral ID) before marking the referral rewarded.
- Raises a uniqueness conflict and rolls back the state transition if the existing ledger evidence does not match.
- Keeps the activation RPC unavailable to public client roles.

## Disposable PostgreSQL coverage

`supabase/tests/signup-referral-fixture.sql` and `signup-referral-invariants.sql` cover:

- no signup grant for unconfirmed users;
- repeated signup activation grants 500 only once;
- repeated referral activation grants 200 only once;
- exact existing referral ledger evidence reconciles referral state without a second grant;
- mismatched existing referral evidence fails closed and rolls back;
- database constraints reject self-referral and a second referral for the same referred user;
- concurrent activation of the same referred user creates one signup grant and one referral reward.

The workflow runs this suite in a separate disposable database after the wallet RPC hardening migration.

## Verification and deployment boundary

- GitHub Actions Run #370 succeeded on commit `056c01148bea171702ffe382f69c1390b779b3a7`: [workflow run](https://github.com/behnamrazavi8-ship-it/armex-ai-studio/actions/runs/42665079411).
- This is disposable PostgreSQL verification, not a Supabase Production migration or live Auth-trigger integration test.
- No production SQL was changed, no migration was applied, no secrets were changed, and no function was deployed.
- PR #30 remains open and Draft. Do not merge without explicit owner approval.

## Remaining review before rollout

1. Decide when to retire the legacy signup credit side effect, only after confirming no external/older client still depends on `profiles.credits` or `credit_transactions`.
2. Review whether referral rewards should require the referrer account itself to be confirmed, and define how a referral is recovered if the referrer confirms after the referred account.
3. Validate the migration against a staging Supabase branch and actual Auth insert/confirmation events before any production rollout.
4. Plan backup, migration ordering, and rollback before production changes.
