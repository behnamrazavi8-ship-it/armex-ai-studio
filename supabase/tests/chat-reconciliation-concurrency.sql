-- True multi-session race tests against the disposable PostgreSQL service.
-- Uses independent libpq sessions; never connects to Supabase or production.
create extension if not exists dblink;

create temp table race_claim_results(outcome text, response_payload jsonb);
create temp table reconcile_claim_results(
  user_id uuid, request_id uuid, provider_outcome text, debit_outcome text,
  provider_http_status integer, provider_response_payload jsonb,
  response_payload jsonb, reconciliation_lease_token uuid,
  reconciliation_attempts integer
);

insert into auth.users(id) values (gen_random_uuid()) returning id \gset

-- Race two independent sessions for the exact same idempotency key.
select dblink_connect('claim_a', 'dbname=' || current_database());
select dblink_connect('claim_b', 'dbname=' || current_database());
select dblink_send_query(
  'claim_a',
  format('select outcome, response_payload from public.armex_claim_chat_request(%L::uuid,%L::uuid)',
         :'id', '10000000-0000-4000-8000-000000000001')
);
select dblink_send_query(
  'claim_b',
  format('select outcome, response_payload from public.armex_claim_chat_request(%L::uuid,%L::uuid)',
         :'id', '10000000-0000-4000-8000-000000000001')
);
insert into race_claim_results
select * from dblink_get_result('claim_a') as t(outcome text, response_payload jsonb);
select * from dblink_get_result('claim_a') as t(outcome text, response_payload jsonb);
insert into race_claim_results
select * from dblink_get_result('claim_b') as t(outcome text, response_payload jsonb);
select * from dblink_get_result('claim_b') as t(outcome text, response_payload jsonb);

do $$
declare
  v_claimed integer;
  v_processing integer;
  v_user uuid;
begin
  select count(*) filter (where outcome='claimed'),
         count(*) filter (where outcome='processing')
  into v_claimed, v_processing
  from race_claim_results;
  if v_claimed <> 1 or v_processing <> 1 then
    raise exception 'same-key race expected one claimed and one processing; got %, %',
      v_claimed, v_processing;
  end if;
  select id into v_user from auth.users order by id desc limit 1;
  perform 1;
end $$;

-- Seed 20 eligible requests, then race two reconcilers for disjoint batches.
do $$
declare
  v_user uuid;
  v_request uuid;
  i integer;
begin
  select id into v_user from auth.users order by id desc limit 1;
  for i in 1..20 loop
    v_request := gen_random_uuid();
    perform public.armex_claim_chat_request(v_user, v_request);
    if not public.armex_record_chat_provider_evidence(
      v_user, v_request, 'not_started', 'not_debited', null, null, 'pre_provider'
    ) then
      raise exception 'could not seed eligible reconciliation row %', i;
    end if;
  end loop;
end $$;

select dblink_send_query(
  'claim_a',
  'select * from public.armex_claim_chat_reconciliation(10,120)'
);
select dblink_send_query(
  'claim_b',
  'select * from public.armex_claim_chat_reconciliation(10,120)'
);
insert into reconcile_claim_results
select * from dblink_get_result('claim_a') as t(
  user_id uuid, request_id uuid, provider_outcome text, debit_outcome text,
  provider_http_status integer, provider_response_payload jsonb,
  response_payload jsonb, reconciliation_lease_token uuid,
  reconciliation_attempts integer
);
select * from dblink_get_result('claim_a') as t(
  user_id uuid, request_id uuid, provider_outcome text, debit_outcome text,
  provider_http_status integer, provider_response_payload jsonb,
  response_payload jsonb, reconciliation_lease_token uuid,
  reconciliation_attempts integer
);
insert into reconcile_claim_results
select * from dblink_get_result('claim_b') as t(
  user_id uuid, request_id uuid, provider_outcome text, debit_outcome text,
  provider_http_status integer, provider_response_payload jsonb,
  response_payload jsonb, reconciliation_lease_token uuid,
  reconciliation_attempts integer
);
select * from dblink_get_result('claim_b') as t(
  user_id uuid, request_id uuid, provider_outcome text, debit_outcome text,
  provider_http_status integer, provider_response_payload jsonb,
  response_payload jsonb, reconciliation_lease_token uuid,
  reconciliation_attempts integer
);

do $$
declare
  v_total integer;
  v_distinct integer;
begin
  select count(*), count(distinct request_id)
  into v_total, v_distinct from reconcile_claim_results;
  if v_total <> 20 or v_distinct <> 20 then
    raise exception 'two reconcilers must claim 20 unique rows; got total %, unique %',
      v_total, v_distinct;
  end if;
  if exists (
    select 1 from reconcile_claim_results
    where reconciliation_lease_token is null or reconciliation_attempts <> 1
  ) then
    raise exception 'each row must have one valid first lease';
  end if;
end $$;

-- A stale worker must not release a lease that has since been reassigned.
do $$
declare
  v_user uuid;
  v_request uuid := gen_random_uuid();
  v_old uuid;
  v_new uuid;
  v_row record;
begin
  select id into v_user from auth.users order by id desc limit 1;
  perform public.armex_claim_chat_request(v_user, v_request);
  perform public.armex_record_chat_provider_evidence(
    v_user, v_request, 'not_started', 'not_debited', null, null, 'lease_test'
  );
  select * into v_row from public.armex_claim_chat_reconciliation(1,120)
  where request_id=v_request;
  v_old := v_row.reconciliation_lease_token;
  update public.armex_chat_requests
  set reconciliation_lease_expires_at = now() - interval '1 second'
  where user_id=v_user and request_id=v_request;
  select * into v_row from public.armex_claim_chat_reconciliation(1,120)
  where request_id=v_request;
  v_new := v_row.reconciliation_lease_token;
  if v_new is null or v_new = v_old then
    raise exception 'expired lease should be replaced by a new token';
  end if;
  if public.armex_release_chat_reconciliation(v_user,v_request,v_old,'manual_review:stale_owner') then
    raise exception 'stale lease owner must not release the new lease';
  end if;
  if not public.armex_release_chat_reconciliation(v_user,v_request,v_new,'manual_review:controlled_test') then
    raise exception 'current lease owner should be able to release its lease';
  end if;
end $$;

-- Race two local persistence attempts using one accepted provider response and lease.
do $$
declare
  v_user uuid;
  v_request uuid := gen_random_uuid();
  v_attempt uuid := gen_random_uuid();
  v_row record;
begin
  select id into v_user from auth.users order by id desc limit 1;
  perform public.armex_claim_chat_request(v_user, v_request);
  if not public.armex_set_chat_recovery_metadata(
    v_user,v_request,'parallel persistence prompt','test/model',null,7,v_attempt,0.1,0.2,12
  ) then raise exception 'could not set recovery metadata'; end if;
  if not public.armex_record_chat_provider_evidence(
    v_user,v_request,'accepted','debited',200,
    '{"choices":[{"message":{"content":"Parallel recovered answer"},"finish_reason":"stop"}]}'::jsonb,
    'provider_accepted'
  ) then raise exception 'could not set accepted provider evidence'; end if;
  select * into v_row from public.armex_claim_chat_reconciliation(1,120)
  where request_id=v_request;
  if v_row.reconciliation_lease_token is null then
    raise exception 'could not claim persistence lease';
  end if;
  perform set_config('test.race_user',v_user::text,false);
  perform set_config('test.race_request',v_request::text,false);
  perform set_config('test.race_lease',v_row.reconciliation_lease_token::text,false);
end $$;

select dblink_send_query(
  'claim_a',
  format('select public.armex_persist_chat_response_atomic(%L::uuid,%L::uuid,%L::uuid,%L,%L,12,4,16,0.0003,%L)',
    current_setting('test.race_user'),current_setting('test.race_request'),
    current_setting('test.race_lease'),'Parallel recovered answer','test/model','stop')
);
select dblink_send_query(
  'claim_b',
  format('select public.armex_persist_chat_response_atomic(%L::uuid,%L::uuid,%L::uuid,%L,%L,12,4,16,0.0003,%L)',
    current_setting('test.race_user'),current_setting('test.race_request'),
    current_setting('test.race_lease'),'Parallel recovered answer','test/model','stop')
);

create temp table persistence_race_results(payload jsonb);
insert into persistence_race_results
select * from dblink_get_result('claim_a') as t(payload jsonb);
insert into persistence_race_results
select * from dblink_get_result('claim_b') as t(payload jsonb);
select * from dblink_get_result('claim_a') as t(payload jsonb);
select * from dblink_get_result('claim_b') as t(payload jsonb);

do $$
declare
  v_user uuid := current_setting('test.race_user')::uuid;
  v_request uuid := current_setting('test.race_request')::uuid;
  v_count integer;
  v_distinct integer;
begin
  select count(*), count(distinct payload)
  into v_count,v_distinct from persistence_race_results;
  if v_count <> 2 or v_distinct <> 1 then
    raise exception 'parallel persistence calls should return the same payload';
  end if;
  select count(*) into v_count from public.armex_messages
  where user_id=v_user and request_id=v_request;
  if v_count <> 2 then raise exception 'parallel persistence created % messages, expected 2',v_count; end if;
  select count(*) into v_count from public.armex_usage where request_id=v_request;
  if v_count <> 1 then raise exception 'parallel persistence created % usage rows, expected 1',v_count; end if;
  if (select status from public.armex_chat_requests where user_id=v_user and request_id=v_request) <> 'completed' then
    raise exception 'parallel persistence did not complete request';
  end if;
end $$;

select dblink_disconnect('claim_a');
select dblink_disconnect('claim_b');
