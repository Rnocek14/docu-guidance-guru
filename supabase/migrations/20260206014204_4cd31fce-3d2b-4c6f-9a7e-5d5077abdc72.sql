-- =====================================================
-- P0-B FIX: Correct PL/pgSQL syntax + add geo-mismatch hold
-- =====================================================

-- 1) Fix assert_jurisdiction_allowed - move DECLARE to top level
-- =====================================================
CREATE OR REPLACE FUNCTION public.assert_jurisdiction_allowed(p_action text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_country text;
  v_rule public.jurisdiction_rules%rowtype;
  v_kyc_status text;
BEGIN
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'not_authenticated');
  END IF;

  SELECT country_code INTO v_country
  FROM public.user_jurisdiction
  WHERE user_id = v_user;

  IF v_country IS NULL THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'jurisdiction_unknown');
  END IF;

  SELECT * INTO v_rule
  FROM public.jurisdiction_rules
  WHERE country_code = v_country;

  IF NOT FOUND THEN
    -- No rules = not explicitly allowed = blocked by default
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

  -- KYC gates (single lookup, reuse v_kyc_status)
  IF (p_action = 'trade' AND v_rule.require_kyc_before_trading)
     OR (p_action IN ('payout_request', 'payout_send') AND v_rule.require_kyc_before_payout) THEN
    SELECT kyc_status INTO v_kyc_status FROM public.profiles WHERE user_id = v_user;
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

-- 2) Add geo-mismatch hold columns to profiles
-- =====================================================
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS payouts_hold boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS payouts_hold_reason text,
  ADD COLUMN IF NOT EXISTS payouts_hold_at timestamptz;

-- 3) Create apply_geo_mismatch_hold RPC (service_role only)
-- Checks for geo mismatches and applies hold if found
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

  -- Apply hold
  UPDATE public.profiles
  SET payouts_hold = true,
      payouts_hold_reason = v_hold_reason,
      payouts_hold_at = now()
  WHERE user_id = _user_id
    AND payouts_hold = false;  -- Only update if not already on hold

  -- Audit log
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
END;
$$;

-- Lock down: service_role only
REVOKE EXECUTE ON FUNCTION public.apply_geo_mismatch_hold(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.apply_geo_mismatch_hold(uuid) TO service_role;

-- 4) Create manual_payout_hold_release RPC (admin only via service_role)
-- =====================================================
CREATE OR REPLACE FUNCTION public.manual_payout_hold_release(
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
  v_actor_id uuid;
  v_is_admin boolean;
  v_request_id uuid := gen_random_uuid();
  v_current_hold boolean;
  v_current_reason text;
BEGIN
  -- Get actor from current session (set by edge function)
  v_actor_id := current_setting('app.current_user_id', true)::uuid;
  
  IF v_actor_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'actor_not_set');
  END IF;

  -- Check admin role
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles 
    WHERE user_id = v_actor_id AND role = 'admin'
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

  -- Audit
  INSERT INTO public.audit_logs (user_id, account_id, action, details, reason, request_id)
  VALUES (
    v_actor_id,
    NULL,
    'payout_unfreeze_manual',
    jsonb_build_object(
      'actor_type', 'staff',
      'actor_user_id', v_actor_id,
      'target_user_id', _target_user_id,
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

-- Lock down: service_role only (edge function sets actor context)
REVOKE EXECUTE ON FUNCTION public.manual_payout_hold_release(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.manual_payout_hold_release(uuid, text, text) TO service_role;

-- 5) Update validate_payout_request to check payouts_hold
-- =====================================================
CREATE OR REPLACE FUNCTION public.validate_payout_request(
  _account_id uuid,
  _requested_amount numeric
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_account public.accounts%rowtype;
  v_profile public.profiles%rowtype;
  v_eligibility jsonb;
  v_max_eligible numeric;
  v_jurisdiction_check jsonb;
BEGIN
  -- Get account and verify ownership
  SELECT * INTO v_account FROM public.accounts WHERE id = _account_id;
  
  IF NOT FOUND THEN
    RETURN jsonb_build_object('valid', false, 'reason', 'account_not_found');
  END IF;

  v_user_id := v_account.user_id;
  
  -- Ownership check
  IF v_user_id <> auth.uid() THEN
    RETURN jsonb_build_object('valid', false, 'reason', 'not_account_owner');
  END IF;

  -- Get profile for freeze/hold checks
  SELECT * INTO v_profile FROM public.profiles WHERE user_id = v_user_id;

  -- Check payouts_frozen (chargeback-based freeze)
  IF v_profile.payouts_frozen THEN
    RETURN jsonb_build_object('valid', false, 'reason', 'payouts_frozen', 'frozen_reason', v_profile.payouts_frozen_reason);
  END IF;

  -- Check payouts_hold (geo-mismatch hold)
  IF v_profile.payouts_hold THEN
    RETURN jsonb_build_object('valid', false, 'reason', 'payouts_on_hold', 'hold_reason', v_profile.payouts_hold_reason);
  END IF;

  -- Jurisdiction check
  v_jurisdiction_check := public.assert_jurisdiction_allowed('payout_request');
  IF NOT (v_jurisdiction_check->>'allowed')::boolean THEN
    RETURN jsonb_build_object('valid', false, 'reason', v_jurisdiction_check->>'reason', 'country', v_jurisdiction_check->>'country');
  END IF;

  -- Calculate eligibility
  v_eligibility := public.calculate_payout_eligibility(_account_id);
  
  IF NOT (v_eligibility->>'eligible')::boolean THEN
    RETURN jsonb_build_object('valid', false, 'reason', v_eligibility->>'reason', 'eligibility', v_eligibility);
  END IF;

  v_max_eligible := (v_eligibility->>'max_eligible_amount')::numeric;

  IF _requested_amount > v_max_eligible THEN
    RETURN jsonb_build_object(
      'valid', false, 
      'reason', 'amount_exceeds_eligible',
      'requested', _requested_amount,
      'max_eligible', v_max_eligible,
      'eligibility', v_eligibility
    );
  END IF;

  IF _requested_amount <= 0 THEN
    RETURN jsonb_build_object('valid', false, 'reason', 'invalid_amount');
  END IF;

  RETURN jsonb_build_object(
    'valid', true,
    'requested_amount', _requested_amount,
    'max_eligible', v_max_eligible,
    'eligibility', v_eligibility,
    'jurisdiction', v_jurisdiction_check
  );
END;
$$;