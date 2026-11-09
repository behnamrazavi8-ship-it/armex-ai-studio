-- Harden signup and referral activation against duplicate auth events and ledger replays.
-- Staged only: this migration is exercised by a disposable PostgreSQL CI fixture.
-- It is NOT applied to the live Supabase project.

create or replace function public.armex_activate_user(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  r record;
  v_grant_created boolean;
  v_existing_amount bigint;
  v_existing_type text;
  v_existing_metadata jsonb;
begin
  if p_user_id is null then
    raise exception 'Invalid activation user';
  end if;

  -- Activation is permitted only after the Auth account is verified.
  if not exists (
    select 1
    from auth.users
    where id = p_user_id
      and email_confirmed_at is not null
  ) then
    return;
  end if;

  -- Stable per-user key makes repeated INSERT/confirmation events harmless.
  v_grant_created := public.armex_grant_credits(
    p_user_id, 500, 'signup_bonus',
    'signup_bonus:' || p_user_id::text,
    'اعتبار هدیه ثبت‌نام'
  );

  -- A false result is an exact duplicate under the hardened wallet RPC.
  -- Verify durable ledger evidence rather than assuming success.
  if not v_grant_created then
    select amount, transaction_type, metadata
      into v_existing_amount, v_existing_type, v_existing_metadata
    from public.armex_credit_transactions
    where user_id = p_user_id
      and idempotency_key = 'signup_bonus:' || p_user_id::text;

    if not found or v_existing_amount <> 500 or v_existing_type <> 'signup_bonus' then
      raise exception 'Signup bonus idempotency evidence conflicts' using errcode = '23505';
    end if;
  end if;

  -- Either participant may be the account that has just become verified.
  -- Pay only after BOTH the referrer and referred account are verified.
  -- This also recovers a pending referral when the referrer verifies later.
  for r in
    select f.id, f.referrer_user_id
    from public.armex_referrals f
    join auth.users referred on referred.id = f.referred_user_id
    join auth.users referrer on referrer.id = f.referrer_user_id
    where (f.referred_user_id = p_user_id or f.referrer_user_id = p_user_id)
      and f.status in ('pending', 'qualified')
      and referred.email_confirmed_at is not null
      and referrer.email_confirmed_at is not null
    order by f.created_at, f.id
    for update of f
  loop
    update public.armex_referrals
    set status = 'qualified', qualified_at = coalesce(qualified_at, now())
    where id = r.id;

    v_grant_created := public.armex_grant_credits(
      r.referrer_user_id, 200, 'referral_bonus',
      'referral_bonus:' || r.id::text,
      'پاداش دعوت موفق',
      jsonb_build_object('referral_id', r.id)
    );

    if not v_grant_created then
      select amount, transaction_type, metadata
        into v_existing_amount, v_existing_type, v_existing_metadata
      from public.armex_credit_transactions
      where user_id = r.referrer_user_id
        and idempotency_key = 'referral_bonus:' || r.id::text;

      if not found
         or v_existing_amount <> 200
         or v_existing_type <> 'referral_bonus'
         or coalesce(v_existing_metadata->>'referral_id', '') <> r.id::text then
        raise exception 'Referral bonus idempotency evidence conflicts' using errcode = '23505';
      end if;
    end if;

    update public.armex_referrals
    set status = 'rewarded', rewarded_at = coalesce(rewarded_at, now())
    where id = r.id;
  end loop;
end;
$function$;

revoke all on function public.armex_activate_user(uuid) from public, anon, authenticated;
