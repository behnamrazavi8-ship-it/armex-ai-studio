-- Behavioral tests for strict, atomic wallet RPC idempotency.
create extension if not exists dblink;
insert into auth.users(id) values
('00000000-0000-0000-0000-000000000001'),
('00000000-0000-0000-0000-000000000002'),
('00000000-0000-0000-0000-000000000003'),
('00000000-0000-0000-0000-000000000004');
insert into public.armex_wallets(user_id,balance) values
('00000000-0000-0000-0000-000000000001',100),
('00000000-0000-0000-0000-000000000002',0);

do $test$
declare v boolean; v_rejected boolean;
begin
  -- Debit succeeds once and exact replay is successful without a second debit.
  v := public.armex_debit_credits('00000000-0000-0000-0000-000000000001',20,'debit-1','test','{}');
  if v is distinct from true then raise exception 'initial debit did not succeed'; end if;
  v := public.armex_debit_credits('00000000-0000-0000-0000-000000000001',20,'debit-1','retry','{}');
  if v is distinct from true then raise exception 'exact debit replay should resolve as success'; end if;
  if (select balance from public.armex_wallets where user_id='00000000-0000-0000-0000-000000000001')<>80 then raise exception 'debit replay changed balance'; end if;

  -- Reusing the same key for a different amount or transaction must fail closed.
  begin
    perform public.armex_debit_credits('00000000-0000-0000-0000-000000000001',10,'debit-1','tamper','{}');
    raise exception 'mismatched debit replay unexpectedly succeeded';
  exception when unique_violation then null; end;

  -- Insufficient balance does not create a ledger row or change the wallet.
  v := public.armex_debit_credits('00000000-0000-0000-0000-000000000002',1,'debit-insufficient','test','{}');
  if v is distinct from false then raise exception 'insufficient debit should return false'; end if;
  if exists(select 1 from public.armex_credit_transactions where idempotency_key='debit-insufficient') then raise exception 'insufficient debit created ledger row'; end if;

  -- Grant succeeds once; exact duplicate reports false without changing balance.
  v := public.armex_grant_credits('00000000-0000-0000-0000-000000000001',50,'purchase','grant-1','test','{}');
  if v is distinct from true then raise exception 'initial grant did not succeed'; end if;
  v := public.armex_grant_credits('00000000-0000-0000-0000-000000000001',50,'purchase','grant-1','retry','{}');
  if v is distinct from false then raise exception 'exact grant replay should report duplicate'; end if;
  if (select balance from public.armex_wallets where user_id='00000000-0000-0000-0000-000000000001')<>130 then raise exception 'grant replay changed balance'; end if;

  begin
    perform public.armex_grant_credits('00000000-0000-0000-0000-000000000001',500,'purchase','grant-1','tamper','{}');
    raise exception 'mismatched grant amount unexpectedly succeeded';
  exception when unique_violation then null; end;

  begin
    perform public.armex_grant_credits('00000000-0000-0000-0000-000000000001',50,'admin_adjustment','grant-1','tamper','{}');
    raise exception 'mismatched grant type unexpectedly succeeded';
  exception when unique_violation then null; end;

  v_rejected := false;
  begin
    perform public.armex_grant_credits('00000000-0000-0000-0000-000000000001',50,'usage','grant-invalid-type','tamper','{}');
  exception when others then
    v_rejected := true;
  end;
  if not v_rejected then raise exception 'invalid grant transaction type unexpectedly succeeded'; end if;

  if (select count(*) from public.armex_credit_transactions where user_id='00000000-0000-0000-0000-000000000001')<>2 then
    raise exception 'unexpected wallet ledger row count';
  end if;
end
$test$;

do $acl$
begin
  if has_function_privilege('anon','public.armex_grant_credits(uuid,bigint,text,text,text,jsonb)','EXECUTE')
     or has_function_privilege('authenticated','public.armex_grant_credits(uuid,bigint,text,text,text,jsonb)','EXECUTE')
     or has_function_privilege('anon','public.armex_debit_credits(uuid,bigint,text,text,jsonb)','EXECUTE')
     or has_function_privilege('authenticated','public.armex_debit_credits(uuid,bigint,text,text,jsonb)','EXECUTE') then
    raise exception 'wallet RPCs are executable by untrusted roles';
  end if;
  if not has_function_privilege('service_role','public.armex_grant_credits(uuid,bigint,text,text,text,jsonb)','EXECUTE')
     or not has_function_privilege('service_role','public.armex_debit_credits(uuid,bigint,text,text,jsonb)','EXECUTE') then
    raise exception 'service_role cannot execute wallet RPCs';
  end if;
end
$acl$;


-- Independent PostgreSQL sessions: same-key debit retries must debit once.
insert into public.armex_wallets(user_id,balance)
values('00000000-0000-0000-0000-000000000003',100);
select dblink_connect('wallet_a','dbname='||current_database());
select dblink_connect('wallet_b','dbname='||current_database());
select dblink_send_query('wallet_a',
  $$select public.armex_debit_credits('00000000-0000-0000-0000-000000000003',40,'race-same-key','race','{}')$$);
select dblink_send_query('wallet_b',
  $$select public.armex_debit_credits('00000000-0000-0000-0000-000000000003',40,'race-same-key','race','{}')$$);
create temp table wallet_same_key_results(result boolean);
insert into wallet_same_key_results select * from dblink_get_result('wallet_a') as t(result boolean);
insert into wallet_same_key_results select * from dblink_get_result('wallet_b') as t(result boolean);
select * from dblink_get_result('wallet_a') as t(result boolean);
select * from dblink_get_result('wallet_b') as t(result boolean);
do $race$
begin
  if (select balance from public.armex_wallets where user_id='00000000-0000-0000-0000-000000000003')<>60 then
    raise exception 'concurrent same-key debit changed balance more than once';
  end if;
  if (select count(*) from public.armex_credit_transactions where user_id='00000000-0000-0000-0000-000000000003' and idempotency_key='race-same-key')<>1 then
    raise exception 'concurrent same-key debit created multiple ledger rows';
  end if;
  if (select count(*) from wallet_same_key_results where result is true)<>2 then
    raise exception 'both same-key debit retries should resolve as success';
  end if;
end
$race$;

-- Independent requests cannot overspend a wallet under concurrent load.
insert into public.armex_wallets(user_id,balance)
values('00000000-0000-0000-0000-000000000004',30);
select dblink_send_query('wallet_a',
  $$select public.armex_debit_credits('00000000-0000-0000-0000-000000000004',20,'race-key-a','race','{}')$$);
select dblink_send_query('wallet_b',
  $$select public.armex_debit_credits('00000000-0000-0000-0000-000000000004',20,'race-key-b','race','{}')$$);
create temp table wallet_overspend_results(result boolean);
insert into wallet_overspend_results select * from dblink_get_result('wallet_a') as t(result boolean);
insert into wallet_overspend_results select * from dblink_get_result('wallet_b') as t(result boolean);
select * from dblink_get_result('wallet_a') as t(result boolean);
select * from dblink_get_result('wallet_b') as t(result boolean);
do $overspend$
begin
  if (select balance from public.armex_wallets where user_id='00000000-0000-0000-0000-000000000004')<>10 then
    raise exception 'concurrent debit overspent wallet or lost balance update';
  end if;
  if (select count(*) from wallet_overspend_results where result is true)<>1 then
    raise exception 'exactly one concurrent debit should succeed with insufficient combined balance';
  end if;
  if (select count(*) from public.armex_credit_transactions where user_id='00000000-0000-0000-0000-000000000004')<>1 then
    raise exception 'unexpected concurrent overspend ledger row count';
  end if;
end
$overspend$;
select dblink_disconnect('wallet_a');
select dblink_disconnect('wallet_b');
