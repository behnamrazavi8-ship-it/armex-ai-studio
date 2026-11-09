-- Disposable PostgreSQL fixture for payment and video callback races.
-- Synthetic data only; never connects to Supabase or production.
-- Keep the existing payment-order shape aligned with the read-only Production catalog.
create extension if not exists pgcrypto;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end
$$;

create schema if not exists auth;
create table if not exists auth.users (
  id uuid primary key default gen_random_uuid()
);
create or replace function auth.uid()
returns uuid
language sql
stable
as $fn$
  select null::uuid
$fn$;

create table if not exists public.armex_payment_orders (
  id uuid not null default gen_random_uuid(),
  user_id uuid not null,
  amount numeric not null,
  currency text not null default 'IRR',
  credits bigint not null,
  provider text,
  provider_reference text,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint armex_payment_orders_pkey primary key (id),
  constraint armex_payment_orders_user_id_fkey
    foreign key (user_id) references auth.users(id) on delete cascade,
  constraint armex_payment_orders_amount_check check (amount > 0),
  constraint armex_payment_orders_credits_check check (credits > 0),
  constraint armex_payment_orders_status_check
    check (status in ('pending', 'paid', 'failed', 'cancelled', 'refunded'))
);

-- Match the two indexes present in the Production catalog before staged additions.
create index if not exists armex_orders_user_date_idx
  on public.armex_payment_orders (user_id, created_at desc);

create table if not exists public.armex_credit_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  amount bigint,
  transaction_type text check (transaction_type in ('purchase', 'refund', 'usage')),
  idempotency_key text not null unique,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

grant usage on schema public, auth to service_role;
grant select on auth.users to service_role;

-- Intentionally start without service_role access; the staged migration must add it.
revoke all on public.armex_payment_orders from service_role;
grant select, insert, update, delete on public.armex_credit_transactions to service_role;

-- Minimal Storage catalog fixture for the staged private-video bucket migration.
create schema if not exists storage;
create table if not exists storage.buckets (
  id text primary key,
  name text not null,
  public boolean not null default false,
  file_size_limit bigint,
  allowed_mime_types text[]
);
