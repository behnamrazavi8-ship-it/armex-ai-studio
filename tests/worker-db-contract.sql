\set ON_ERROR_STOP on

-- Disposable PostgreSQL contract test for the LOKAL AI async image-job migration.
-- Uses isolated mock auth/wallet tables; never connects to the production project.

create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
create table auth.users (id uuid primary key);

create table public.armex_wallets (
  user_id uuid primary key references auth.users(id) on delete cascade,
  balance bigint not null default 0 check (balance >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.armex_credit_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  amount bigint not null check (amount <> 0),
  transaction_type text not null,
  idempotency_key text not null,
  description text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (user_id, idempotency_key)
);

create table public.armex_image_generations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  request_id uuid not null,
  prompt text not null check (char_length(prompt) between 1 and 6000),
  model text not null,
  aspect_ratio text not null,
  resolution text not null default '1K',
  status text not null default 'pending'
    check (status in ('pending', 'completed', 'failed')),
  credits_charged bigint not null check (credits_charged > 0),
  actual_cost_usd numeric,
  storage_path text unique,
  mime_type text,
  error_code text,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint armex_image_generations_user_request_key unique (user_id, request_id)
);

create or replace function public.armex_debit_credits(
  p_user_id uuid, p_amount bigint, p_idempotency_key text,
  p_description text default null, p_metadata jsonb default '{}'::jsonb
) returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare v_balance bigint;
begin
  if p_user_id is null or p_amount <= 0 or nullif(p_idempotency_key,'') is null then
    raise exception 'Invalid credit debit parameters';
  end if;
  insert into public.armex_wallets(user_id) values(p_user_id) on conflict(user_id) do nothing;
  select balance into v_balance from public.armex_wallets where user_id=p_user_id for update;
  if exists(select 1 from public.armex_credit_transactions where user_id=p_user_id and idempotency_key=p_idempotency_key) then
    return true;
  end if;
  if v_balance < p_amount then return false; end if;
  update public.armex_wallets set balance=balance-p_amount,updated_at=now() where user_id=p_user_id;
  insert into public.armex_credit_transactions(user_id,amount,transaction_type,idempotency_key,description,metadata)
  values(p_user_id,-p_amount,'usage',p_idempotency_key,p_description,coalesce(p_metadata,'{}'::jsonb));
  return true;
end $$;

create or replace function public.armex_grant_credits(
  p_user_id uuid, p_amount bigint, p_type text, p_idempotency_key text,
  p_description text default null, p_metadata jsonb default '{}'::jsonb
) returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if p_user_id is null or p_amount <= 0 or nullif(p_idempotency_key,'') is null then
    raise exception 'Invalid credit grant parameters';
  end if;
  insert into public.armex_wallets(user_id) values(p_user_id) on conflict(user_id) do nothing;
  perform 1 from public.armex_wallets where user_id=p_user_id for update;
  if exists(select 1 from public.armex_credit_transactions where user_id=p_user_id and idempotency_key=p_idempotency_key) then
    return false;
  end if;
  update public.armex_wallets set balance=balance+p_amount,updated_at=now() where user_id=p_user_id;
  insert into public.armex_credit_transactions(user_id,amount,transaction_type,idempotency_key,description,metadata)
  values(p_user_id,p_amount,p_type,p_idempotency_key,p_description,coalesce(p_metadata,'{}'::jsonb));
  return true;
end $$;

insert into auth.users(id) values
('00000000-0000-4000-8000-000000000001'),
('00000000-0000-4000-8000-000000000002'),
('00000000-0000-4000-8000-000000000003');

insert into public.armex_wallets(user_id,balance) values
('00000000-0000-4000-8000-000000000001',100),
('00000000-0000-4000-8000-000000000002',5),
('00000000-0000-4000-8000-000000000003',100);

\i supabase/migrations/20261111010000_lokal_async_image_worker.sql

do $$
declare
  u1 constant uuid := '00000000-0000-4000-8000-000000000001';
  u2 constant uuid := '00000000-0000-4000-8000-000000000002';
  u3 constant uuid := '00000000-0000-4000-8000-000000000003';
  r1 constant uuid := '10000000-0000-4000-8000-000000000001';
  r2 constant uuid := '10000000-0000-4000-8000-000000000002';
  r3 constant uuid := '10000000-0000-4000-8000-000000000003';
  r4 constant uuid := '10000000-0000-4000-8000-000000000004';
  e jsonb;
  j jsonb;
  job uuid;
  wid uuid := '20000000-0000-4000-8000-000000000001';
  ok boolean;
  prompt_text constant text := 'یک دوج چلنجر قرمز با هر دو درِ باز، داخل پارکینگ طبقاتی؛ نور طبیعی، نمای سه‌ربع از جلو، جزئیات دقیق بدنه و رینگ‌ها. 🚗';
begin
  -- Enqueue and idempotent duplicate: exactly one debit and one durable job.
  -- The exact Persian Unicode prompt must survive database persistence and queue claim.
  e := public.armex_enqueue_image_generation(u1,r1,prompt_text,'test/model','1:1','1K',20);
  if e->>'success' <> 'true' then raise exception 'enqueue failed: %',e; end if;
  e := public.armex_enqueue_image_generation(u1,r1,'test prompt','test/model','1:1','1K',20);
  if e->>'duplicate' <> 'true' then raise exception 'duplicate request was not idempotent: %',e; end if;
  if (select balance from public.armex_wallets where user_id=u1) <> 80 then raise exception 'duplicate enqueue debited twice'; end if;
  if (select count(*) from public.armex_image_jobs) <> 1 then raise exception 'duplicate enqueue created extra job'; end if;

  -- Claim, heartbeat, retry, then terminal failure with exactly-once refund.
  j := public.armex_claim_image_job(wid);
  job := (j->>'job_id')::uuid;
  if j->>'attempt_count' <> '1' then raise exception 'first claim attempt mismatch: %',j; end if;
  if j->>'prompt' is distinct from prompt_text then
    raise exception 'Persian prompt changed between enqueue and worker claim: expected %, got %',prompt_text,j->>'prompt';
  end if;
  if job is distinct from (e->>'job_id')::uuid then
    raise exception 'claimed job ID does not match the enqueued generation';
  end if;
  if public.armex_heartbeat_image_job(job,wid) is distinct from true then raise exception 'heartbeat rejected active lease'; end if;
  e := public.armex_fail_image_job(job,wid,'TEST_RETRY',true);
  if e->>'status' <> 'queued' then raise exception 'retry did not requeue: %',e; end if;
  update public.armex_image_jobs set available_at=now() where job_id=job;
  j := public.armex_claim_image_job(wid);
  if j->>'attempt_count' <> '2' then raise exception 'second attempt mismatch: %',j; end if;
  e := public.armex_fail_image_job(job,wid,'TEST_FINAL',false);
  if e->>'status' <> 'failed' or e->>'refunded' <> 'true' then raise exception 'terminal failure/refund mismatch: %',e; end if;
  if (select balance from public.armex_wallets where user_id=u1) <> 100 then raise exception 'terminal failure did not restore balance'; end if;
  if (select count(*) from public.armex_credit_transactions where user_id=u1 and idempotency_key='image_refund:'||job::text) <> 1 then raise exception 'refund ledger row count mismatch'; end if;
  -- Replaying the same terminal failure must be rejected without a second refund.
  e := public.armex_fail_image_job(job,wid,'TEST_REPLAY',false);
  if e->>'accepted' <> 'false' then raise exception 'terminal failure replay was unexpectedly accepted: %',e; end if;
  if (select balance from public.armex_wallets where user_id=u1) <> 100 then raise exception 'replayed terminal failure changed wallet balance'; end if;
  if (select count(*) from public.armex_credit_transactions where user_id=u1 and idempotency_key='image_refund:'||job::text) <> 1 then raise exception 'replayed terminal failure duplicated refund ledger row'; end if;

  -- Duplicate refund key cannot increase balance a second time.
  ok := public.armex_grant_credits(u1,20,'refund','image_refund:'||job::text,'duplicate refund','{}'::jsonb);
  if ok is distinct from false or (select balance from public.armex_wallets where user_id=u1) <> 100 then raise exception 'duplicate refund was not suppressed'; end if;

  -- Insufficient funds: no generation row, no queue row, no debit.
  e := public.armex_enqueue_image_generation(u2,r2,'test prompt','test/model','1:1','1K',20);
  if e->>'code' <> 'insufficient_credits' then raise exception 'insufficient balance not rejected: %',e; end if;
  if (select balance from public.armex_wallets where user_id=u2) <> 5 then raise exception 'insufficient balance changed'; end if;
  if exists(select 1 from public.armex_image_generations where user_id=u2) then raise exception 'insufficient request created generation row'; end if;

  -- Successful completion is terminal and must not refund.
  e := public.armex_enqueue_image_generation(u3,r3,'successful prompt','test/model','1:1','1K',20);
  j := public.armex_claim_image_job(wid);
  job := (j->>'job_id')::uuid;
  ok := public.armex_complete_image_job(job,wid,u3::text||'/'||r3::text||'.jpg','image/jpeg',null);
  if ok is distinct from true then raise exception 'completion rejected'; end if;
  if (select status from public.armex_image_generations where id=job) <> 'completed' then raise exception 'generation not completed'; end if;
  if exists(select 1 from public.armex_credit_transactions where user_id=u3 and idempotency_key='image_refund:'||job::text) then raise exception 'successful job received refund'; end if;

  -- Lease exhaustion: after max attempts, the next claim sweep marks failed and refunds.
  e := public.armex_enqueue_image_generation(u3,r4,'lease expiry prompt','test/model','1:1','1K',20);
  j := public.armex_claim_image_job(wid); job := (j->>'job_id')::uuid;
  update public.armex_image_jobs set lease_expires_at=now()-interval '1 second' where job_id=job;
  j := public.armex_claim_image_job(wid);
  if j->>'attempt_count' <> '2' then raise exception 'lease reclaim attempt 2 mismatch: %',j; end if;
  update public.armex_image_jobs set lease_expires_at=now()-interval '1 second' where job_id=job;
  j := public.armex_claim_image_job(wid);
  if j->>'attempt_count' <> '3' then raise exception 'lease reclaim attempt 3 mismatch: %',j; end if;
  update public.armex_image_jobs set lease_expires_at=now()-interval '1 second' where job_id=job;
  j := public.armex_claim_image_job(wid);
  if j is not null then raise exception 'exhausted lease unexpectedly returned a job: %',j; end if;
  if (select status from public.armex_image_generations where id=job) <> 'failed' then raise exception 'exhausted lease not marked failed'; end if;
  if (select balance from public.armex_wallets where user_id=u3) <> 80 then raise exception 'lease exhaustion did not refund'; end if;
  if (select count(*) from public.armex_credit_transactions where user_id=u3 and idempotency_key='image_refund:'||job::text) <> 1 then raise exception 'lease refund was not exactly once'; end if;
end $$;

-- Function ACLs: internal job RPCs must not be executable by anon/authenticated.
do $$
begin
  if has_function_privilege('anon','public.armex_claim_image_job(uuid)','EXECUTE') then raise exception 'anon can execute claim RPC'; end if;
  if has_function_privilege('authenticated','public.armex_claim_image_job(uuid)','EXECUTE') then raise exception 'authenticated can execute claim RPC'; end if;
  if not has_function_privilege('service_role','public.armex_claim_image_job(uuid)','EXECUTE') then raise exception 'service_role cannot execute claim RPC'; end if;
end $$;

select 'LOKAL_IMAGE_JOB_SQL_TESTS_PASSED' as result;
