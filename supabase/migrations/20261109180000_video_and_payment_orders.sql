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
  refund_status text not null default 'not_required' check (refund_status in ('not_required','pending','completed')),
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
  add column if not exists paid_at timestamptz,
  add column if not exists provider_metadata jsonb not null default '{}'::jsonb;

-- The unauthenticated provider callback uses the service-role client.
-- RLS bypass does not replace SQL table privileges, so grant only the
-- operations required by order creation, callback verification, and recovery.
grant select, insert, update on public.armex_payment_orders to service_role;

create unique index if not exists armex_payment_orders_user_idempotency_idx
  on public.armex_payment_orders (user_id, idempotency_key)
  where idempotency_key is not null;

create unique index if not exists armex_payment_orders_provider_reference_idx
  on public.armex_payment_orders (provider, provider_reference)
  where provider is not null and provider_reference is not null;


-- A pending order with a known Authority is still an open payment session.
-- Permit only one pending Zarinpal order per user until callback verification
-- or a confirmed cancellation resolves it. Existing duplicates need review.
do $block$
begin
  if exists (
    select 1
    from public.armex_payment_orders
    where provider = 'zarinpal'
      and status = 'pending'
    group by user_id
    having count(*) > 1
  ) then
    raise exception 'Cannot add Zarinpal pending-order guard: duplicate pending orders require manual reconciliation first';
  end if;
end
$block$;

create unique index if not exists armex_payment_orders_one_pending_per_user_idx
  on public.armex_payment_orders (user_id)
  where provider = 'zarinpal'
    and status = 'pending';
