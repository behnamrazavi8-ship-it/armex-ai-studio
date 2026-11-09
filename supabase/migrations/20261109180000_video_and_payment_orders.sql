-- LOKAL AI: asynchronous video jobs and idempotent payment orders.
-- This migration is intentionally staged in GitHub only; it is not applied to production.

create table if not exists public.armex_video_generations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  request_id uuid not null,
  prompt text not null check (char_length(prompt) between 1 and 6000),
  model text not null default 'wan2.2-ti2v-5b',
  status text not null default 'queued'
    check (status in ('queued','processing','completed','failed','cancelled')),
  credits_charged bigint not null check (credits_charged > 0),
  provider text not null default 'runpod',
  provider_job_id text,
  result_url text,
  error_code text,
  provider_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint armex_video_generations_user_request_key unique (user_id, request_id),
  constraint armex_video_generations_provider_job_key unique (provider, provider_job_id)
);

create index if not exists armex_video_generations_user_created_idx
  on public.armex_video_generations (user_id, created_at desc);
create index if not exists armex_video_generations_provider_job_idx
  on public.armex_video_generations (provider, provider_job_id)
  where provider_job_id is not null;

alter table public.armex_video_generations enable row level security;
drop policy if exists "Users can view their own video generations" on public.armex_video_generations;
create policy "Users can view their own video generations"
  on public.armex_video_generations for select to authenticated
  using ((select auth.uid()) = user_id);
revoke all on public.armex_video_generations from anon, authenticated;
grant select on public.armex_video_generations to authenticated;
grant all on public.armex_video_generations to service_role;

alter table public.armex_payment_orders
  add column if not exists package_id text,
  add column if not exists idempotency_key text,
  add column if not exists paid_at timestamptz;

create unique index if not exists armex_payment_orders_user_idempotency_idx
  on public.armex_payment_orders (user_id, idempotency_key)
  where idempotency_key is not null;

create unique index if not exists armex_payment_orders_provider_reference_idx
  on public.armex_payment_orders (provider, provider_reference)
  where provider is not null and provider_reference is not null;

