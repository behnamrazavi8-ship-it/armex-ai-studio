-- Minimal disposable schema for testing the real wallet RPC migration.
create extension if not exists pgcrypto;
do $roles$
begin
  if not exists(select 1 from pg_roles where rolname='anon') then create role anon; end if;
  if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
  if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role; end if;
end
$roles$;
create schema if not exists auth;
create table if not exists auth.users(id uuid primary key);
create table if not exists public.armex_wallets(
  user_id uuid primary key references auth.users(id),
  balance bigint not null default 0 check(balance>=0),
  updated_at timestamptz not null default now()
);
create table if not exists public.armex_credit_transactions(
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  amount bigint not null check(amount<>0),
  transaction_type text not null,
  idempotency_key text not null,
  description text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint armex_credit_transactions_user_id_idempotency_key_key unique(user_id,idempotency_key)
);
grant select on public.armex_wallets,public.armex_credit_transactions to authenticated;
grant select on public.armex_wallets,public.armex_credit_transactions to service_role;
