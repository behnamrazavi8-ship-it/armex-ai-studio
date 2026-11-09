-- Disposable PostgreSQL fixture for the staged chat reconciliation migrations.
-- Minimal compatibility harness; intentionally not a copy of production data.
create extension if not exists pgcrypto;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;

create schema if not exists auth;
create table if not exists auth.users (
  id uuid primary key default gen_random_uuid()
);

create table if not exists public.armex_conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null default 'گفتگوی جدید',
  model text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.armex_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.armex_conversations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('user','assistant','system')),
  content text not null,
  model text,
  input_tokens integer,
  output_tokens integer,
  created_at timestamptz not null default now()
);

create table if not exists public.armex_usage (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  conversation_id uuid references public.armex_conversations(id) on delete set null,
  model text not null,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  total_tokens integer not null default 0,
  actual_cost_usd numeric,
  credits_charged bigint not null default 0,
  request_id uuid unique,
  created_at timestamptz not null default now()
);

alter table public.armex_conversations enable row level security;
alter table public.armex_messages enable row level security;
alter table public.armex_usage enable row level security;

grant usage on schema public, auth to service_role;
grant select, insert, update, delete on public.armex_conversations, public.armex_messages, public.armex_usage to service_role;
grant select on auth.users to service_role;
