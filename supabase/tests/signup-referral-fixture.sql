-- Isolated schema for signup/referral activation tests.
create extension if not exists pgcrypto;
create extension if not exists dblink;

do $roles$
begin
  if not exists(select 1 from pg_roles where rolname='anon') then create role anon; end if;
  if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
  if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role; end if;
end
$roles$;

create schema if not exists auth;
create table auth.users(
  id uuid primary key,
  email_confirmed_at timestamptz,
  raw_user_meta_data jsonb not null default '{}'::jsonb
);
create table public.armex_wallets(
  user_id uuid primary key references auth.users(id),
  balance bigint not null default 0 check(balance>=0),
  updated_at timestamptz not null default now()
);
create table public.armex_credit_transactions(
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
create table public.armex_referral_codes(
  user_id uuid primary key references auth.users(id),
  code text not null unique,
  created_at timestamptz not null default now()
);
create table public.armex_referrals(
  id uuid primary key default gen_random_uuid(),
  referrer_user_id uuid not null references auth.users(id),
  referred_user_id uuid not null unique references auth.users(id),
  referral_code text not null,
  status text not null default 'pending'
    check(status in ('pending','qualified','rewarded','rejected')),
  created_at timestamptz not null default now(),
  qualified_at timestamptz,
  rewarded_at timestamptz,
  constraint armex_referrals_no_self_referral check(referrer_user_id<>referred_user_id)
);
