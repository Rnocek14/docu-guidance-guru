-- =====================================================
-- P0-B FIXES: Actor resolution, audit correctness, idempotency
-- =====================================================

-- 1) Add new audit action for hold release
-- =====================================================
ALTER TYPE public.audit_action ADD VALUE IF NOT EXISTS 'payout_hold_release_manual';

-- 2) Fix manual_payout_hold_release - explicit actor param, correct audit target
-- =====================================================
DROP FUNCTION IF EXISTS public.manual_payout_hold_release(uuid, text, text);

CREATE OR REPLACE FUNCTION public.manual_payout_hold_release(
  _actor_user_id uuid,
  _target_user_id uuid,
  _reason text,
  _evidence_notes text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_is_admin boolean;
  v_request_id uuid := gen_random_uuid();
  v_current_hold boolean;
  v_current_reason text;
BEGIN
  -- Ensure actor exists + is admin
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _actor_user_id AND role = 'admin'
  ) INTO v_is_admin;

  IF NOT v_is_admin THEN
    RETURN jsonb_build_object('success', false, 'error', 'admin_required');
  END IF;

  -- Get current hold state
  SELECT payouts_hold, payouts_hold_reason
  INTO v_current_hold, v_current_reason
  FROM public.profiles
  WHERE user_id = _target_user_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'user_not_found');
  END IF;

  IF NOT v_current_hold THEN
    RETURN jsonb_build_object('success', false, 'error', 'no_hold_active');
  END IF;

  -- Release hold
  UPDATE public.profiles
  SET payouts_hold = false,
      payouts_hold_reason = NULL,
      payouts_hold_at = NULL
  WHERE user_id = _target_user_id;

  -- Audit: user_id = affected user (target), actor in details
  INSERT INTO public.audit_logs (user_id, action, details, reason, request_id)
  VALUES (
    _target_user_id,
    'payout_hold_release_manual',
    jsonb_build_object(
      'actor_type', 'staff',
      'actor_user_id', _actor_user_id,
      'previous_hold_reason', v_current_reason,
      'evidence_notes', _evidence_notes
    ),
    _reason,
    v_request_id
  );

  RETURN jsonb_build_object(
    'success', true,
    'previous_hold_reason', v_current_reason,
    'request_id', v_request_id
  );
END;
$$;

-- Lock down: service_role only
REVOKE EXECUTE ON FUNCTION public.manual_payout_hold_release(uuid, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.manual_payout_hold_release(uuid, uuid, text, text) TO service_role;

-- 3) Fix apply_geo_mismatch_hold - idempotent audit (only log when actually changed)
-- =====================================================
CREATE OR REPLACE FUNCTION public.apply_geo_mismatch_hold(_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_mismatch_result jsonb;
  v_has_mismatch boolean;
  v_reasons text[];
  v_hold_reason text;
  v_request_id uuid := gen_random_uuid();
  v_rows_affected int;
BEGIN
  -- Check for geo mismatches
  v_mismatch_result := public.check_geo_mismatch(_user_id);
  v_has_mismatch := (v_mismatch_result->>'has_mismatch')::boolean;

  IF NOT v_has_mismatch THEN
    RETURN jsonb_build_object('success', true, 'hold_applied', false, 'reason', 'no_mismatch');
  END IF;

  -- Extract reasons
  SELECT array_agg(r::text) INTO v_reasons
  FROM jsonb_array_elements_text(v_mismatch_result->'reasons') r;

  -- Determine severity and build hold reason
  IF 'kyc_billing_mismatch' = ANY(v_reasons) THEN
    v_hold_reason := 'kyc_billing_country_mismatch';
  ELSIF 'ip_kyc_mismatch' = ANY(v_reasons) OR 'ip_billing_mismatch' = ANY(v_reasons) THEN
    v_hold_reason := 'ip_country_mismatch';
  ELSE
    v_hold_reason := 'geo_mismatch';
  END IF;

  -- Apply hold (only if not already on hold)
  UPDATE public.profiles
  SET payouts_hold = true,
      payouts_hold_reason = v_hold_reason,
      payouts_hold_at = now()
  WHERE user_id = _user_id
    AND payouts_hold = false;

  -- Check if we actually changed anything
  GET DIAGNOSTICS v_rows_affected = ROW_COUNT;

  -- Only audit if we actually applied the hold (idempotent)
  IF v_rows_affected = 1 THEN
    INSERT INTO public.audit_logs (user_id, action, details, request_id)
    VALUES (
      _user_id,
      'geo_mismatch_detected',
      jsonb_build_object(
        'actor_type', 'system',
        'mismatch_result', v_mismatch_result,
        'hold_reason', v_hold_reason
      ),
      v_request_id
    );

    RETURN jsonb_build_object(
      'success', true,
      'hold_applied', true,
      'hold_reason', v_hold_reason,
      'mismatch_details', v_mismatch_result,
      'request_id', v_request_id
    );
  ELSE
    -- Already on hold - return success but no new hold applied
    RETURN jsonb_build_object(
      'success', true,
      'hold_applied', false,
      'reason', 'already_on_hold',
      'mismatch_details', v_mismatch_result
    );
  END IF;
END;
$$;

-- 4) Create service-role jurisdiction check for staff acting on behalf of users
-- =====================================================
CREATE OR REPLACE FUNCTION public.assert_user_jurisdiction_allowed(
  _user_id uuid,
  p_action text  -- 'trade'|'purchase'|'payout_request'|'payout_send'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_country text;
  v_rule public.jurisdiction_rules%rowtype;
  v_kyc_status text;
BEGIN
  IF _user_id IS NULL THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'user_id_required');
  END IF;

  SELECT country_code INTO v_country
  FROM public.user_jurisdiction
  WHERE user_id = _user_id;

  IF v_country IS NULL THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'jurisdiction_unknown');
  END IF;

  SELECT * INTO v_rule
  FROM public.jurisdiction_rules
  WHERE country_code = v_country;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'no_rules_for_country', 'country', v_country);
  END IF;

  IF v_rule.is_allowed = false THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'country_blocked', 'country', v_country);
  END IF;

  -- Action-specific gates
  IF p_action IN ('trade', 'purchase') AND v_rule.allow_evaluation = false THEN
    RETURN jsonb_build_object('allowed', false, 'reason', p_action || '_not_allowed', 'country', v_country);
  END IF;

  IF p_action IN ('payout_request', 'payout_send') AND v_rule.allow_payouts = false THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'payouts_not_allowed', 'country', v_country);
  END IF;

  -- KYC gates
  IF (p_action = 'trade' AND v_rule.require_kyc_before_trading)
     OR (p_action IN ('payout_request', 'payout_send') AND v_rule.require_kyc_before_payout) THEN
    SELECT kyc_status INTO v_kyc_status FROM public.profiles WHERE user_id = _user_id;
    IF v_kyc_status IS DISTINCT FROM 'verified' THEN
      RETURN jsonb_build_object('allowed', false, 'reason', 'kyc_required', 'country', v_country);
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'allowed', true,
    'country', v_country,
    'terms_version', v_rule.terms_version,
    'disclosure_version', v_rule.disclosure_version,
    'require_market_data_attestation', v_rule.require_market_data_attestation
  );
END;
$$;

-- Lock down: service_role only (for staff acting on behalf of users)
REVOKE EXECUTE ON FUNCTION public.assert_user_jurisdiction_allowed(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.assert_user_jurisdiction_allowed(uuid, text) TO service_role;