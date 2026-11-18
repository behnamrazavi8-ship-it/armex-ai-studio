\set ON_ERROR_STOP on

-- Isolated PostgreSQL contract tests for free Smart Chat.
do $$
begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
end $$;

create schema auth;
create table auth.users (id uuid primary key);

create table public.armex_conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null default 'گفتگوی جدید',
  model text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.armex_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.armex_conversations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null,
  content text not null,
  model text,
  input_tokens integer,
  output_tokens integer,
  created_at timestamptz not null default now()
);

create table public.armex_usage (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  conversation_id uuid references public.armex_conversations(id) on delete set null,
  model text not null,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  total_tokens integer not null default 0,
  actual_cost_usd numeric,
  credits_charged bigint not null default 0,
  request_id uuid unique,
  created_at timestamptz not null default now()
);

create table public.armex_wallets (
  user_id uuid primary key references auth.users(id) on delete cascade,
  balance bigint not null default 0
);

create table public.armex_credit_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  amount bigint not null,
  transaction_type text not null,
  idempotency_key text not null
);

\i supabase/migrations/20261118180000_lokal_free_chat_idempotency.sql

insert into auth.users(id) values
('00000000-0000-4000-8000-000000000001'),
('00000000-0000-4000-8000-000000000002');

insert into public.armex_wallets(user_id,balance) values
('00000000-0000-4000-8000-000000000001',500),
('00000000-0000-4000-8000-000000000002',75);

do $$
declare
  u1 constant uuid := '00000000-0000-4000-8000-000000000001';
  u2 constant uuid := '00000000-0000-4000-8000-000000000002';
  r1 constant uuid := '10000000-0000-4000-8000-000000000001';
  r2 constant uuid := '10000000-0000-4000-8000-000000000002';
  claim jsonb;
  response jsonb;
  duplicate_response jsonb;
begin
  -- A request is claimed once; duplicate concurrent/retried claims cannot start a second provider call.
  claim := public.armex_claim_chat_request(u1,r1);
  if claim->>'outcome' <> 'claimed' then raise exception 'first claim failed: %',claim; end if;
  claim := public.armex_claim_chat_request(u1,r1);
  if claim->>'outcome' <> 'processing' then raise exception 'duplicate claim was not held: %',claim; end if;

  if public.armex_set_chat_recovery_metadata(
    u1,r1,'سلام، وضعیت هوا چطوره؟','openai/gpt-4o-mini',null,0,
    '20000000-0000-4000-8000-000000000001',0.00000015,0.00000060,18
  ) is distinct from true then raise exception 'free recovery metadata was not saved'; end if;

  if public.armex_record_chat_provider_evidence(
    u1,r1,'not_started','not_charged',null,null,null
  ) is distinct from true then raise exception 'not-started evidence failed'; end if;

  if public.armex_record_chat_provider_evidence(
    u1,r1,'accepted','not_charged',200,
    '{"choices":[{"message":{"content":"سلام! خوشحالم کمک کنم."}}],"usage":{"prompt_tokens":18,"completion_tokens":12,"total_tokens":30,"cost":0.00001}}'::jsonb,
    null
  ) is distinct from true then raise exception 'accepted provider evidence failed'; end if;

  response := public.armex_persist_chat_response_atomic(
    u1,r1,null,'سلام! خوشحالم کمک کنم.','openai/gpt-4o-mini',18,12,30,0.00001,'stop'
  );
  if response->>'success' <> 'true' then raise exception 'atomic persistence failed: %',response; end if;
  if response#>>'{usage,credits_charged}' <> '0' then raise exception 'chat charged credits: %',response; end if;

  if (select count(*) from public.armex_messages where request_id=r1) <> 2 then
    raise exception 'chat messages were not persisted exactly once';
  end if;
  if (select credits_charged from public.armex_usage where request_id=r1) <> 0 then
    raise exception 'usage ledger did not record zero credits';
  end if;
  if (select actual_cost_usd from public.armex_usage where request_id=r1) <> 0.00001 then
    raise exception 'provider cost was not retained';
  end if;
  if (select balance from public.armex_wallets where user_id=u1) <> 500 then
    raise exception 'free chat changed wallet balance';
  end if;
  if exists(select 1 from public.armex_credit_transactions where user_id=u1) then
    raise exception 'free chat created a credit transaction';
  end if;

  duplicate_response := public.armex_persist_chat_response_atomic(
    u1,r1,null,'ignored duplicate','openai/gpt-4o-mini',1,1,2,0.00001,'stop'
  );
  if duplicate_response <> response then raise exception 'completed persistence did not return the same response'; end if;
  if (select count(*) from public.armex_messages where request_id=r1) <> 2 then
    raise exception 'duplicate persistence created extra messages';
  end if;

  claim := public.armex_claim_chat_request(u1,r1);
  if claim->>'outcome' <> 'completed' or claim->'response_payload' <> response then
    raise exception 'completed duplicate claim did not return cached response: %',claim;
  end if;

  -- A failed pre-provider request stays terminal and can be retried only with a fresh UUID.
  claim := public.armex_claim_chat_request(u1,r2);
  if claim->>'outcome' <> 'claimed' then raise exception 'second request claim failed'; end if;
  if public.armex_set_chat_recovery_metadata(
    u1,r2,'پیام نامعتبر','openai/gpt-4o-mini',null,0,
    '20000000-0000-4000-8000-000000000002',null,null,2
  ) is distinct from true then raise exception 'second request metadata failed'; end if;
  if public.armex_record_chat_provider_evidence(
    u1,r2,'not_started','not_charged',null,null,null
  ) is distinct from true then raise exception 'second request evidence failed'; end if;
  if public.armex_fail_chat_request(u1,r2,'test_pre_provider_failure') is distinct from true then
    raise exception 'failed request did not become terminal';
  end if;
  claim := public.armex_claim_chat_request(u1,r2);
  if claim->>'outcome' <> 'failed' then raise exception 'failed request was not terminal: %',claim; end if;

  -- A request UUID owned by another user cannot reveal or reuse its response.
  claim := public.armex_claim_chat_request(u2,r1);
  if claim->>'outcome' <> 'failed' then raise exception 'cross-user request collision was not rejected'; end if;

  if (select balance from public.armex_wallets where user_id=u2) <> 75 then
    raise exception 'another user wallet changed';
  end if;
end $$;

do $$
begin
  if has_function_privilege('anon','public.armex_claim_chat_request(uuid,uuid)','EXECUTE') then
    raise exception 'anon can execute chat claim RPC';
  end if;
  if has_function_privilege('authenticated','public.armex_claim_chat_request(uuid,uuid)','EXECUTE') then
    raise exception 'authenticated can execute chat claim RPC';
  end if;
  if not has_function_privilege('service_role','public.armex_claim_chat_request(uuid,uuid)','EXECUTE') then
    raise exception 'service_role cannot execute chat claim RPC';
  end if;
  if has_table_privilege('anon','public.armex_chat_requests','SELECT') then
    raise exception 'anon can read private chat request recovery rows';
  end if;
  if has_table_privilege('authenticated','public.armex_chat_requests','SELECT') then
    raise exception 'authenticated can read private chat request recovery rows';
  end if;
end $$;

select 'LOKAL_FREE_CHAT_SQL_TESTS_PASSED' as result;
