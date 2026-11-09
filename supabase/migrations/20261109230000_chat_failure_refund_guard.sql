-- Fail-closed guard: a chat request with an existing debit cannot be
-- marked failed until the matching idempotent refund is durably recorded.
-- Staged in the experimental PR only; do not apply to production without approval.

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
  update public.armex_chat_requests r
  set status = 'failed',
      failure_code = left(coalesce(p_failure_code, 'request_failed'), 80),
      response_payload = null,
      updated_at = now()
  where r.user_id = p_user_id
    and r.request_id = p_request_id
    and r.status = 'processing'
    -- An accepted provider response is billable and must never be failed
    -- through this generic failure path.
    and r.provider_outcome <> 'accepted'
    -- No debit transaction means there is nothing to refund. If a debit
    -- exists, require its exact request-scoped refund idempotency record.
    and (
      not exists (
        select 1
        from public.armex_credit_transactions d
        where d.user_id = p_user_id
          and d.idempotency_key = 'ai_request:' || p_request_id::text
      )
      or exists (
        select 1
        from public.armex_credit_transactions refund
        where refund.user_id = p_user_id
          and refund.idempotency_key =
            'ai_refund:' || p_request_id::text || ':' ||
            r.recovery_attempt_id::text || ':' ||
            case
              when r.provider_outcome = 'rejected' then 'provider_error'
              else 'pre_provider_error'
            end
      )
    );

  get diagnostics updated_count = row_count;
  return updated_count = 1;
end;
$$;

revoke all on function public.armex_fail_chat_request(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.armex_fail_chat_request(uuid, uuid, text) to service_role;
