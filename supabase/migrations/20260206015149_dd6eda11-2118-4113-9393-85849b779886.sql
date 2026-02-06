-- =====================================================
-- P0-B FINAL HARDENING: DB-side enforcement + audit hash-chain + kill-switch
-- =====================================================

-- 1) mark_payout_paid: Add jurisdiction + hold + freeze checks (DB-side enforcement)
-- =====================================================
CREATE OR REPLACE FUNCTION public.mark_payout_paid(_payout_id uuid, _payment_reference text, _reviewed_by uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _payout record;
  _account record;
  _cohort record;
  _cohort_payout record;
  _profile record;
  _jurisdiction_check jsonb;
  _current_balance numeric;
  _payout_amount numeric;
  _paid_at timestamptz;
  _lifetime_cap_amount numeric;
  _lifetime_paid_total numeric;
  _lifetime_headroom numeric;
  _new_lifetime_paid_total numeric;
BEGIN
  -- Get payout with lock
  SELECT * INTO _payout
  FROM payouts
  WHERE id = _payout_id
  FOR UPDATE;
  
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Payout not found');
  END IF;
  
  -- IDEMPOTENCY: If already paid, return success with existing data
  IF _payout.status = 'paid' THEN
    RETURN jsonb_build_object(
      'success', true,
      'idempotent', true,
      'payout', jsonb_build_object(
        'id', _payout.id,
        'account_id', _payout.account_id,
        'amount', _payout.amount,
        'status', _payout.status,
        'paid_at', _payout.paid_at,
        'payment_reference', _payout.payment_reference
      )
    );
  END IF;
  
  -- Validate: must be approved to mark paid
  IF _payout.status != 'approved' THEN
    RETURN jsonb_build_object(
      'success', false, 
      'error', 'Payout must be approved before marking paid',
      'current_status', _payout.status
    );
  END IF;
  
  _payout_amount := _payout.amount;
  
  -- HARDENING: Minimum payout defense-in-depth
  IF _payout_amount < 50 THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Payout amount below minimum ($50)',
      'payout_amount', _payout_amount
    );
  END IF;
  
  -- Enforce amount <= calculated_eligible_amount to prevent bypass
  IF _payout.calculated_eligible_amount IS NOT NULL 
     AND _payout_amount > _payout.calculated_eligible_amount THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Payout amount exceeds calculated eligible amount at approval time',
      'payout_amount', _payout_amount,
      'calculated_eligible_amount', _payout.calculated_eligible_amount,
      'hint', 'This payout was modified after approval. Re-approve with correct amount.'
    );
  END IF;
  
  -- Get account with lock for concurrent safety
  SELECT * INTO _account 
  FROM accounts 
  WHERE id = _payout.account_id
  FOR UPDATE;
  
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Account not found');
  END IF;

  -- =====================================================
  -- P0-B DB-SIDE ENFORCEMENT (no bypass even if edge function has bug)
  -- =====================================================
  
  -- Get profile for freeze/hold checks
  SELECT * INTO _profile FROM profiles WHERE user_id = _account.user_id;
  
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Profile not found');
  END IF;
  
  -- Check payouts_frozen (chargeback-based)
  IF _profile.payouts_frozen THEN
    RETURN jsonb_build_object(
      'success', false, 
      'error', 'User payouts are frozen',
      'frozen_reason', _profile.payouts_frozen_reason,
      'hint', 'Resolve chargeback issue before marking paid'
    );
  END IF;
  
  -- Check payouts_hold (geo-mismatch)
  IF _profile.payouts_hold THEN
    RETURN jsonb_build_object(
      'success', false, 
      'error', 'User payouts are on hold',
      'hold_reason', _profile.payouts_hold_reason,
      'hint', 'Release geo-mismatch hold before marking paid'
    );
  END IF;
  
  -- Check jurisdiction (canonical RPC)
  _jurisdiction_check := public.assert_user_jurisdiction_allowed(_account.user_id, 'payout_send');
  
  IF NOT COALESCE((_jurisdiction_check->>'allowed')::boolean, false) THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Jurisdiction blocks payout',
      'jurisdiction_reason', _jurisdiction_check->>'reason',
      'country', _jurisdiction_check->>'country'
    );
  END IF;
  
  -- =====================================================
  -- CONTINUE WITH EXISTING LOGIC
  -- =====================================================
  
  SELECT * INTO _cohort FROM cohorts WHERE id = _account.cohort_id;
  
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Cohort not found');
  END IF;
  
  -- Get or create per-cohort payout tracking row with lock
  SELECT * INTO _cohort_payout
  FROM user_cohort_payouts
  WHERE user_id = _account.user_id AND cohort_id = _account.cohort_id
  FOR UPDATE;
  
  IF NOT FOUND THEN
    INSERT INTO user_cohort_payouts (user_id, cohort_id, lifetime_paid_total)
    VALUES (_account.user_id, _account.cohort_id, 0)
    ON CONFLICT (user_id, cohort_id) DO NOTHING
    RETURNING * INTO _cohort_payout;
    
    IF NOT FOUND THEN
      SELECT * INTO _cohort_payout
      FROM user_cohort_payouts
      WHERE user_id = _account.user_id AND cohort_id = _account.cohort_id
      FOR UPDATE;
    END IF;
  END IF;
  
  _lifetime_paid_total := COALESCE(_cohort_payout.lifetime_paid_total, 0);
  _paid_at := now();
  
  -- Final lifetime cap check (defense in depth) - per cohort
  IF _cohort.entry_fee IS NOT NULL AND _cohort.lifetime_cap_multiple IS NOT NULL THEN
    _lifetime_cap_amount := _cohort.entry_fee * _cohort.lifetime_cap_multiple;
    _lifetime_headroom := _lifetime_cap_amount - _lifetime_paid_total;
    
    IF _payout_amount > _lifetime_headroom THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'Payout amount exceeds lifetime cap headroom for this tier',
        'payout_amount', _payout_amount,
        'lifetime_headroom', _lifetime_headroom,
        'lifetime_cap_amount', _lifetime_cap_amount,
        'lifetime_paid_total', _lifetime_paid_total,
        'cohort_id', _account.cohort_id,
        'hint', 'Reduce payout amount or check tier settings'
      );
    END IF;
  END IF;
  
  -- Calculate new totals
  _new_lifetime_paid_total := _lifetime_paid_total + _payout_amount;
  
  -- Update payout status
  UPDATE payouts
  SET status = 'paid',
      paid_at = _paid_at,
      payment_reference = _payment_reference,
      reviewed_by = _reviewed_by,
      reviewed_at = _paid_at,
      updated_at = _paid_at
  WHERE id = _payout_id;
  
  -- Update per-cohort lifetime paid total
  UPDATE user_cohort_payouts
  SET lifetime_paid_total = _new_lifetime_paid_total,
      updated_at = now()
  WHERE user_id = _account.user_id AND cohort_id = _account.cohort_id;
  
  -- Update global lifetime paid total on profile
  UPDATE profiles
  SET lifetime_paid_total = lifetime_paid_total + _payout_amount,
      updated_at = now()
  WHERE user_id = _account.user_id;
  
  -- Reset payout cycle (high-water mark reset)
  UPDATE accounts
  SET payout_cycle_start_balance = _account.current_balance,
      payout_cycle_started_at = _paid_at,
      status = 'passed',
      updated_at = _paid_at
  WHERE id = _account.id;
  
  RETURN jsonb_build_object(
    'success', true,
    'payout', jsonb_build_object(
      'id', _payout_id,
      'account_id', _payout.account_id,
      'amount', _payout_amount,
      'status', 'paid',
      'paid_at', _paid_at,
      'payment_reference', _payment_reference
    ),
    'lifetime', jsonb_build_object(
      'previous_paid_total', _lifetime_paid_total,
      'new_paid_total', _new_lifetime_paid_total,
      'cohort_id', _account.cohort_id
    )
  );
END;
$function$;

-- 2) payment_system_state: Global kill-switch for inbound/outbound
-- =====================================================
CREATE TABLE IF NOT EXISTS public.payment_system_state (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  is_paused_inbound boolean NOT NULL DEFAULT false,
  is_paused_outbound boolean NOT NULL DEFAULT false,
  pause_reason text,
  paused_at timestamptz,
  paused_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Ensure only one row exists
INSERT INTO public.payment_system_state (id, is_paused_inbound, is_paused_outbound)
VALUES ('00000000-0000-0000-0000-000000000001', false, false)
ON CONFLICT (id) DO NOTHING;

-- RLS
ALTER TABLE public.payment_system_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can view payment state"
  ON public.payment_system_state FOR SELECT
  USING (has_any_role(auth.uid(), ARRAY['risk_officer'::app_role, 'support'::app_role, 'admin'::app_role]));

CREATE POLICY "Admins can update payment state"
  ON public.payment_system_state FOR UPDATE
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

-- No inserts/deletes (singleton row)
CREATE POLICY "No inserts on payment_system_state"
  ON public.payment_system_state FOR INSERT
  WITH CHECK (false);

CREATE POLICY "No deletes on payment_system_state"
  ON public.payment_system_state FOR DELETE
  USING (false);

-- 3) Kill-switch check function
-- =====================================================
CREATE OR REPLACE FUNCTION public.check_payment_system_paused(p_direction text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_state record;
BEGIN
  SELECT * INTO v_state FROM payment_system_state LIMIT 1;
  
  IF NOT FOUND THEN
    RETURN jsonb_build_object('paused', false);
  END IF;
  
  IF p_direction = 'inbound' AND v_state.is_paused_inbound THEN
    RETURN jsonb_build_object(
      'paused', true, 
      'reason', v_state.pause_reason,
      'paused_at', v_state.paused_at
    );
  END IF;
  
  IF p_direction = 'outbound' AND v_state.is_paused_outbound THEN
    RETURN jsonb_build_object(
      'paused', true, 
      'reason', v_state.pause_reason,
      'paused_at', v_state.paused_at
    );
  END IF;
  
  RETURN jsonb_build_object('paused', false);
END;
$$;

-- 4) Update select_payment_rail to check kill-switch
-- =====================================================
CREATE OR REPLACE FUNCTION public.select_payment_rail(
  p_direction text,
  p_amount numeric,
  p_country text,
  p_risk_tier int,
  p_method text,
  p_currency text DEFAULT 'USD'
)
RETURNS TABLE(rail_key text, provider text, priority int, reason text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pause_check jsonb;
BEGIN
  -- Check global kill-switch first
  v_pause_check := public.check_payment_system_paused(p_direction);
  
  IF (v_pause_check->>'paused')::boolean THEN
    RETURN QUERY SELECT 
      NULL::text as rail_key,
      NULL::text as provider,
      0 as priority,
      ('system_paused: ' || COALESCE(v_pause_check->>'reason', 'no reason given'))::text as reason;
    RETURN;
  END IF;

  -- Return matching rails sorted by priority
  RETURN QUERY
  SELECT 
    pr.rail_key,
    pr.provider,
    pr.priority,
    'eligible'::text as reason
  FROM payment_rails pr
  WHERE pr.is_enabled = true
    AND (
      (p_direction = 'inbound' AND pr.supports_inbound = true) OR
      (p_direction = 'outbound' AND pr.supports_outbound = true)
    )
    AND p_currency = ANY(pr.currencies)
    AND p_risk_tier = ANY(pr.allowed_risk_tiers)
    AND (
      array_length(pr.allowed_countries, 1) IS NULL 
      OR p_country = ANY(pr.allowed_countries)
    )
    AND NOT (p_country = ANY(pr.blocked_countries))
    AND p_method = ANY(pr.methods)
    AND (
      (p_direction = 'inbound' AND (pr.max_single_inbound IS NULL OR p_amount <= pr.max_single_inbound)) OR
      (p_direction = 'outbound' AND (pr.max_single_outbound IS NULL OR p_amount <= pr.max_single_outbound))
    )
  ORDER BY pr.priority ASC
  LIMIT 5;
END;
$$;

-- 5) Add audit hash columns for tamper-evidence
-- =====================================================
ALTER TABLE public.audit_logs
  ADD COLUMN IF NOT EXISTS prev_hash text,
  ADD COLUMN IF NOT EXISTS row_hash text;

-- 6) Audit hash computation trigger
-- =====================================================
CREATE OR REPLACE FUNCTION public.compute_audit_hash()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_prev_hash text;
  v_row_data text;
BEGIN
  -- Get the hash of the previous row (for chain integrity)
  SELECT row_hash INTO v_prev_hash
  FROM audit_logs
  WHERE created_at < NEW.created_at
  ORDER BY created_at DESC
  LIMIT 1;
  
  -- If no previous row, use a genesis hash
  IF v_prev_hash IS NULL THEN
    v_prev_hash := 'GENESIS_0000000000000000000000000000000000000000';
  END IF;
  
  NEW.prev_hash := v_prev_hash;
  
  -- Compute hash of stable fields + prev_hash
  v_row_data := concat_ws('|',
    NEW.id::text,
    NEW.user_id::text,
    NEW.account_id::text,
    NEW.action::text,
    NEW.details::text,
    NEW.reason,
    NEW.request_id::text,
    NEW.created_at::text,
    NEW.prev_hash
  );
  
  NEW.row_hash := encode(sha256(v_row_data::bytea), 'hex');
  
  RETURN NEW;
END;
$$;

-- Drop existing trigger if any
DROP TRIGGER IF EXISTS trg_compute_audit_hash ON public.audit_logs;

-- Create trigger
CREATE TRIGGER trg_compute_audit_hash
BEFORE INSERT ON public.audit_logs
FOR EACH ROW
EXECUTE FUNCTION public.compute_audit_hash();

-- 7) Audit chain verification function
-- =====================================================
CREATE OR REPLACE FUNCTION public.verify_audit_chain(
  _from_date timestamptz DEFAULT NULL,
  _to_date timestamptz DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row record;
  v_prev_hash text := 'GENESIS_0000000000000000000000000000000000000000';
  v_computed_hash text;
  v_row_data text;
  v_total_rows int := 0;
  v_verified_rows int := 0;
  v_broken_at uuid := NULL;
BEGIN
  FOR v_row IN 
    SELECT * FROM audit_logs 
    WHERE (_from_date IS NULL OR created_at >= _from_date)
      AND (_to_date IS NULL OR created_at <= _to_date)
    ORDER BY created_at ASC
  LOOP
    v_total_rows := v_total_rows + 1;
    
    -- Verify prev_hash matches expected
    IF v_row.prev_hash IS DISTINCT FROM v_prev_hash THEN
      v_broken_at := v_row.id;
      EXIT;
    END IF;
    
    -- Recompute hash
    v_row_data := concat_ws('|',
      v_row.id::text,
      v_row.user_id::text,
      v_row.account_id::text,
      v_row.action::text,
      v_row.details::text,
      v_row.reason,
      v_row.request_id::text,
      v_row.created_at::text,
      v_row.prev_hash
    );
    v_computed_hash := encode(sha256(v_row_data::bytea), 'hex');
    
    IF v_row.row_hash IS DISTINCT FROM v_computed_hash THEN
      v_broken_at := v_row.id;
      EXIT;
    END IF;
    
    v_verified_rows := v_verified_rows + 1;
    v_prev_hash := v_row.row_hash;
  END LOOP;
  
  RETURN jsonb_build_object(
    'verified', v_broken_at IS NULL,
    'total_rows', v_total_rows,
    'verified_rows', v_verified_rows,
    'broken_at_id', v_broken_at
  );
END;
$$;

-- Lock down verification to staff
REVOKE EXECUTE ON FUNCTION public.verify_audit_chain(timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.verify_audit_chain(timestamptz, timestamptz) TO authenticated;

-- 8) Add audit action for kill-switch
-- =====================================================
ALTER TYPE public.audit_action ADD VALUE IF NOT EXISTS 'payment_system_paused';
ALTER TYPE public.audit_action ADD VALUE IF NOT EXISTS 'payment_system_resumed';

-- 9) Kill-switch toggle function (admin only, via service_role)
-- =====================================================
CREATE OR REPLACE FUNCTION public.toggle_payment_system(
  _actor_user_id uuid,
  _direction text,  -- 'inbound' | 'outbound' | 'both'
  _pause boolean,
  _reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_is_admin boolean;
  v_request_id uuid := gen_random_uuid();
BEGIN
  -- Verify admin
  SELECT EXISTS (
    SELECT 1 FROM user_roles WHERE user_id = _actor_user_id AND role = 'admin'
  ) INTO v_is_admin;
  
  IF NOT v_is_admin THEN
    RETURN jsonb_build_object('success', false, 'error', 'admin_required');
  END IF;
  
  -- Update state
  UPDATE payment_system_state
  SET 
    is_paused_inbound = CASE 
      WHEN _direction IN ('inbound', 'both') THEN _pause 
      ELSE is_paused_inbound 
    END,
    is_paused_outbound = CASE 
      WHEN _direction IN ('outbound', 'both') THEN _pause 
      ELSE is_paused_outbound 
    END,
    pause_reason = CASE WHEN _pause THEN _reason ELSE NULL END,
    paused_at = CASE WHEN _pause THEN now() ELSE NULL END,
    paused_by = CASE WHEN _pause THEN _actor_user_id ELSE NULL END,
    updated_at = now()
  WHERE id = '00000000-0000-0000-0000-000000000001';
  
  -- Audit
  INSERT INTO audit_logs (user_id, action, details, reason, request_id)
  VALUES (
    _actor_user_id,
    CASE WHEN _pause THEN 'payment_system_paused' ELSE 'payment_system_resumed' END,
    jsonb_build_object(
      'actor_type', 'staff',
      'direction', _direction,
      'paused', _pause
    ),
    _reason,
    v_request_id
  );
  
  RETURN jsonb_build_object(
    'success', true,
    'direction', _direction,
    'paused', _pause,
    'request_id', v_request_id
  );
END;
$$;

-- Lock down
REVOKE EXECUTE ON FUNCTION public.toggle_payment_system(uuid, text, boolean, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.toggle_payment_system(uuid, text, boolean, text) TO service_role;

-- 10) Update validate_payout_request to check kill-switch
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
  v_pause_check jsonb;
BEGIN
  -- Check kill-switch first
  v_pause_check := public.check_payment_system_paused('outbound');
  IF (v_pause_check->>'paused')::boolean THEN
    RETURN jsonb_build_object(
      'valid', false, 
      'reason', 'system_paused',
      'pause_reason', v_pause_check->>'reason'
    );
  END IF;

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