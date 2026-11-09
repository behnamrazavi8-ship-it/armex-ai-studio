-- SQL-level regression tests for the four staged chat-request migrations.
-- Runs only against the disposable PostgreSQL service in GitHub Actions.
begin;

-- Security regression checks: the request ledger is service-role-only.
do $
declare
  fn regprocedure;
  fn_list regprocedure[] := array[
    'public.armex_claim_chat_request(uuid,uuid)'::regprocedure,
    'public.armex_complete_chat_request(uuid,uuid,jsonb)'::regprocedure,
    'public.armex_fail_chat_request(uuid,uuid,text)'::regprocedure,
    'public.armex_record_chat_provider_evidence(uuid,uuid,text,text,integer,jsonb,text)'::regprocedure,
    'public.armex_claim_chat_reconciliation(integer,integer)'::regprocedure,
    'public.armex_release_chat_reconciliation(uuid,uuid,uuid,text)'::regprocedure,
    'public.armex_set_chat_recovery_metadata(uuid,uuid,text,text,uuid,integer,uuid,numeric,numeric,integer)'::regprocedure,
    'public.armex_persist_chat_response_atomic(uuid,uuid,uuid,text,text,integer,integer,integer,numeric,text)'::regprocedure
  ];
begin
  if not (select c.relrowsecurity from pg_class c where c.oid='public.armex_chat_requests'::regclass) then
    raise exception 'chat request ledger must have RLS enabled';
  end if;
  if has_table_privilege('anon','public.armex_chat_requests','SELECT')
     or has_table_privilege('authenticated','public.armex_chat_requests','SELECT') then
    raise exception 'chat request ledger must not be readable by anon/authenticated';
  end if;
  foreach fn in array fn_list loop
    if has_function_privilege('anon',fn,'EXECUTE')
       or has_function_privilege('authenticated',fn,'EXECUTE') then
      raise exception 'untrusted role can execute privileged RPC: %', fn;
    end if;
    if not has_function_privilege('service_role',fn,'EXECUTE') then
      raise exception 'service_role is missing required RPC execute grant: %', fn;
    end if;
  end loop;
end $;


do $$
declare
  v_user uuid := gen_random_uuid();
  v_request uuid := gen_random_uuid();
  v_attempt uuid := gen_random_uuid();
  v_claim record;
  v_lease uuid;
  v_payload jsonb;
  v_again jsonb;
  v_count integer;
begin
  insert into auth.users(id) values (v_user);

  select * into v_claim
  from public.armex_claim_chat_request(v_user, v_request);
  if v_claim.outcome <> 'claimed' then
    raise exception 'first request claim should be claimed, got %', v_claim.outcome;
  end if;

  select * into v_claim
  from public.armex_claim_chat_request(v_user, v_request);
  if v_claim.outcome <> 'processing' then
    raise exception 'duplicate in-flight request should be processing, got %', v_claim.outcome;
  end if;

  if not public.armex_set_chat_recovery_metadata(
    v_user, v_request, 'test prompt', 'test/model', null, 7, v_attempt, 0.1, 0.2, 12
  ) then
    raise exception 'recovery metadata should be persisted once';
  end if;
  if public.armex_set_chat_recovery_metadata(
    v_user, v_request, 'changed prompt', 'test/model', null, 7, v_attempt, 0.1, 0.2, 12
  ) then
    raise exception 'recovery metadata must be immutable after first write';
  end if;

  if not public.armex_record_chat_provider_evidence(
    v_user, v_request, 'accepted', 'debited', 200,
    '{"choices":[{"message":{"content":"Recovered answer"},"finish_reason":"stop"}]}'::jsonb,
    'provider_accepted'
  ) then
    raise exception 'accepted provider evidence should persist';
  end if;
  if public.armex_record_chat_provider_evidence(
    v_user, v_request, 'rejected', 'debited', 400, null, 'attempted_downgrade'
  ) then
    raise exception 'accepted provider evidence must not be downgraded';
  end if;

  select * into v_claim
  from public.armex_claim_chat_reconciliation(5, 120);
  if v_claim.request_id is distinct from v_request then
    raise exception 'expected request to be claimed for reconciliation';
  end if;
  v_lease := v_claim.reconciliation_lease_token;
  if v_lease is null then raise exception 'lease token must be present'; end if;

  v_payload := public.armex_persist_chat_response_atomic(
    v_user, v_request, v_lease, 'Recovered answer', 'test/model',
    12, 4, 16, 0.0003, 'stop'
  );
  if v_payload->>'success' <> 'true' then
    raise exception 'atomic persistence should return success payload';
  end if;
  if (select status from public.armex_chat_requests where user_id=v_user and request_id=v_request) <> 'completed' then
    raise exception 'request should be completed atomically';
  end if;

  select count(*) into v_count from public.armex_messages
  where user_id=v_user and request_id=v_request;
  if v_count <> 2 then raise exception 'expected exactly 2 request-linked messages, got %', v_count; end if;

  select count(*) into v_count from public.armex_usage where request_id=v_request;
  if v_count <> 1 then raise exception 'expected exactly 1 usage row, got %', v_count; end if;

  v_again := public.armex_persist_chat_response_atomic(
    v_user, v_request, v_lease, 'Recovered answer', 'test/model',
    12, 4, 16, 0.0003, 'stop'
  );
  if v_again is distinct from v_payload then
    raise exception 'repeated atomic persistence should return the stored response';
  end if;
  select count(*) into v_count from public.armex_messages
  where user_id=v_user and request_id=v_request;
  if v_count <> 2 then raise exception 'idempotent retry duplicated messages'; end if;
  select count(*) into v_count from public.armex_usage where request_id=v_request;
  if v_count <> 1 then raise exception 'idempotent retry duplicated usage'; end if;

  select count(*) into v_count from public.armex_claim_chat_reconciliation(5, 120);
  if v_count <> 0 then raise exception 'completed request must not be claimable'; end if;
end $$;

-- Separate request proves ambiguous provider outcomes are excluded from claims.
do $$
declare
  v_user uuid := gen_random_uuid();
  v_request uuid := gen_random_uuid();
  v_claim record;
begin
  insert into auth.users(id) values (v_user);
  perform public.armex_claim_chat_request(v_user, v_request);
  if not public.armex_record_chat_provider_evidence(
    v_user, v_request, 'unknown', 'unknown', null, null, 'timeout_ambiguous'
  ) then
    raise exception 'ambiguous evidence should be persisted';
  end if;
  select * into v_claim from public.armex_claim_chat_reconciliation(5, 120);
  if v_claim.request_id is not null then
    raise exception 'ambiguous provider outcome must not be automatically claimed';
  end if;
end $$;

rollback;
