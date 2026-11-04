-- ARMEX AI STUDIO
-- Unified signup, wallet and referral-credit migration
-- Draft prepared from the inspected ARMEX-CORE schema.
-- REVIEW REQUIRED: apply only to the intended Supabase project after reviewing this file.
-- This migration is transactional and deliberately keeps legacy tables/functions in place.

BEGIN;

-- 1) Fail safely if the inspected schema has changed since preparation.
DO $preflight$
BEGIN
  IF to_regclass('auth.users') IS NULL
     OR to_regclass('public.profiles') IS NULL
     OR to_regclass('public.armex_wallets') IS NULL
     OR to_regclass('public.armex_credit_transactions') IS NULL
     OR to_regclass('public.armex_referral_codes') IS NULL
     OR to_regclass('public.armex_referrals') IS NULL
     OR to_regclass('public.armex_payment_orders') IS NULL THEN
    RAISE EXCEPTION 'ARMEX migration preflight failed: one or more required tables are missing';
  END IF;

  IF to_regprocedure('public.armex_grant_credits(uuid,bigint,text,text,text,jsonb)') IS NULL
     OR to_regprocedure('public.armex_auth_user_handler()') IS NULL THEN
    RAISE EXCEPTION 'ARMEX migration preflight failed: required ARMEX functions are missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'auth.users'::regclass
      AND tgname = 'armex_auth_user_handler_trigger'
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'ARMEX migration preflight failed: expected ARMEX auth trigger is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'credits'
  ) THEN
    RAISE EXCEPTION 'ARMEX migration preflight failed: profiles.credits is missing';
  END IF;
END
$preflight$;

-- 2) Remove the legacy signup trigger that writes to profiles.credits
-- and public.credit_transactions. Keep the legacy function/table for audit/rollback.
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;

-- 3) Ensure every new Auth user gets a profile row, without granting credits here.
CREATE OR REPLACE FUNCTION public.armex_create_profile_on_signup()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  INSERT INTO public.profiles (id, username, full_name, credits)
  VALUES (
    NEW.id,
    NULL,
    COALESCE(
      NULLIF(NEW.raw_user_meta_data ->> 'full_name', ''),
      NULLIF(NEW.raw_user_meta_data ->> 'name', '')
    ),
    0
  )
  ON CONFLICT (id) DO NOTHING;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS armex_profile_bootstrap_trigger ON auth.users;
CREATE TRIGGER armex_profile_bootstrap_trigger
AFTER INSERT ON auth.users
FOR EACH ROW
EXECUTE FUNCTION public.armex_create_profile_on_signup();

-- 4) Protect the legacy display/profile balance from direct client-side changes.
-- The authoritative balance is public.armex_wallets.balance.
CREATE OR REPLACE FUNCTION public.armex_prevent_profile_credit_edit()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
  IF NEW.credits IS DISTINCT FROM OLD.credits
     AND current_user <> 'postgres' THEN
    RAISE EXCEPTION 'Profile credits are managed by the ARMEX credit ledger';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS armex_protect_profile_credits ON public.profiles;
CREATE TRIGGER armex_protect_profile_credits
BEFORE UPDATE OF credits ON public.profiles
FOR EACH ROW
EXECUTE FUNCTION public.armex_prevent_profile_credit_edit();

-- 5) Make the existing activation function grant only the one-time signup bonus.
-- Referral rewards are intentionally separated from email confirmation and require
-- a trusted server-side qualification call (see armex_qualify_referral below).
CREATE OR REPLACE FUNCTION public.armex_activate_user(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'User ID is required';
  END IF;

  PERFORM public.armex_grant_credits(
    p_user_id,
    500,
    'signup_bonus',
    'signup_bonus:' || p_user_id::text,
    'اعتبار هدیه ثبت‌نام',
    '{}'::jsonb
  );
END;
$function$;

-- 6) Referral qualification is a trusted backend-only operation.
-- Call only after the product's qualifying action and anti-abuse checks pass.
CREATE OR REPLACE FUNCTION public.armex_qualify_referral(p_referred_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_referral_id uuid;
  v_referrer_id uuid;
  v_status text;
  v_granted boolean;
  v_already_rewarded boolean;
  v_key text;
BEGIN
  IF p_referred_user_id IS NULL THEN
    RAISE EXCEPTION 'Referred user ID is required';
  END IF;

  SELECT id, referrer_user_id, status
    INTO v_referral_id, v_referrer_id, v_status
  FROM public.armex_referrals
  WHERE referred_user_id = p_referred_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF v_status = 'rewarded' THEN
    RETURN true;
  END IF;

  IF v_status = 'rejected' THEN
    RETURN false;
  END IF;

  v_key := 'referral_bonus:' || v_referral_id::text;

  UPDATE public.armex_referrals
  SET status = 'qualified',
      qualified_at = COALESCE(qualified_at, now())
  WHERE id = v_referral_id
    AND status = 'pending';

  v_granted := public.armex_grant_credits(
    v_referrer_id,
    200,
    'referral_bonus',
    v_key,
    'پاداش دعوت موفق',
    jsonb_build_object('referral_id', v_referral_id, 'referred_user_id', p_referred_user_id)
  );

  SELECT EXISTS (
    SELECT 1
    FROM public.armex_credit_transactions
    WHERE user_id = v_referrer_id
      AND idempotency_key = v_key
  ) INTO v_already_rewarded;

  IF v_granted OR v_already_rewarded THEN
    UPDATE public.armex_referrals
    SET status = 'rewarded',
        rewarded_at = COALESCE(rewarded_at, now())
    WHERE id = v_referral_id;

    RETURN true;
  END IF;

  RETURN false;
END;
$function$;

-- 7) Referral qualification must never be callable by browser users.
REVOKE ALL ON FUNCTION public.armex_qualify_referral(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.armex_qualify_referral(uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.armex_qualify_referral(uuid) TO service_role;

-- Legacy credit mutation must not remain callable through the old RPC.
REVOKE ALL ON FUNCTION public.process_credit_transaction(uuid, integer, text, text, text)
  FROM PUBLIC, anon, authenticated, service_role;

-- Trigger functions are not client RPC endpoints.
REVOKE ALL ON FUNCTION public.armex_create_profile_on_signup() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.armex_prevent_profile_credit_edit() FROM PUBLIC, anon, authenticated, service_role;

-- 8) Prevent duplicate payment references from being settled more than once.
-- The provider is included because references may only be unique within a provider.
CREATE UNIQUE INDEX IF NOT EXISTS armex_payment_orders_provider_reference_uidx
ON public.armex_payment_orders (provider, provider_reference)
WHERE provider IS NOT NULL
  AND provider_reference IS NOT NULL
  AND btrim(provider_reference) <> '';

COMMENT ON FUNCTION public.armex_qualify_referral(uuid) IS
'Trusted backend-only referral qualification. Call only after server-side product qualification and anti-abuse checks.';

COMMENT ON TABLE public.armex_wallets IS
'Authoritative ARMEX credit balance. Client writes are not permitted; mutate through trusted server-side functions.';

COMMIT;

-- Post-migration verification (run separately after successful commit):
-- SELECT tgname, pg_get_triggerdef(oid)
-- FROM pg_trigger
-- WHERE tgrelid = 'auth.users'::regclass AND NOT tgisinternal
-- ORDER BY tgname;
--
-- SELECT indexname, indexdef
-- FROM pg_indexes
-- WHERE schemaname = 'public'
--   AND tablename = 'armex_payment_orders';
