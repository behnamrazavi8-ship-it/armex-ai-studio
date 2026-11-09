-- Atomic, idempotent persistence for accepted chat responses.
-- Staged in the experimental PR only. Do not apply to production without separate approval.

alter table public.armex_messages
  add column if not exists request_id uuid;

-- Legacy messages keep request_id NULL; only newly persisted chat requests
-- participate in this uniqueness guard.
create unique index if not exists armex_messages_user_request_role_key
  on public.armex_messages (user_id, request_id, role)
  where request_id is not null and role in ('user', 'assistant');

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
  p_finish_reason text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_request public.armex_chat_requests%rowtype;
  v_conversation_id uuid;
  v_message_count integer;
  v_user_message_count integer;
  v_assistant_message_count integer;
  v_existing_usage public.armex_usage%rowtype;
  v_usage_found boolean := false;
  v_payload jsonb;
  v_result_model text;
  v_user_message_at timestamptz;
begin
  if p_answer is null or char_length(p_answer) = 0
     or p_model is null or char_length(p_model) not between 1 and 160
     or p_input_tokens is null or p_input_tokens < 0
     or p_output_tokens is null or p_output_tokens < 0
     or p_total_tokens is null or p_total_tokens < 0
     or (p_actual_cost_usd is not null and p_actual_cost_usd < 0) then
    raise exception 'invalid chat persistence payload';
  end if;

  select r.*
  into v_request
  from public.armex_chat_requests r
  where r.user_id = p_user_id
    and r.request_id = p_request_id
  for update;

  if not found then
    raise exception 'chat request not found';
  end if;

  if v_request.status = 'completed' then
    return v_request.response_payload;
  end if;

  if v_request.status <> 'processing'
     or v_request.provider_outcome <> 'accepted'
     or v_request.debit_outcome <> 'debited'
     or v_request.provider_response_payload is null
     or v_request.recovery_message is null
     or v_request.recovery_credits is null
     or v_request.recovery_credits < 1 then
    raise exception 'chat request is not eligible for accepted-response persistence';
  end if;

  if v_request.reconciliation_lease_token is distinct from p_lease_token then
    raise exception 'chat reconciliation lease mismatch';
  end if;

  v_result_model := coalesce(nullif(p_model, ''), v_request.recovery_model);

  if v_request.recovery_conversation_id is null then
    insert into public.armex_conversations (user_id, title, model)
    values (
      p_user_id,
      left(regexp_replace(v_request.recovery_message, '\s+', ' ', 'g'), 80),
      v_result_model
    )
    returning id into v_conversation_id;

    update public.armex_chat_requests
    set recovery_conversation_id = v_conversation_id,
        updated_at = now()
    where id = v_request.id;
  else
    v_conversation_id := v_request.recovery_conversation_id;
    perform 1
    from public.armex_conversations c
    where c.id = v_conversation_id
      and c.user_id = p_user_id;
    if not found then
      raise exception 'recovery conversation is missing or not owned by user';
    end if;
  end if;

  select count(*),
         count(*) filter (where m.conversation_id = v_conversation_id and m.role = 'user' and m.content = v_request.recovery_message),
         count(*) filter (where m.conversation_id = v_conversation_id and m.role = 'assistant' and m.content = p_answer)
  into v_message_count, v_user_message_count, v_assistant_message_count
  from public.armex_messages m
  where m.user_id = p_user_id
    and m.request_id = p_request_id;

  select u.*
  into v_existing_usage
  from public.armex_usage u
  where u.request_id = p_request_id
  for update;

  v_usage_found := found;

  if v_usage_found and v_message_count = 0 then
    raise exception 'usage exists without request-linked messages; manual review required';
  end if;

  if v_message_count = 0 then
    v_user_message_at := clock_timestamp();
    insert into public.armex_messages (
      conversation_id, user_id, request_id, role, content, model, created_at
    ) values (
      v_conversation_id, p_user_id, p_request_id, 'user',
      v_request.recovery_message, v_request.recovery_model, v_user_message_at
    );

    insert into public.armex_messages (
      conversation_id, user_id, request_id, role, content, model,
      input_tokens, output_tokens, created_at
    ) values (
      v_conversation_id, p_user_id, p_request_id, 'assistant',
      p_answer, v_result_model, p_input_tokens, p_output_tokens,
      v_user_message_at + interval '1 millisecond'
    );
  elsif v_message_count <> 2
     or v_user_message_count <> 1
     or v_assistant_message_count <> 1 then
    raise exception 'partial or conflicting request-linked messages require manual review';
  end if;

  if v_usage_found then
    if v_existing_usage.user_id <> p_user_id
       or v_existing_usage.conversation_id <> v_conversation_id
       or v_existing_usage.model <> v_result_model
       or v_existing_usage.input_tokens <> p_input_tokens
       or v_existing_usage.output_tokens <> p_output_tokens
       or v_existing_usage.total_tokens <> p_total_tokens
       or v_existing_usage.credits_charged <> v_request.recovery_credits
       or v_existing_usage.actual_cost_usd is distinct from p_actual_cost_usd then
      raise exception 'existing usage row conflicts with recovered response';
    end if;
  else
    insert into public.armex_usage (
      user_id, conversation_id, model, input_tokens, output_tokens,
      total_tokens, actual_cost_usd, credits_charged, request_id
    ) values (
      p_user_id, v_conversation_id, v_result_model, p_input_tokens,
      p_output_tokens, p_total_tokens, p_actual_cost_usd,
      v_request.recovery_credits, p_request_id
    );
  end if;

  update public.armex_conversations
  set model = v_result_model,
      updated_at = now()
  where id = v_conversation_id
    and user_id = p_user_id;

  v_payload := jsonb_build_object(
    'success', true,
    'request_id', p_request_id,
    'conversation_id', v_conversation_id,
    'model', v_result_model,
    'answer', p_answer,
    'usage', jsonb_build_object(
      'input_tokens', p_input_tokens,
      'output_tokens', p_output_tokens,
      'total_tokens', p_total_tokens,
      'actual_cost_usd', p_actual_cost_usd,
      'credits_charged', v_request.recovery_credits
    ),
    'finish_reason', p_finish_reason
  );

  update public.armex_chat_requests
  set status = 'completed',
      response_payload = v_payload,
      failure_code = null,
      completed_at = now(),
      reconciled_at = now(),
      reconciliation_lease_token = null,
      reconciliation_lease_expires_at = null,
      diagnostic_code = null,
      updated_at = now()
  where id = v_request.id
    and status = 'processing';

  if not found then
    raise exception 'chat request finalization lost its processing state';
  end if;

  return v_payload;
end;
$$;

revoke all on function public.armex_persist_chat_response_atomic(uuid,uuid,uuid,text,text,integer,integer,integer,numeric,text) from public, anon, authenticated;
grant execute on function public.armex_persist_chat_response_atomic(uuid,uuid,uuid,text,text,integer,integer,integer,numeric,text) to service_role;
