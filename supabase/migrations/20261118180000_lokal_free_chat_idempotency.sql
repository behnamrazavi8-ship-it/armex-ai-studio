-- Free Smart Chat with atomic request claiming and durable provider evidence.
-- This migration is intentionally additive: existing wallet/image billing is untouched.

alter table public.armex_messages
  add column if not exists request_id uuid;

create unique index if not exists armex_messages_user_request_role_key
  on public.armex_messages(user_id, request_id, role)
  where request_id is not null;

create table if not exists public.armex_chat_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  request_id uuid not null unique,
  status text not null default 'processing'
    check (status in ('processing', 'completed', 'failed')),
  message text,
  model text,
  conversation_id uuid references public.armex_conversations(id) on delete set null,
  credits bigint not null default 0 check (credits >= 0),
  attempt_id uuid,
  prompt_price numeric,
  completion_price numeric,
  estimated_input_tokens integer not null default 0 check (estimated_input_tokens >= 0),
  provider_outcome text not null default 'not_started'
    check (provider_outcome in ('not_started', 'accepted', 'rejected', 'unknown')),
  debit_outcome text not null default 'not_charged'
    check (debit_outcome in ('not_charged', 'debited', 'unknown')),
  provider_http_status integer,
  provider_response_payload jsonb,
  diagnostic_code text,
  failure_code text,
  response_payload jsonb,
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint armex_chat_requests_free_chat_only check (credits = 0 and debit_outcome = 'not_charged')
);

create index if not exists armex_chat_requests_user_date_idx
  on public.armex_chat_requests(user_id, started_at desc);

alter table public.armex_chat_requests enable row level security;
revoke all on table public.armex_chat_requests from public, anon, authenticated;
grant all on table public.armex_chat_requests to service_role;

create or replace function public.armex_claim_chat_request(
  p_user_id uuid,
  p_request_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request public.armex_chat_requests%rowtype;
  v_inserted integer;
begin
  if p_user_id is null or p_request_id is null then
    raise exception 'Invalid chat request claim parameters';
  end if;

  insert into public.armex_chat_requests(user_id, request_id)
  values (p_user_id, p_request_id)
  on conflict (request_id) do nothing;
  get diagnostics v_inserted = row_count;

  if v_inserted = 1 then
    return jsonb_build_object('outcome', 'claimed');
  end if;

  select * into v_request
  from public.armex_chat_requests
  where request_id = p_request_id
  for update;

  if not found or v_request.user_id <> p_user_id then
    return jsonb_build_object('outcome', 'failed');
  end if;

  if v_request.status = 'completed' then
    return jsonb_build_object(
      'outcome', 'completed',
      'response_payload', v_request.response_payload
    );
  elsif v_request.status = 'failed' then
    return jsonb_build_object('outcome', 'failed');
  end if;

  return jsonb_build_object('outcome', 'processing');
end;
$$;

create or replace function public.armex_set_chat_recovery_metadata(
  p_user_id uuid,
  p_request_id uuid,
  p_message text,
  p_model text,
  p_conversation_id uuid,
  p_credits bigint,
  p_attempt_id uuid,
  p_prompt_price numeric,
  p_completion_price numeric,
  p_estimated_input_tokens integer
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_credits is distinct from 0 or p_user_id is null or p_request_id is null
     or p_attempt_id is null or nullif(trim(p_message), '') is null
     or nullif(trim(p_model), '') is null then
    raise exception 'Invalid free chat recovery metadata';
  end if;

  update public.armex_chat_requests
  set message = p_message,
      model = p_model,
      conversation_id = p_conversation_id,
      credits = 0,
      attempt_id = p_attempt_id,
      prompt_price = p_prompt_price,
      completion_price = p_completion_price,
      estimated_input_tokens = greatest(coalesce(p_estimated_input_tokens, 0), 0),
      updated_at = now()
  where user_id = p_user_id
    and request_id = p_request_id
    and status = 'processing';

  return found;
end;
$$;

create or replace function public.armex_record_chat_provider_evidence(
  p_user_id uuid,
  p_request_id uuid,
  p_provider_outcome text,
  p_debit_outcome text,
  p_provider_http_status integer,
  p_provider_response_payload jsonb,
  p_diagnostic_code text
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_provider_outcome is null
     or p_provider_outcome not in ('not_started', 'accepted', 'rejected', 'unknown')
     or p_debit_outcome is distinct from 'not_charged'
     or (p_provider_response_payload is not null
         and octet_length(p_provider_response_payload::text) > 1048576) then
    raise exception 'Invalid free chat provider evidence';
  end if;

  update public.armex_chat_requests
  set provider_outcome = case
        when provider_outcome = 'accepted' and p_provider_outcome = 'unknown'
          then provider_outcome
        else p_provider_outcome
      end,
      debit_outcome = 'not_charged',
      provider_http_status = coalesce(p_provider_http_status, provider_http_status),
      provider_response_payload = coalesce(p_provider_response_payload, provider_response_payload),
      diagnostic_code = coalesce(p_diagnostic_code, diagnostic_code),
      updated_at = now()
  where user_id = p_user_id
    and request_id = p_request_id
    and status = 'processing';

  return found;
end;
$$;

create or replace function public.armex_fail_chat_request(
  p_user_id uuid,
  p_request_id uuid,
  p_failure_code text
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.armex_chat_requests
  set status = 'failed',
      failure_code = left(coalesce(nullif(trim(p_failure_code), ''), 'request_failed'), 120),
      updated_at = now()
  where user_id = p_user_id
    and request_id = p_request_id
    and status = 'processing'
    and provider_outcome in ('not_started', 'rejected');

  return found;
end;
$$;

create or replace function public.armex_persist_chat_response_atomic(
  p_user_id uuid,
  p_request_id uuid,
  p_lease_token uuid,
  p_answer text,
  p_model text,
  p_input_tokens integer,
  p_output_tokens integer,
  p_total_tokens integer,
  p_actual_cost_usd numeric,
  p_finish_reason text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request public.armex_chat_requests%rowtype;
  v_conversation_id uuid;
  v_title text;
  v_response jsonb;
begin
  if p_user_id is null or p_request_id is null
     or nullif(trim(p_answer), '') is null
     or nullif(trim(p_model), '') is null then
    raise exception 'Invalid chat response persistence parameters';
  end if;

  select * into v_request
  from public.armex_chat_requests
  where user_id = p_user_id and request_id = p_request_id
  for update;

  if not found then
    raise exception 'Chat request claim not found';
  end if;

  if v_request.status = 'completed' then
    return v_request.response_payload;
  end if;

  if v_request.status <> 'processing'
     or v_request.provider_outcome <> 'accepted'
     or v_request.credits <> 0
     or v_request.debit_outcome <> 'not_charged'
     or v_request.message is null then
    raise exception 'Chat request is not ready for atomic persistence';
  end if;

  v_conversation_id := v_request.conversation_id;
  if v_conversation_id is null then
    v_title := left(regexp_replace(v_request.message, '\s+', ' ', 'g'), 80);
    insert into public.armex_conversations(user_id, title, model)
    values (p_user_id, coalesce(nullif(v_title, ''), 'گفتگوی جدید'), p_model)
    returning id into v_conversation_id;
  else
    perform 1
    from public.armex_conversations
    where id = v_conversation_id and user_id = p_user_id
    for update;
    if not found then
      raise exception 'Conversation not found for chat request';
    end if;
  end if;

  insert into public.armex_messages(
    conversation_id, user_id, role, content, model, request_id
  ) values
    (v_conversation_id, p_user_id, 'user', v_request.message, p_model, p_request_id),
    (v_conversation_id, p_user_id, 'assistant', p_answer, p_model, p_request_id);

  insert into public.armex_usage(
    user_id, conversation_id, model, input_tokens, output_tokens,
    total_tokens, actual_cost_usd, credits_charged, request_id
  ) values (
    p_user_id, v_conversation_id, p_model,
    greatest(coalesce(p_input_tokens, 0), 0),
    greatest(coalesce(p_output_tokens, 0), 0),
    greatest(coalesce(p_total_tokens, 0), 0),
    p_actual_cost_usd, 0, p_request_id
  );

  update public.armex_conversations
  set model = p_model, updated_at = now()
  where id = v_conversation_id and user_id = p_user_id;

  v_response := jsonb_build_object(
    'success', true,
    'request_id', p_request_id,
    'conversation_id', v_conversation_id,
    'model', p_model,
    'answer', p_answer,
    'usage', jsonb_build_object(
      'input_tokens', greatest(coalesce(p_input_tokens, 0), 0),
      'output_tokens', greatest(coalesce(p_output_tokens, 0), 0),
      'total_tokens', greatest(coalesce(p_total_tokens, 0), 0),
      'actual_cost_usd', p_actual_cost_usd,
      'credits_charged', 0
    ),
    'finish_reason', p_finish_reason
  );

  update public.armex_chat_requests
  set status = 'completed',
      conversation_id = v_conversation_id,
      response_payload = v_response,
      completed_at = now(),
      updated_at = now()
  where user_id = p_user_id and request_id = p_request_id;

  return v_response;
end;
$$;

revoke all on function public.armex_claim_chat_request(uuid, uuid) from public, anon, authenticated;
revoke all on function public.armex_set_chat_recovery_metadata(uuid, uuid, text, text, uuid, bigint, uuid, numeric, numeric, integer) from public, anon, authenticated;
revoke all on function public.armex_record_chat_provider_evidence(uuid, uuid, text, text, integer, jsonb, text) from public, anon, authenticated;
revoke all on function public.armex_fail_chat_request(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.armex_persist_chat_response_atomic(uuid, uuid, uuid, text, text, integer, integer, integer, numeric, text) from public, anon, authenticated;

grant execute on function public.armex_claim_chat_request(uuid, uuid) to service_role;
grant execute on function public.armex_set_chat_recovery_metadata(uuid, uuid, text, text, uuid, bigint, uuid, numeric, numeric, integer) to service_role;
grant execute on function public.armex_record_chat_provider_evidence(uuid, uuid, text, text, integer, jsonb, text) to service_role;
grant execute on function public.armex_fail_chat_request(uuid, uuid, text) to service_role;
grant execute on function public.armex_persist_chat_response_atomic(uuid, uuid, uuid, text, text, integer, integer, integer, numeric, text) to service_role;
