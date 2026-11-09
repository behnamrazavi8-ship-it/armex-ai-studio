-- Signup/referral idempotency, verification, replay, and concurrency invariants.
insert into auth.users(id,email_confirmed_at) values
('10000000-0000-0000-0000-000000000001',now()),
('10000000-0000-0000-0000-000000000002',now()),
('10000000-0000-0000-0000-000000000003',null),
('10000000-0000-0000-0000-000000000004',now()),
('10000000-0000-0000-0000-000000000005',now()),
('10000000-0000-0000-0000-000000000006',now());

select public.armex_activate_user('10000000-0000-0000-0000-000000000003');
do $unverified$
begin
  if exists(select 1 from public.armex_credit_transactions where user_id='10000000-0000-0000-0000-000000000003') then
    raise exception 'unverified user received signup credits';
  end if;
end
$unverified$;

select public.armex_activate_user('10000000-0000-0000-0000-000000000001');
select public.armex_activate_user('10000000-0000-0000-0000-000000000001');
do $signup$
begin
  if (select balance from public.armex_wallets where user_id='10000000-0000-0000-0000-000000000001')<>500 then
    raise exception 'signup activation did not settle at 500 credits';
  end if;
  if (select count(*) from public.armex_credit_transactions where user_id='10000000-0000-0000-0000-000000000001' and idempotency_key='signup_bonus:10000000-0000-0000-0000-000000000001')<>1 then
    raise exception 'duplicate signup ledger entries detected';
  end if;
end
$signup$;

insert into public.armex_referrals(id,referrer_user_id,referred_user_id,referral_code)
values('20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000002','REFCODE001');
select public.armex_activate_user('10000000-0000-0000-0000-000000000002');
select public.armex_activate_user('10000000-0000-0000-0000-000000000002');
do $referral$
begin
  if (select balance from public.armex_wallets where user_id='10000000-0000-0000-0000-000000000001')<>700 then
    raise exception 'referral activation did not grant exactly 200 credits';
  end if;
  if (select status from public.armex_referrals where id='20000000-0000-0000-0000-000000000001')<>'rewarded' then
    raise exception 'referral did not reach rewarded state';
  end if;
  if (select count(*) from public.armex_credit_transactions where user_id='10000000-0000-0000-0000-000000000001' and idempotency_key='referral_bonus:20000000-0000-0000-0000-000000000001')<>1 then
    raise exception 'duplicate referral ledger entries detected';
  end if;
end
$referral$;

-- Exact existing ledger evidence repairs a pending referral without re-granting.
insert into public.armex_referrals(id,referrer_user_id,referred_user_id,referral_code)
values('20000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000004','REFCODE002');
insert into public.armex_credit_transactions(user_id,amount,transaction_type,idempotency_key,metadata)
values('10000000-0000-0000-0000-000000000001',200,'referral_bonus','referral_bonus:20000000-0000-0000-0000-000000000002','{"referral_id":"20000000-0000-0000-0000-000000000002"}');
update public.armex_wallets set balance=balance+200 where user_id='10000000-0000-0000-0000-000000000001';
select public.armex_activate_user('10000000-0000-0000-0000-000000000004');
do $reconcile$
begin
  if (select balance from public.armex_wallets where user_id='10000000-0000-0000-0000-000000000001')<>900 then
    raise exception 'referral replay changed the referrer balance';
  end if;
  if (select status from public.armex_referrals where id='20000000-0000-0000-0000-000000000002')<>'rewarded' then
    raise exception 'matching durable referral grant was not reconciled';
  end if;
end
$reconcile$;

-- A conflicting pre-existing referral key must fail closed and roll back state.
insert into public.armex_referrals(id,referrer_user_id,referred_user_id,referral_code)
values('20000000-0000-0000-0000-000000000003','10000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000005','REFCODE003');
insert into public.armex_credit_transactions(user_id,amount,transaction_type,idempotency_key,metadata)
values('10000000-0000-0000-0000-000000000001',199,'referral_bonus','referral_bonus:20000000-0000-0000-0000-000000000003','{"referral_id":"20000000-0000-0000-0000-000000000003"}');
update public.armex_wallets set balance=balance+199 where user_id='10000000-0000-0000-0000-000000000001';
do $conflict$
begin
  begin
    perform public.armex_activate_user('10000000-0000-0000-0000-000000000005');
    raise exception 'conflicting referral evidence unexpectedly succeeded';
  exception when unique_violation then null;
  end;
  if (select status from public.armex_referrals where id='20000000-0000-0000-0000-000000000003')<>'pending' then
    raise exception 'conflicting referral state was not rolled back';
  end if;
end
$conflict$;

do $constraints$
begin
  begin
    insert into public.armex_referrals(referrer_user_id,referred_user_id,referral_code)
    values('10000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','SELF');
    raise exception 'self referral unexpectedly accepted';
  exception when check_violation then null;
  end;
  begin
    insert into public.armex_referrals(referrer_user_id,referred_user_id,referral_code)
    values('10000000-0000-0000-0000-000000000004','10000000-0000-0000-0000-000000000002','DUPLICATE');
    raise exception 'duplicate referred user unexpectedly accepted';
  exception when unique_violation then null;
  end;
end
$constraints$;

-- Concurrent activations for one referred user grant one signup and one referral reward.
insert into public.armex_referrals(id,referrer_user_id,referred_user_id,referral_code)
values('20000000-0000-0000-0000-000000000004','10000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000006','REFCODE004');
select dblink_connect('signup_a','dbname='||current_database());
select dblink_connect('signup_b','dbname='||current_database());
select dblink_send_query('signup_a',$$select public.armex_activate_user('10000000-0000-0000-0000-000000000006') is null$$);
select dblink_send_query('signup_b',$$select public.armex_activate_user('10000000-0000-0000-0000-000000000006') is null$$);
select * from dblink_get_result('signup_a') as t(result boolean);
select * from dblink_get_result('signup_b') as t(result boolean);
do $concurrent$
begin
  if (select balance from public.armex_wallets where user_id='10000000-0000-0000-0000-000000000006')<>500 then
    raise exception 'concurrent activation duplicated signup credits';
  end if;
  if (select count(*) from public.armex_credit_transactions where user_id='10000000-0000-0000-0000-000000000006' and idempotency_key='signup_bonus:10000000-0000-0000-0000-000000000006')<>1 then
    raise exception 'concurrent activation created duplicate signup ledger entries';
  end if;
  if (select balance from public.armex_wallets where user_id='10000000-0000-0000-0000-000000000001')<>1299 then
    raise exception 'concurrent referral activation did not grant exactly one additional 200-credit reward';
  end if;
  if (select status from public.armex_referrals where id='20000000-0000-0000-0000-000000000004')<>'rewarded' then
    raise exception 'concurrent referral did not reach rewarded state';
  end if;
  if (select count(*) from public.armex_credit_transactions where user_id='10000000-0000-0000-0000-000000000001' and idempotency_key='referral_bonus:20000000-0000-0000-0000-000000000004')<>1 then
    raise exception 'concurrent referral created duplicate ledger entries';
  end if;
end
$concurrent$;
select dblink_disconnect('signup_a');
select dblink_disconnect('signup_b');
