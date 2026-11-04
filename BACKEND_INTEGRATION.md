# LOKAL AI — Backend Integration Plan

## Verified repository state

At the time this document was added, the repository contained only `index.html` and `README.md`. The frontend is a static HTML/CSS/JavaScript preview. No Supabase project configuration, migrations, Edge Function source, provider configuration, or payment integration was present in this repository.

The GitHub connector provides access to this repository only. It does not grant access to the user's Supabase dashboard or database. Therefore, this document is an implementation plan, not a claim that database changes have been deployed.

## Frontend preview boundaries

The current page supports local prompt composition and browser-local project saving. The 500-credit display is explicitly a placeholder. There is no real sign-in, generation request, account balance, referral reward, or payment operation yet.

## Target architecture

1. Static frontend served over HTTPS.
2. Supabase Auth for user identity.
3. Supabase Postgres with RLS for profiles, projects, credit ledger, and referrals.
4. Supabase Edge Functions for all privileged operations.
5. AI provider credentials stored only as Edge Function secrets.
6. Payment provider integration through server-verified callbacks/webhooks.
7. Optional object storage for generated media, with private buckets and signed URLs.

## Proposed data model

These are proposed entities and must be reconciled with the existing Supabase schema before any migration is run. Do not blindly apply duplicate tables or policies.

### profiles
- `id uuid primary key references auth.users(id)`
- `display_name text`
- `created_at timestamptz`
- `updated_at timestamptz`

### credit_accounts
- `user_id uuid primary key references auth.users(id)`
- `balance bigint not null default 0 check (balance >= 0)`
- `updated_at timestamptz not null default now()`

### credit_transactions
- `id uuid primary key`
- `user_id uuid not null references auth.users(id)`
- `amount bigint not null check (amount <> 0)`
- `kind text not null` — signup_bonus, referral_bonus, generation_debit, refund, purchase, admin_adjustment
- `reference_id text`
- `idempotency_key text unique`
- `metadata jsonb not null default '{}'`
- `created_at timestamptz not null default now()`

Transactions should be append-only for normal users. The balance must be updated in the same database transaction as its ledger entry, through a trusted function/RPC. Never let the browser directly set a balance.

### projects
- `id uuid primary key`
- `user_id uuid not null references auth.users(id)`
- `title text not null`
- `kind text not null`
- `prompt text not null`
- `settings jsonb not null default '{}'`
- `result_asset_path text`
- `created_at timestamptz not null default now()`
- `updated_at timestamptz not null default now()`

### referrals
- `id uuid primary key`
- `referrer_user_id uuid not null references auth.users(id)`
- `referred_user_id uuid not null unique references auth.users(id)`
- `referral_code text not null`
- `status text not null` — pending, qualified, rejected
- `qualified_at timestamptz`
- `created_at timestamptz not null default now()`

## Credit policy to implement

- Signup: grant 500 credits once per newly created account, server-side, idempotently.
- Referral: grant 200 credits to the referrer only after the referred account qualifies.
- Do not award referral credits merely because a client submits a referral code.
- Qualification and anti-abuse rules remain a product decision. Recommended safeguards include one reward per referred account, unique verified identity, rate limits, suspicious-device/payment review, self-referral blocking, and delayed qualification until a meaningful qualifying action.
- Every grant/debit/refund must have an immutable ledger record and a unique idempotency key.
- Generation debit should happen atomically before provider execution; failures should create a compensating refund, also idempotently.

## Edge Function boundaries

Expected server-side functions (names are suggestions; inspect existing deployed functions before creating or renaming anything):
- `create-profile`: create profile and grant the one-time signup bonus.
- `generate-content`: authenticate user, validate input, calculate cost, debit credits, call provider, persist result, refund on failure.
- `apply-referral`: validate referral code and create pending referral.
- `qualify-referral`: trusted server-side qualification and 200-credit award.
- `payment-create`: create a payment intent/order using server-side credentials.
- `payment-webhook`: verify provider signature and settle the purchase idempotently.

Provider API keys, Supabase service-role key, and payment secrets must exist only as server-side secrets. Never expose them in `index.html`, public GitHub files, or client-side JavaScript.

## RLS requirements

- Profiles: authenticated users can read/update only their own profile; prevent client-side role or balance changes.
- Credit accounts: users may read their own balance; no direct client writes.
- Credit transactions: users may read their own ledger; no direct insert/update/delete.
- Projects: users may CRUD only rows where `user_id = auth.uid()`.
- Referrals: users may see only referrals where they are the referrer or referred user; all qualification and reward writes are server-side.
- Storage: private by default; scope access to the authenticated user's folder.

## Safe implementation sequence

1. Inspect the live Supabase schema, policies, existing Edge Functions, and deployed secrets without printing secret values.
2. Map existing objects to this target model; preserve working tables and functions.
3. Prepare a single migration that only adds or alters what is genuinely missing.
4. Test signup idempotency, RLS isolation, credit concurrency, duplicate webhooks, referral abuse cases, and provider failure refunds.
5. Deploy Edge Functions and configure secrets through the Supabase dashboard/CLI.
6. Connect the frontend to the deployed function URLs using only public/anon configuration.
7. Run end-to-end tests before enabling real payments or advertising real generation.

## Acceptance checklist

- [ ] Existing schema and Edge Functions reviewed before migration.
- [ ] Signup bonus is granted once only.
- [ ] Referral reward is 200 credits only after server-side qualification.
- [ ] Client cannot modify balance or ledger.
- [ ] Concurrent generation requests cannot overspend.
- [ ] Failed provider jobs refund exactly once.
- [ ] RLS tests confirm users cannot access another user's data.
- [ ] Provider secrets are not present in browser assets or Git history.
- [ ] Payment webhooks are signature-verified and idempotent.
- [ ] Real generation and payment flows pass end-to-end tests.
