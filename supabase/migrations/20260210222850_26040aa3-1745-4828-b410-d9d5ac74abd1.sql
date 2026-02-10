
-- 1) Enforce "loosen-only" invariant in the manual override RPC
CREATE OR REPLACE FUNCTION public.manual_risk_throttle_override(
  p_purchase_enabled boolean,
  p_eligibility_delay_bonus_days integer,
  p_reason text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_current_purchase_enabled boolean;
  v_current_delay integer;
BEGIN
  IF NOT has_role(auth.uid(), 'admin'::app_role) THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  -- Fetch current state
  SELECT purchase_enabled, eligibility_delay_bonus_days
    INTO v_current_purchase_enabled, v_current_delay
    FROM risk_throttle_state
   WHERE id = '00000000-0000-0000-0000-000000000002'::uuid;

  -- INVARIANT: Only machines tighten. Humans can only loosen.
  -- Reject any attempt to tighten (disable purchases or increase delay)
  IF p_purchase_enabled = false THEN
    RAISE EXCEPTION 'Manual override cannot disable purchases. Only the automated engine can tighten.';
  END IF;

  IF p_eligibility_delay_bonus_days > v_current_delay THEN
    RAISE EXCEPTION 'Manual override cannot increase eligibility delay (current: %, requested: %). Only the automated engine can tighten.',
      v_current_delay, p_eligibility_delay_bonus_days;
  END IF;

  UPDATE risk_throttle_state SET
    purchase_enabled = p_purchase_enabled,
    eligibility_delay_bonus_days = p_eligibility_delay_bonus_days,
    manual_override_by = auth.uid(),
    manual_override_at = now(),
    manual_override_reason = p_reason,
    updated_at = now()
  WHERE id = '00000000-0000-0000-0000-000000000002'::uuid;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.manual_risk_throttle_override FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.manual_risk_throttle_override FROM anon;
GRANT EXECUTE ON FUNCTION public.manual_risk_throttle_override TO authenticated;
