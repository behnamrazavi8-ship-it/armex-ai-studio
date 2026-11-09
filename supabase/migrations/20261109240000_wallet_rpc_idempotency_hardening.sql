-- Harden wallet RPC idempotency semantics.
-- Staged only: CI applies this to a disposable PostgreSQL fixture.
create or replace function public.armex_debit_credits(
  p_user_id uuid,
  p_amount bigint,
  p_idempotency_key text,
  p_description text default null,
  p_metadata jsonb default '{}'::jsonb
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_balance bigint;
  v_existing_amount bigint;
  v_existing_type text;
begin
  if p_user_id is null
     or p_amount is null or p_amount <= 0
     or nullif(btrim(p_idempotency_key), '') is null then
    raise exception 'Invalid credit debit parameters';
  end if;

  insert into public.armex_wallets(user_id)
  values (p_user_id)
  on conflict (user_id) do nothing;

  select balance into v_balance
  from public.armex_wallets
  where user_id = p_user_id
  for update;

  select amount, transaction_type
  into v_existing_amount, v_existing_type
  from public.armex_credit_transactions
  where user_id = p_user_id
    and idempotency_key = p_idempotency_key;

  if found then
    if v_existing_amount = -p_amount and v_existing_type = 'usage' then
      return true;
    end if;
    raise exception 'Credit debit idempotency key conflicts with an existing ledger entry'
      using errcode = '23505';
  end if;

  if v_balance < p_amount then
    return false;
  end if;

  update public.armex_wallets
  set balance = balance - p_amount, updated_at = now()
  where user_id = p_user_id;

  insert into public.armex_credit_transactions(
    user_id, amount, transaction_type, idempotency_key, description, metadata
  ) values (
    p_user_id, -p_amount, 'usage', p_idempotency_key, p_description,
    coalesce(p_metadata, '{}'::jsonb)
  );

  return true;
end;
$function$;

create or replace function public.armex_grant_credits(
  p_user_id uuid,
  p_amount bigint,
  p_type text,
  p_idempotency_key text,
  p_description text default null,
  p_metadata jsonb default '{}'::jsonb
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_existing_amount bigint;
  v_existing_type text;
begin
  if p_user_id is null
     or p_amount is null or p_amount <= 0
     or p_type is null
     or p_type not in ('signup_bonus','referral_bonus','ad_reward','purchase','refund','admin_adjustment')
     or nullif(btrim(p_idempotency_key), '') is null then
    raise exception 'Invalid credit grant parameters';
  end if;

  insert into public.armex_wallets(user_id)
  values (p_user_id)
  on conflict (user_id) do nothing;

  perform 1
  from public.armex_wallets
  where user_id = p_user_id
  for update;

  select amount, transaction_type
  into v_existing_amount, v_existing_type
  from public.armex_credit_transactions
  where user_id = p_user_id
    and idempotency_key = p_idempotency_key;

  if found then
    if v_existing_amount = p_amount and v_existing_type = p_type then
      return false;
    end if;
    raise exception 'Credit grant idempotency key conflicts with an existing ledger entry'
      using errcode = '23505';
  end if;

  update public.armex_wallets
  set balance = balance + p_amount, updated_at = now()
  where user_id = p_user_id;

  insert into public.armex_credit_transactions(
    user_id, amount, transaction_type, idempotency_key, description, metadata
  ) values (
    p_user_id, p_amount, p_type, p_idempotency_key, p_description,
    coalesce(p_metadata, '{}'::jsonb)
  );

  return true;
end;
$function$;

revoke all on function public.armex_debit_credits(uuid,bigint,text,text,jsonb) from public, anon, authenticated;
revoke all on function public.armex_grant_credits(uuid,bigint,text,text,text,jsonb) from public, anon, authenticated;
grant execute on function public.armex_debit_credits(uuid,bigint,text,text,jsonb) to service_role;
grant execute on function public.armex_grant_credits(uuid,bigint,text,text,text,jsonb) to service_role;
