-- Persist the minimum user-owned context needed to recover a billable chat
-- response locally without repeating the OpenRouter call.
alter table public.armex_chat_requests
  add column if not exists recovery_message text,
  add column if not exists recovery_model text,
  add column if not exists recovery_conversation_id uuid,
  add column if not exists recovery_credits integer,
  add column if not exists recovery_attempt_id uuid;

create or replace function public.armex_set_chat_recovery_metadata(
  p_user_id uuid,
  p_request_id uuid,
  p_message text,
  p_model text,
  p_conversation_id uuid,
  p_credits integer,
  p_attempt_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  updated_count integer;
begin
  if p_message is null or char_length(p_message) not between 1 and 12000
     or p_model is null or char_length(p_model) not between 1 and 160
     or p_credits is null or p_credits < 1
     or p_attempt_id is null then
    raise exception 'invalid chat recovery metadata';
  end if;

  update public.armex_chat_requests
  set recovery_message = p_message,
      recovery_model = p_model,
      recovery_conversation_id = p_conversation_id,
      recovery_credits = p_credits,
      recovery_attempt_id = p_attempt_id,
      updated_at = now()
  where user_id = p_user_id
    and request_id = p_request_id
    and status = 'processing'
    and provider_outcome in ('unknown','not_started')
    and recovery_message is null;

  get diagnostics updated_count = row_count;
  return updated_count = 1;
end;
$$;

revoke all on function public.armex_set_chat_recovery_metadata(uuid,uuid,text,text,uuid,integer,uuid) from public, anon, authenticated;
grant execute on function public.armex_set_chat_recovery_metadata(uuid,uuid,text,text,uuid,integer,uuid) to service_role;
