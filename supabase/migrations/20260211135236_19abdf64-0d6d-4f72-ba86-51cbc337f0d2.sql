
-- Fix type mismatch in trg_enforce_breaker_on_payout: cast enum to text for comparison
CREATE OR REPLACE FUNCTION public.trg_enforce_breaker_on_payout()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_payouts_blocked boolean;
  v_approvals_blocked boolean;
  v_level text;
  v_old_status text;
  v_new_status text;
BEGIN
  SELECT payouts_blocked, approvals_blocked, breaker_level
  INTO v_payouts_blocked, v_approvals_blocked, v_level
  FROM econ_breaker_state
  WHERE id = '00000000-0000-0000-0000-000000000001';

  -- FAIL-CLOSED: missing row blocks everything
  IF NOT FOUND THEN
    RAISE EXCEPTION 'BREAKER_STATE_MISSING: fail-closed. All payout transitions blocked.';
  END IF;

  -- Cast enum to text so comparisons always work
  v_new_status := NEW.status::text;

  IF TG_OP = 'INSERT' THEN
    v_old_status := NULL;
  ELSE
    v_old_status := OLD.status::text;
  END IF;

  -- Block approval transitions
  IF v_new_status = 'approved' AND (v_old_status IS DISTINCT FROM v_new_status) THEN
    IF COALESCE(v_approvals_blocked, true) THEN
      RAISE EXCEPTION 'BREAKER_ACTIVE: approvals blocked. level=%', v_level;
    END IF;
  END IF;

  -- Block payment-exposure transitions
  IF v_new_status IN ('payment_initiated', 'paid', 'paid_confirmed')
     AND (v_old_status IS DISTINCT FROM v_new_status) THEN
    IF COALESCE(v_payouts_blocked, true) THEN
      RAISE EXCEPTION 'BREAKER_ACTIVE: payouts blocked. level=%', v_level;
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;
