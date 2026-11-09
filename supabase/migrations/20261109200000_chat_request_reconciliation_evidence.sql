-- Durable evidence and lease primitives for chat-request reconciliation.
-- Staged in the experimental PR only. Do not apply to production without review.

alter table public.armex_chat_requests
  add column if not exists provider_outcome text not null default 'unknown'
    check (provider_outcome in ('not_started','unknown','rejected','accepted')),
  add column if not exists debit_outcome text not null default 'unknown'
    check (debit_outcome in ('not_attempted','not_debited','debited','unknown')),
  add column if not exists provider_http_status integer,
  add column if not exists provider_response_payload jsonb,
  add column if not exists reconciliation_attempts integer not null default 0
    check (reconciliation_attempts >= 0),
  add column if not exists reconciliation_lease_token uuid,
  add column if not exists reconciliation_lease_expires_at timestamptz,
  add column if not exists reconciled_at timestamptz,
  add column if not exists diagnostic_code text;

create index if not exists armex_chat_requests_reconcile_idx
  on public.armex_chat_requests (updated_at, reconciliation_lease_expires_at)
  where status = 'processing';

create or replace function public.armex_record_chat_provider_evidence(
  p_user_id uuid,
  p_request_id uuid,
  p_provider_outcome text,
  p_debit_outcome text,
  p_provider_http_status integer default null,
  p_provider_response_payload jsonb default null,
  p_diagnostic_code text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  updated_count integer;
begin
  if p_provider_outcome not in ('not_started','unknown','rejected','accepted')
     or p_debit_outcome not in ('not_attempted','not_debited','debited','unknown') then
    raise exception 'invalid chat request evidence';
  end if;

  if p_provider_response_payload is not null and p_provider_outcome <> 'accepted' then
    raise exception 'provider response snapshot requires accepted outcome';
  end if;

  update public.armex_chat_requests
  set provider_outcome = p_provider_outcome,
      debit_outcome = p_debit_outcome,
      provider_http_status = p_provider_http_status,
      provider_response_payload = coalesce(p_provider_response_payload, provider_response_payload),
      diagnostic_code = left(p_diagnostic_code, 80),
      updated_at = now()
  where user_id = p_user_id
    and request_id = p_request_id
    and status = 'processing'
    and (provider_outcome <> 'accepted' or p_provider_outcome = 'accepted')
    and (debit_outcome <> 'debited' or p_debit_outcome = 'debited');

  get diagnostics updated_count = row_count;
  return updated_count = 1;
end;
$$;

-- Atomic lease claim. SKIP LOCKED prevents two reconcilers claiming one row.
-- Ambiguous provider outcomes are deliberately excluded from automatic work.
create or replace function public.armex_claim_chat_reconciliation(
  p_limit integer default 10,
  p_lease_seconds integer default 120
)
returns table(
  user_id uuid,
  request_id uuid,
  provider_outcome text,
  debit_outcome text,
  provider_http_status integer,
  provider_response_payload jsonb,
  response_payload jsonb,
  reconciliation_lease_token uuid,
  reconciliation_attempts integer
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_limit < 1 or p_limit > 50 or p_lease_seconds < 30 or p_lease_seconds > 900 then
    raise exception 'invalid reconciliation lease parameters';
  end if;

  return query
  with candidates as (
    select r.id
    from public.armex_chat_requests r
    where r.status = 'processing'
      and r.provider_outcome in ('not_started','accepted','rejected')
      and (r.reconciliation_lease_expires_at is null
           or r.reconciliation_lease_expires_at < now())
    order by r.updated_at asc
    for update skip locked
    limit p_limit
  ),
  claimed as (
    update public.armex_chat_requests r
    set reconciliation_lease_token = gen_random_uuid(),
        reconciliation_lease_expires_at = now() + make_interval(secs => p_lease_seconds),
        reconciliation_attempts = r.reconciliation_attempts + 1,
        updated_at = now()
    from candidates c
    where r.id = c.id
    returning r.*
  )
  select c.user_id, c.request_id, c.provider_outcome, c.debit_outcome,
         c.provider_http_status, c.provider_response_payload, c.response_payload,
         c.reconciliation_lease_token, c.reconciliation_attempts
  from claimed c;
end;
$$;

create or replace function public.armex_release_chat_reconciliation(
  p_user_id uuid,
  p_request_id uuid,
  p_lease_token uuid,
  p_diagnostic_code text default null
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
  set reconciliation_lease_token = null,
      reconciliation_lease_expires_at = null,
      diagnostic_code = left(p_diagnostic_code, 80),
      updated_at = now()
  where user_id = p_user_id
    and request_id = p_request_id
    and status = 'processing'
    and reconciliation_lease_token = p_lease_token;

  get diagnostics updated_count = row_count;
  return updated_count = 1;
end;
$$;

revoke all on function public.armex_record_chat_provider_evidence(uuid,uuid,text,text,integer,jsonb,text) from public, anon, authenticated;
revoke all on function public.armex_claim_chat_reconciliation(integer,integer) from public, anon, authenticated;
revoke all on function public.armex_release_chat_reconciliation(uuid,uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.armex_record_chat_provider_evidence(uuid,uuid,text,text,integer,jsonb,text) to service_role;
grant execute on function public.armex_claim_chat_reconciliation(integer,integer) to service_role;
grant execute on function public.armex_release_chat_reconciliation(uuid,uuid,uuid,text) to service_role;
