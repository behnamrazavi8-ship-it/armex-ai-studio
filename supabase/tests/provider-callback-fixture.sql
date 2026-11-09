-- Disposable PostgreSQL fixture for payment and video callback races.
-- Synthetic data only; never connects to Supabase or production.
create extension if not exists pgcrypto;
do $$ begin
 if not exists(select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
 if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
 if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
end $$;
create schema if not exists auth;
create table if not exists auth.users(id uuid primary key default gen_random_uuid());
create or replace function auth.uid() returns uuid language sql stable as $fn$ select null::uuid $fn$;
create table if not exists public.armex_payment_orders(
 id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
 amount bigint not null check(amount>0), currency text not null, credits bigint not null check(credits>0),
 provider text not null, provider_reference text, status text not null default 'pending',
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists public.armex_credit_transactions(
 id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
 amount bigint, transaction_type text check(transaction_type in ('purchase','refund','usage')),
 idempotency_key text not null unique, metadata jsonb not null default '{}'::jsonb,
 created_at timestamptz not null default now()
);
grant usage on schema public,auth to service_role;
grant select on auth.users to service_role;
-- Intentionally start without service_role access; the staged migration must add it.
revoke all on public.armex_payment_orders from service_role;
grant select,insert,update,delete on public.armex_credit_transactions to service_role;
