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
     OR to_regclass('public.armex_payment_orders') IS NULL
     OR to_regclass('public.armex_usage') IS NULL THEN
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

  IF EXISTS (
    SELECT 1
    FROM public.armex_payment_orders
    WHERE provider IS NOT NULL
      AND provider_reference IS NOT NULL
      AND btrim(provider_reference) <> ''
    GROUP BY provider, provider_reference
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'ARMEX migration preflight failed: duplicate provider payment references must be resolved first';
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
  v_invitee_granted boolean;
  v_referrer_ledger_exists boolean;
  v_invitee_ledger_exists boolean;
  v_has_successful_usage boolean;
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

  IF v_status = 'rejected' OR v_status NOT IN ('pending', 'qualified') THEN
    RETURN false;
  END IF;

  -- A referral is successful only after the referred account has at least
  -- one recorded successful tool request. The usage row is written by the
  -- trusted generation backend, not by the browser.
  SELECT EXISTS (
    SELECT 1
    FROM public.armex_usage u
    WHERE u.user_id = p_referred_user_id
      AND u.request_id IS NOT NULL
      AND u.created_at >= (
        SELECT au.created_at
        FROM auth.users au
        WHERE au.id = p_referred_user_id
      )
  ) INTO v_has_successful_usage;

  IF NOT v_has_successful_usage THEN
    RETURN false;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM auth.users
    WHERE id = p_referred_user_id AND email_confirmed_at IS NOT NULL
  ) THEN
    RETURN false;
  END IF;

  IF v_referrer_id IS NULL OR v_referrer_id = p_referred_user_id THEN
    RETURN false;
  END IF;

  v_key := 'referral_bonus:' || v_referral_id::text;

  UPDATE public.armex_referrals
  SET status = 'qualified',
      qualified_at = COALESCE(qualified_at, now())
  WHERE id = v_referral_id
    AND status = 'pending';

  -- Both sides receive 200 credits for one qualified referral.
  -- Separate idempotency keys prevent cross-recipient collisions.
  v_granted := public.armex_grant_credits(
    v_referrer_id,
    200,
    'referral_bonus',
    v_key || ':referrer',
    'پاداش دعوت موفق',
    jsonb_build_object('referral_id', v_referral_id, 'referred_user_id', p_referred_user_id, 'recipient', 'referrer')
  );

  v_invitee_granted := public.armex_grant_credits(
    p_referred_user_id,
    200,
    'referral_bonus',
    v_key || ':referred',
    'پاداش ثبت‌نام با دعوت موفق',
    jsonb_build_object('referral_id', v_referral_id, 'referrer_user_id', v_referrer_id, 'recipient', 'referred')
  );

  SELECT EXISTS (
    SELECT 1 FROM public.armex_credit_transactions
    WHERE user_id = v_referrer_id
      AND idempotency_key = v_key || ':referrer'
  ) INTO v_referrer_ledger_exists;

  SELECT EXISTS (
    SELECT 1 FROM public.armex_credit_transactions
    WHERE user_id = p_referred_user_id
      AND idempotency_key = v_key || ':referred'
  ) INTO v_invitee_ledger_exists;

  -- Raising rolls back both grants if either ledger entry is missing.
  IF NOT v_referrer_ledger_exists OR NOT v_invitee_ledger_exists THEN
    RAISE EXCEPTION 'Referral reward could not be completed atomically for referral %', v_referral_id;
  END IF;

  UPDATE public.armex_referrals
  SET status = 'rewarded',
      rewarded_at = COALESCE(rewarded_at, now())
  WHERE id = v_referral_id;

  RETURN true;
END;
$function$;


-- 7) Atomically credit a verified payment order exactly once.
-- The caller MUST verify the provider's signed callback/server-side payment
-- status and amount before invoking this service-role-only function.
CREATE OR REPLACE FUNCTION public.armex_settle_payment_order(
  p_order_id uuid,
  p_provider_reference text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_order public.armex_payment_orders%ROWTYPE;
  v_granted boolean;
  v_ledger_exists boolean;
  v_key text;
BEGIN
  IF p_order_id IS NULL OR NULLIF(btrim(p_provider_reference), '') IS NULL THEN
    RAISE EXCEPTION 'Order ID and provider reference are required';
  END IF;

  SELECT *
    INTO v_order
  FROM public.armex_payment_orders
  WHERE id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF v_order.provider_reference IS DISTINCT FROM p_provider_reference THEN
    RETURN false;
  END IF;

  v_key := 'payment_order:' || v_order.id::text;

  SELECT EXISTS (
    SELECT 1
    FROM public.armex_credit_transactions
    WHERE user_id = v_order.user_id
      AND idempotency_key = v_key
  ) INTO v_ledger_exists;

  IF v_order.status = 'paid' THEN
    RETURN v_ledger_exists;
  END IF;

  IF v_order.status <> 'pending' THEN
    RETURN false;
  END IF;

  v_granted := public.armex_grant_credits(
    v_order.user_id,
    v_order.credits,
    'purchase',
    v_key,
    'شارژ اعتبار از طریق پرداخت',
    jsonb_build_object(
      'payment_order_id', v_order.id,
      'provider', v_order.provider,
      'provider_reference', v_order.provider_reference,
      'amount', v_order.amount,
      'currency', v_order.currency
    )
  );

  SELECT EXISTS (
    SELECT 1
    FROM public.armex_credit_transactions
    WHERE user_id = v_order.user_id
      AND idempotency_key = v_key
  ) INTO v_ledger_exists;

  IF NOT v_granted AND NOT v_ledger_exists THEN
    RETURN false;
  END IF;

  UPDATE public.armex_payment_orders
  SET status = 'paid',
      updated_at = now()
  WHERE id = v_order.id;

  RETURN true;
END;
$function$;

-- 8) Referral qualification and payment settlement must never be callable by browser users.
REVOKE ALL ON FUNCTION public.armex_activate_user(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.armex_activate_user(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.armex_grant_credits(uuid, bigint, text, text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.armex_grant_credits(uuid, bigint, text, text, text, jsonb) TO service_role;

REVOKE ALL ON FUNCTION public.armex_debit_credits(uuid, bigint, text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.armex_debit_credits(uuid, bigint, text, text, jsonb) TO service_role;

REVOKE ALL ON FUNCTION public.armex_qualify_referral(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.armex_qualify_referral(uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.armex_qualify_referral(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.armex_settle_payment_order(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.armex_settle_payment_order(uuid, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.armex_settle_payment_order(uuid, text) TO service_role;

-- Legacy credit mutation must not remain callable through the old RPC.
REVOKE ALL ON FUNCTION public.process_credit_transaction(uuid, integer, text, text, text)
  FROM PUBLIC, anon, authenticated, service_role;

-- Trigger functions are not client RPC endpoints.
REVOKE ALL ON FUNCTION public.armex_create_profile_on_signup() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.armex_prevent_profile_credit_edit() FROM PUBLIC, anon, authenticated, service_role;

-- 9) Prevent duplicate payment references from being settled more than once.
-- The provider is included because references may only be unique within a provider.
CREATE UNIQUE INDEX IF NOT EXISTS armex_payment_orders_provider_reference_uidx
ON public.armex_payment_orders (provider, provider_reference)
WHERE provider IS NOT NULL
  AND provider_reference IS NOT NULL
  AND btrim(provider_reference) <> '';

COMMENT ON FUNCTION public.armex_qualify_referral(uuid) IS
'Trusted backend-only referral qualification. Requires a confirmed account and a successful usage row written only after generation succeeds; grants 200 credits to both referrer and referred user. The backend must additionally enforce anti-abuse checks.';

COMMENT ON FUNCTION public.armex_settle_payment_order(uuid, text) IS
'Atomically credits a pending payment order once. Invoke only after the payment provider callback has been verified server-side.';

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
