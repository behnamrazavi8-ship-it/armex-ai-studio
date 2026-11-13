-- Real independent-session races against disposable PostgreSQL only.
create extension if not exists dblink;

do $block$
declare b record;
begin
 select * into b from storage.buckets where id='lokal-ai-videos';
 if not found then raise exception 'private video bucket was not created'; end if;
 if b.public is distinct from false then raise exception 'video bucket must remain private'; end if;
 if b.file_size_limit <> 52428800 then raise exception 'video bucket must enforce 50 MiB cap'; end if;
 if not ('video/mp4'=any(b.allowed_mime_types)) then raise exception 'video bucket must allow MP4 only'; end if;
 if not exists(select 1 from information_schema.columns where table_schema='public' and table_name='armex_video_generations' and column_name='storage_path')
    or not exists(select 1 from information_schema.columns where table_schema='public' and table_name='armex_video_generations' and column_name='file_size_bytes') then
   raise exception 'video durable storage metadata columns are missing';
 end if;
end $block$;

-- The staged migration must explicitly grant the callback's service role access.
do $block$
begin
 if not has_table_privilege('service_role','public.armex_payment_orders','SELECT')
    or not has_table_privilege('service_role','public.armex_payment_orders','INSERT')
    or not has_table_privilege('service_role','public.armex_payment_orders','UPDATE') then
   raise exception 'service_role is missing required payment-order privileges';
 end if;
 if has_table_privilege('anon','public.armex_payment_orders','SELECT')
    or has_table_privilege('authenticated','public.armex_payment_orders','INSERT')
    or has_table_privilege('authenticated','public.armex_payment_orders','UPDATE') then
   raise exception 'untrusted roles have excessive payment-order privileges';
 end if;
end $block$;
insert into auth.users(id) values(gen_random_uuid()) returning id \gset
\set payment_user :id
insert into public.armex_payment_orders(user_id,amount,currency,credits,provider,status)
values(:'payment_user'::uuid,120000,'IRR',500,'zarinpal','pending') returning id \gset
\set payment_order :id
select dblink_connect('pay_a','dbname='||current_database());
select dblink_connect('pay_b','dbname='||current_database());

-- Two callback sessions compete to mark paid; conditional update admits one.
select dblink_send_query('pay_a',format(
 'update public.armex_payment_orders set status=''paid'',paid_at=now(),provider_metadata=%L::jsonb where id=%L::uuid and status=''pending'' returning id',
 '{"ref_id":"zarinpal-ref-race"}',:'payment_order'));
select dblink_send_query('pay_b',format(
 'update public.armex_payment_orders set status=''paid'',paid_at=now(),provider_metadata=%L::jsonb where id=%L::uuid and status=''pending'' returning id',
 '{"ref_id":"zarinpal-ref-race"}',:'payment_order'));
create temp table payment_claims(id uuid);
insert into payment_claims select * from dblink_get_result('pay_a') as t(id uuid);
insert into payment_claims select * from dblink_get_result('pay_b') as t(id uuid);
select * from dblink_get_result('pay_a') as t(id uuid);
select * from dblink_get_result('pay_b') as t(id uuid);

-- Both retries attempt the same durable grant key; unique index allows one.
select dblink_send_query('pay_a',format(
 'insert into public.armex_credit_transactions(user_id,amount,transaction_type,idempotency_key,metadata) values(%L::uuid,500,''purchase'',%L,%L::jsonb) on conflict (user_id, idempotency_key) do nothing returning id',
 :'payment_user','payment_order:'||:'payment_order','{"provider":"zarinpal"}'));
select dblink_send_query('pay_b',format(
 'insert into public.armex_credit_transactions(user_id,amount,transaction_type,idempotency_key,metadata) values(%L::uuid,500,''purchase'',%L,%L::jsonb) on conflict (user_id, idempotency_key) do nothing returning id',
 :'payment_user','payment_order:'||:'payment_order','{"provider":"zarinpal"}'));
create temp table payment_grants(id uuid);
insert into payment_grants select * from dblink_get_result('pay_a') as t(id uuid);
insert into payment_grants select * from dblink_get_result('pay_b') as t(id uuid);
select * from dblink_get_result('pay_a') as t(id uuid);
select * from dblink_get_result('pay_b') as t(id uuid);
select set_config('test.payment_order', :'payment_order', false);
do $block$
begin
 if (select status from public.armex_payment_orders where id=current_setting('test.payment_order')::uuid)<>'paid' then raise exception 'paid status missing'; end if;
 if (select provider_metadata->>'ref_id' from public.armex_payment_orders where id=current_setting('test.payment_order')::uuid)<>'zarinpal-ref-race' then raise exception 'provider evidence missing'; end if;
 if (select count(*) from public.armex_credit_transactions where idempotency_key='payment_order:'||current_setting('test.payment_order'))<>1 then raise exception 'duplicate payment ledger grant'; end if;
 if (select count(*) from payment_grants)>1 then raise exception 'more than one payment grant insert won'; end if;
end $block$;
insert into public.armex_credit_transactions(user_id,amount,transaction_type,idempotency_key)
values(:'payment_user'::uuid,500,'purchase','payment_order:'||:'payment_order') on conflict (user_id, idempotency_key) do nothing;
select set_config('test.payment_order', :'payment_order', false);
do $block$ begin
 if (select count(*) from public.armex_credit_transactions where idempotency_key='payment_order:'||current_setting('test.payment_order'))<>1 then raise exception 'payment retry duplicated grant'; end if;
end $block$;

-- A user cannot create a second pending Zarinpal order, even when the first Authority is already known.
insert into public.armex_payment_orders(user_id,amount,currency,credits,provider,status,package_id,idempotency_key,provider_metadata)
values(:'payment_user'::uuid,150000,'IRR',700,'zarinpal','pending','starter','ambiguous-request-1','{"request_state":"authority_received"}') returning id \gset
update public.armex_payment_orders set provider_reference='A-PENDING-SESSION' where id=:'id'::uuid;
select set_config('test.payment_user', :'payment_user', false);
do $block$
begin
  begin
    insert into public.armex_payment_orders(user_id,amount,currency,credits,provider,status,package_id,idempotency_key,provider_metadata)
    values(current_setting('test.payment_user')::uuid,150000,'IRR',700,'zarinpal','pending','starter','ambiguous-request-2','{"request_state":"ambiguous"}');
    raise exception 'second pending Zarinpal payment order unexpectedly inserted';
  exception when unique_violation then null;
  end;
end
$block$;
insert into auth.users(id) values(gen_random_uuid()) returning id \gset
\set other_payment_user :id
insert into public.armex_payment_orders(user_id,amount,currency,credits,provider,status,package_id,idempotency_key,provider_metadata)
values(:'other_payment_user'::uuid,150000,'IRR',700,'zarinpal','pending','starter','other-user-ambiguous','{"request_state":"ambiguous"}');
do $block$
begin
  if (select count(*) from public.armex_payment_orders where provider='zarinpal' and status='pending') <> 2 then
    raise exception 'pending order guard should allow one pending order per distinct user';
  end if;
end
$block$;

-- Success/failure video callbacks race for one terminal transition.
insert into public.armex_video_generations(user_id,request_id,prompt,credits_charged,status)
values(:'payment_user'::uuid,gen_random_uuid(),'synthetic callback race',80,'queued') returning id \gset
\set video_job :id
select dblink_send_query('pay_a',format(
 'update public.armex_video_generations set status=''failed'',refund_status=''pending'',updated_at=now() where id=%L::uuid and status in (''queued'',''processing'') returning id',
 :'video_job'));
select dblink_send_query('pay_b',format(
 'update public.armex_video_generations set status=''completed'',result_url=''https://storage.example.test/video.mp4'',completed_at=now(),updated_at=now() where id=%L::uuid and status in (''queued'',''processing'') returning id',
 :'video_job'));
create temp table video_claims(id uuid);
insert into video_claims select * from dblink_get_result('pay_a') as t(id uuid);
insert into video_claims select * from dblink_get_result('pay_b') as t(id uuid);
select * from dblink_get_result('pay_a') as t(id uuid);
select * from dblink_get_result('pay_b') as t(id uuid);
select set_config('test.video_job', :'video_job', false);
do $block$
declare v_status text; v_count int;
begin
 select status into v_status from public.armex_video_generations where id=current_setting('test.video_job')::uuid;
 select count(*) into v_count from video_claims;
 if v_status not in ('failed','completed') then raise exception 'no terminal video state'; end if;
 if v_count<>1 then raise exception 'expected one video terminal winner, got %',v_count; end if;
 if v_status='completed' and exists(select 1 from public.armex_credit_transactions where idempotency_key='ai_refund:'||current_setting('test.video_job')||':'||current_setting('test.video_job')||':video_refund') then raise exception 'completed video job was refunded'; end if;
end $block$;

-- Duplicate failure callbacks share one refund idempotency key.
insert into public.armex_video_generations(user_id,request_id,prompt,credits_charged,status,refund_status)
values(:'payment_user'::uuid,gen_random_uuid(),'synthetic duplicate failure',80,'failed','pending') returning id \gset
\set failed_video_job :id
select dblink_send_query('pay_a',format(
 'insert into public.armex_credit_transactions(user_id,amount,transaction_type,idempotency_key,metadata) values(%L::uuid,80,''refund'',%L,%L::jsonb) on conflict (user_id, idempotency_key) do nothing returning id',
 :'payment_user','ai_refund:'||:'failed_video_job'||':'||:'failed_video_job'||':video_refund','{"reason":"video_refund"}'));
select dblink_send_query('pay_b',format(
 'insert into public.armex_credit_transactions(user_id,amount,transaction_type,idempotency_key,metadata) values(%L::uuid,80,''refund'',%L,%L::jsonb) on conflict (user_id, idempotency_key) do nothing returning id',
 :'payment_user','ai_refund:'||:'failed_video_job'||':'||:'failed_video_job'||':video_refund','{"reason":"video_refund"}'));
create temp table refund_claims(id uuid);
insert into refund_claims select * from dblink_get_result('pay_a') as t(id uuid);
insert into refund_claims select * from dblink_get_result('pay_b') as t(id uuid);
select * from dblink_get_result('pay_a') as t(id uuid);
select * from dblink_get_result('pay_b') as t(id uuid);
select set_config('test.failed_video_job', :'failed_video_job', false);
do $block$ begin
 if (select count(*) from public.armex_credit_transactions where idempotency_key='ai_refund:'||current_setting('test.failed_video_job')||':'||current_setting('test.failed_video_job')||':video_refund')<>1 then raise exception 'duplicate RunPod refund ledger'; end if;
 if (select count(*) from refund_claims)>1 then raise exception 'more than one refund insert won'; end if;
end $block$;

-- Verify actual unique indexes from the staged migration.
select set_config('test.payment_user', :'payment_user', false);
do $block$
declare v_user uuid:=current_setting('test.payment_user')::uuid; v_req uuid:=gen_random_uuid();
begin
 insert into public.armex_video_generations(user_id,request_id,prompt,credits_charged,provider_job_id)
 values(v_user,v_req,'unique request',10,'provider-job-unique');
 begin
  insert into public.armex_video_generations(user_id,request_id,prompt,credits_charged)
  values(v_user,v_req,'duplicate request',10);
  raise exception 'duplicate request unexpectedly inserted';
 exception when unique_violation then null; end;
 begin
  insert into public.armex_video_generations(user_id,request_id,prompt,credits_charged,provider_job_id)
  values(v_user,gen_random_uuid(),'duplicate provider job',10,'provider-job-unique');
  raise exception 'duplicate provider job unexpectedly inserted';
 exception when unique_violation then null; end;
end $block$;
select dblink_disconnect('pay_a');
select dblink_disconnect('pay_b');
