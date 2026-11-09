-- Invariants for the Production-derived core schema baseline.
do $test$
declare
  v_count integer;
  v_balance bigint;
begin
  select count(*) into v_count
  from pg_class c
  join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and c.relkind='r'
    and c.relname in (
      'profiles','projects','credit_transactions','armex_conversations',
      'armex_messages','armex_payment_orders','armex_referral_codes',
      'armex_referrals','armex_usage','armex_wallets','armex_credit_transactions'
    );
  if v_count <> 11 then
    raise exception 'expected 11 core public tables, found %', v_count;
  end if;

  if exists (
    select 1 from pg_class c
    join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relkind='r'
      and c.relname in (
        'profiles','projects','credit_transactions','armex_conversations',
        'armex_messages','armex_payment_orders','armex_referral_codes',
        'armex_referrals','armex_usage','armex_wallets','armex_credit_transactions'
      )
      and (not c.relrowsecurity or c.relforcerowsecurity)
  ) then
    raise exception 'core tables must have RLS enabled and not forced';
  end if;

  select count(*) into v_count
  from pg_policies
  where schemaname='public'
    and tablename in (
      'profiles','projects','credit_transactions','armex_conversations',
      'armex_messages','armex_payment_orders','armex_referral_codes',
      'armex_referrals','armex_usage','armex_wallets','armex_credit_transactions'
    );
  if v_count <> 15 then
    raise exception 'expected 15 core RLS policies, found %', v_count;
  end if;

  if not exists (select 1 from pg_event_trigger where evtname='ensure_rls') then
    raise exception 'Production ensure_rls event trigger is missing';
  end if;

  select count(*) into v_count
  from pg_trigger
  where tgrelid='auth.users'::regclass
    and not tgisinternal
    and tgname in ('armex_auth_user_handler_trigger','on_auth_user_created');
  if v_count <> 2 then
    raise exception 'expected both observed auth.users triggers, found %', v_count;
  end if;

  if not has_table_privilege('service_role','public.armex_credit_transactions','SELECT')
     or has_table_privilege('service_role','public.armex_credit_transactions','INSERT') then
    raise exception 'credit ledger service_role table grants do not match Production';
  end if;

  if not has_function_privilege('service_role','public.armex_grant_credits(uuid,bigint,text,text,text,jsonb)','EXECUTE')
     or has_function_privilege('anon','public.armex_grant_credits(uuid,bigint,text,text,text,jsonb)','EXECUTE')
     or has_function_privilege('authenticated','public.armex_grant_credits(uuid,bigint,text,text,text,jsonb)','EXECUTE') then
    raise exception 'wallet grant RPC execution boundary is incorrect';
  end if;

  if has_function_privilege('service_role','public.armex_activate_user(uuid)','EXECUTE') then
    raise exception 'activation trigger function must not be directly executable by service_role';
  end if;
end
$test$;

-- The event trigger must protect future public tables too.
create table public.baseline_rls_probe(id integer primary key);
do $probe$
begin
  if not (select relrowsecurity from pg_class where oid='public.baseline_rls_probe'::regclass) then
    raise exception 'ensure_rls did not enable RLS on a newly created public table';
  end if;
end
$probe$;
drop table public.baseline_rls_probe;

-- Synthetic signup reproduces the two observed Production trigger paths.
-- This assertion documents current compatibility behavior; it is not a claim
-- that keeping two independent signup balances is the desired final design.
insert into auth.users(id,email_confirmed_at,raw_user_meta_data)
values('10000000-0000-0000-0000-000000000001',null,'{}'::jsonb);

do $legacy$
begin
  if (select credits from public.profiles where id='10000000-0000-0000-0000-000000000001') <> 500 then
    raise exception 'legacy signup trigger did not produce its observed 500-credit profile balance';
  end if;
  if (select balance from public.armex_wallets where user_id='10000000-0000-0000-0000-000000000001') <> 0 then
    raise exception 'new wallet should wait for email confirmation in this unverified test case';
  end if;
  if (select count(*) from public.credit_transactions where user_id='10000000-0000-0000-0000-000000000001') <> 1 then
    raise exception 'legacy signup ledger evidence is missing';
  end if;
end
$legacy$;

update auth.users
set email_confirmed_at=now()
where id='10000000-0000-0000-0000-000000000001';

do $verified$
begin
  if (select balance from public.armex_wallets where user_id='10000000-0000-0000-0000-000000000001') <> 500 then
    raise exception 'new wallet signup grant did not occur after email confirmation';
  end if;
  if (select count(*) from public.armex_credit_transactions
      where user_id='10000000-0000-0000-0000-000000000001'
        and idempotency_key='signup_bonus:10000000-0000-0000-0000-000000000001'
        and amount=500 and transaction_type='signup_bonus') <> 1 then
    raise exception 'new wallet signup ledger evidence is missing or duplicated';
  end if;
  if (select credits from public.profiles where id='10000000-0000-0000-0000-000000000001') <> 500 then
    raise exception 'legacy profile balance unexpectedly changed during wallet activation';
  end if;
end
$verified$;
