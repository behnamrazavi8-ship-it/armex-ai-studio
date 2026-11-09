-- Durable idempotency guard for chat requests.
-- Staged in PR only. Never apply to the live project without separate approval.

create table if not exists public.armex_chat_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  request_id uuid not null,
  status text not null default 'processing'
    check (status in ('processing','completed','failed')),
  response_payload jsonb,
  failure_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint armex_chat_requests_user_request_key unique (user_id, request_id),
  constraint armex_chat_requests_completed_payload_check
    check ((status = 'completed' and response_payload is not null)
        or (status <> 'completed' and response_payload is null))
);

alter table public.armex_chat_requests enable row level security;

-- This table is accessed only by the trusted Edge Function service-role client.
revoke all on public.armex_chat_requests from anon, authenticated;
grant all on public.armex_chat_requests to service_role;

create or replace function public.armex_claim_chat_request(
  p_user_id uuid,
  p_request_id uuid
)
returns table(outcome text, response_payload jsonb)
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.armex_chat_requests(user_id, request_id, status)
  values (p_user_id, p_request_id, 'processing')
  on conflict (user_id, request_id) do nothing;

  if found then
    return query select 'claimed'::text, null::jsonb;
    return;
  end if;

  return query
  select
    case when r.status = 'completed' then 'completed'
         when r.status = 'failed' then 'failed'
         else 'processing' end::text,
    r.response_payload
  from public.armex_chat_requests r
  where r.user_id = p_user_id and r.request_id = p_request_id;
end;
$$;

create or replace function public.armex_complete_chat_request(
  p_user_id uuid,
  p_request_id uuid,
  p_response_payload jsonb
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  updated_count integer;
begin
  if p_response_payload is null
     or jsonb_typeof(p_response_payload) <> 'object'
     or not exists (
       select 1
       from public.armex_chat_requests r
       where r.user_id = p_user_id
         and r.request_id = p_request_id
         and r.status = 'processing'
         and r.provider_outcome = 'accepted'
         and r.debit_outcome = 'debited'
         and r.provider_response_payload is not null
         and r.recovery_message is not null
         and exists (
           select 1 from public.armex_usage u
           where u.user_id = p_user_id and u.request_id = p_request_id
         )
         and (
           select count(*) from public.armex_messages m
           where m.user_id = p_user_id and m.request_id = p_request_id
         ) = 2
     ) then
    raise exception 'chat request is not eligible for completion';
  end if;

  update public.armex_chat_requests
  set status = 'completed',
      response_payload = p_response_payload,
      failure_code = null,
      completed_at = now(),
      updated_at = now()
  where user_id = p_user_id
    and request_id = p_request_id
    and status = 'processing';

  get diagnostics updated_count = row_count;
  return updated_count = 1;
end;
$$;

create or replace function public.armex_fail_chat_request(
  p_user_id uuid,
  p_request_id uuid,
  p_failure_code text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  updated_count integer;
begin
  update public.armex_chat_requests
  set status = 'failed',
      failure_code = left(coalesce(p_failure_code, 'request_failed'), 80),
      response_payload = null,
      updated_at = now()
  where user_id = p_user_id
    and request_id = p_request_id
    and status = 'processing';

  get diagnostics updated_count = row_count;
  return updated_count = 1;
end;
$$;

revoke all on function public.armex_claim_chat_request(uuid, uuid) from public, anon, authenticated;
revoke all on function public.armex_complete_chat_request(uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.armex_fail_chat_request(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.armex_claim_chat_request(uuid, uuid) to service_role;
grant execute on function public.armex_complete_chat_request(uuid, uuid, jsonb) to service_role;
grant execute on function public.armex_fail_chat_request(uuid, uuid, text) to service_role;
