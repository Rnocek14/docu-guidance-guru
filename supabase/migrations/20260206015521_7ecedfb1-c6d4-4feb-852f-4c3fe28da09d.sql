-- Fix #1: Enable pgcrypto for proper SHA256
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Fix #2 & #1: Recreate hash trigger with correct digest() and deterministic ordering
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
  -- Get the most recent row's hash using deterministic ordering (created_at, id)
  SELECT row_hash INTO v_prev_hash
  FROM public.audit_logs
  ORDER BY created_at DESC, id DESC
  LIMIT 1;
  
  -- Set prev_hash (NULL for first row)
  NEW.prev_hash := v_prev_hash;
  
  -- Compute row_hash using pgcrypto digest
  v_row_data := concat_ws('|',
    NEW.id::text,
    NEW.user_id::text,
    NEW.account_id::text,
    NEW.action::text,
    NEW.details::text,
    NEW.created_at::text,
    NEW.request_id::text,
    NEW.reason,
    NEW.ip_address,
    NEW.user_agent,
    NEW.idempotency_key,
    COALESCE(NEW.prev_hash, 'GENESIS')
  );
  
  NEW.row_hash := encode(digest(v_row_data, 'sha256'), 'hex');
  
  RETURN NEW;
END;
$$;

-- Fix #2 & #1: Recreate verify function with correct digest() and deterministic ordering
CREATE OR REPLACE FUNCTION public.verify_audit_chain(
  _from_date timestamptz DEFAULT NULL,
  _to_date timestamptz DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row record;
  v_expected_prev_hash text := NULL;
  v_computed_hash text;
  v_row_data text;
  v_rows_checked integer := 0;
  v_breaks jsonb := '[]'::jsonb;
BEGIN
  FOR v_row IN
    SELECT *
    FROM public.audit_logs
    WHERE (_from_date IS NULL OR created_at >= _from_date)
      AND (_to_date IS NULL OR created_at <= _to_date)
    ORDER BY created_at ASC, id ASC
  LOOP
    v_rows_checked := v_rows_checked + 1;
    
    -- Check prev_hash continuity
    IF v_row.prev_hash IS DISTINCT FROM v_expected_prev_hash THEN
      v_breaks := v_breaks || jsonb_build_object(
        'id', v_row.id,
        'created_at', v_row.created_at,
        'issue', 'prev_hash_mismatch',
        'expected', v_expected_prev_hash,
        'actual', v_row.prev_hash
      );
    END IF;
    
    -- Recompute row_hash
    v_row_data := concat_ws('|',
      v_row.id::text,
      v_row.user_id::text,
      v_row.account_id::text,
      v_row.action::text,
      v_row.details::text,
      v_row.created_at::text,
      v_row.request_id::text,
      v_row.reason,
      v_row.ip_address,
      v_row.user_agent,
      v_row.idempotency_key,
      COALESCE(v_row.prev_hash, 'GENESIS')
    );
    
    v_computed_hash := encode(digest(v_row_data, 'sha256'), 'hex');
    
    IF v_row.row_hash IS DISTINCT FROM v_computed_hash THEN
      v_breaks := v_breaks || jsonb_build_object(
        'id', v_row.id,
        'created_at', v_row.created_at,
        'issue', 'row_hash_mismatch',
        'expected', v_computed_hash,
        'actual', v_row.row_hash
      );
    END IF;
    
    v_expected_prev_hash := v_row.row_hash;
  END LOOP;
  
  RETURN jsonb_build_object(
    'valid', jsonb_array_length(v_breaks) = 0,
    'rows_checked', v_rows_checked,
    'breaks', v_breaks,
    'checked_at', now()
  );
END;
$$;

-- Fix #3: Lock verify_audit_chain to service_role only
REVOKE EXECUTE ON FUNCTION public.verify_audit_chain(timestamptz, timestamptz) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.verify_audit_chain(timestamptz, timestamptz) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.verify_audit_chain(timestamptz, timestamptz) FROM anon;
GRANT EXECUTE ON FUNCTION public.verify_audit_chain(timestamptz, timestamptz) TO service_role;

-- Fix #4: Update mark_payout_paid to check kill-switch at DB level
CREATE OR REPLACE FUNCTION public.mark_payout_paid(
  _payout_id uuid,
  _reviewed_by uuid,
  _payment_reference text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _payout public.payouts%rowtype;
  _account public.accounts%rowtype;
  _cohort public.cohorts%rowtype;
  _profile public.profiles%rowtype;
  _ucp public.user_cohort_payouts%rowtype;
  _lifetime_cap numeric;
  _headroom numeric;
  _request_id uuid := gen_random_uuid();
  _pause_check jsonb;
  _jurisdiction_check jsonb;
BEGIN
  -- LOCK ORDER: payouts -> accounts -> user_cohort_payouts -> profiles
  
  -- Fix #4: Check kill-switch FIRST
  _pause_check := public.check_payment_system_paused('outbound');
  IF COALESCE((_pause_check->>'paused')::boolean, false) THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'system_paused',
      'pause_reason', _pause_check->>'reason'
    );
  END IF;
  
  -- Lock payout row
  SELECT * INTO _payout
  FROM public.payouts
  WHERE id = _payout_id
  FOR UPDATE;
  
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'payout_not_found');
  END IF;
  
  -- Idempotency: already paid
  IF _payout.status = 'paid' THEN
    RETURN jsonb_build_object(
      'success', true,
      'duplicate', true,
      'paid_at', _payout.paid_at,
      'payment_reference', _payout.payment_reference
    );
  END IF;
  
  -- Must be approved to mark paid
  IF _payout.status != 'approved' THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_status', 'current_status', _payout.status);
  END IF;
  
  -- Lock account
  SELECT * INTO _account
  FROM public.accounts
  WHERE id = _payout.account_id
  FOR UPDATE;
  
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'account_not_found');
  END IF;
  
  -- Lock profile and check holds/freezes
  SELECT * INTO _profile
  FROM public.profiles
  WHERE user_id = _account.user_id
  FOR UPDATE;
  
  IF _profile.payouts_frozen THEN
    RETURN jsonb_build_object('success', false, 'error', 'payouts_frozen', 'reason', _profile.payouts_frozen_reason);
  END IF;
  
  IF _profile.payouts_hold THEN
    RETURN jsonb_build_object('success', false, 'error', 'payouts_on_hold', 'reason', _profile.payouts_hold_reason);
  END IF;
  
  -- Check jurisdiction allows payout_send
  _jurisdiction_check := public.assert_user_jurisdiction_allowed(_account.user_id, 'payout_send');
  IF NOT COALESCE((_jurisdiction_check->>'allowed')::boolean, false) THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'jurisdiction_blocked',
      'reason', _jurisdiction_check->>'reason',
      'country', _jurisdiction_check->>'country'
    );
  END IF;
  
  -- Get cohort for cap calculation
  SELECT * INTO _cohort
  FROM public.cohorts
  WHERE id = _account.cohort_id;
  
  -- Lock user_cohort_payouts
  SELECT * INTO _ucp
  FROM public.user_cohort_payouts
  WHERE user_id = _account.user_id AND cohort_id = _account.cohort_id
  FOR UPDATE;
  
  -- Create if not exists
  IF NOT FOUND THEN
    INSERT INTO public.user_cohort_payouts (user_id, cohort_id, lifetime_paid_total)
    VALUES (_account.user_id, _account.cohort_id, 0)
    RETURNING * INTO _ucp;
  END IF;
  
  -- Calculate lifetime cap and headroom
  IF _cohort.lifetime_cap_multiple IS NOT NULL AND _cohort.entry_fee IS NOT NULL THEN
    _lifetime_cap := _cohort.entry_fee * _cohort.lifetime_cap_multiple;
    _headroom := GREATEST(0, _lifetime_cap - _ucp.lifetime_paid_total);
    
    -- Final headroom check
    IF _payout.amount > _headroom THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'exceeds_lifetime_cap',
        'requested', _payout.amount,
        'headroom', _headroom,
        'lifetime_cap', _lifetime_cap
      );
    END IF;
  END IF;
  
  -- Final guard: amount cannot exceed calculated_eligible_amount
  IF _payout.calculated_eligible_amount IS NOT NULL AND _payout.amount > _payout.calculated_eligible_amount THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'amount_exceeds_eligible',
      'requested', _payout.amount,
      'eligible', _payout.calculated_eligible_amount
    );
  END IF;
  
  -- Update payout to paid
  UPDATE public.payouts
  SET status = 'paid',
      paid_at = now(),
      payment_reference = _payment_reference,
      reviewed_by = _reviewed_by,
      reviewed_at = now(),
      request_id = _request_id
  WHERE id = _payout_id;
  
  -- Increment user_cohort_payouts
  UPDATE public.user_cohort_payouts
  SET lifetime_paid_total = lifetime_paid_total + _payout.amount,
      updated_at = now()
  WHERE user_id = _account.user_id AND cohort_id = _account.cohort_id;
  
  -- Mirror to profiles.lifetime_paid_total
  UPDATE public.profiles
  SET lifetime_paid_total = lifetime_paid_total + _payout.amount,
      updated_at = now()
  WHERE user_id = _account.user_id;
  
  -- Reset payout cycle
  UPDATE public.accounts
  SET payout_cycle_start_balance = current_balance,
      payout_cycle_started_at = now(),
      highest_balance = current_balance,
      updated_at = now()
  WHERE id = _account.id;
  
  -- Audit log
  INSERT INTO public.audit_logs (user_id, account_id, action, details, request_id)
  VALUES (
    _account.user_id,
    _account.id,
    'payout_approved',
    jsonb_build_object(
      'payout_id', _payout_id,
      'amount', _payout.amount,
      'payment_reference', _payment_reference,
      'reviewed_by', _reviewed_by,
      'lifetime_paid_after', _ucp.lifetime_paid_total + _payout.amount
    ),
    _request_id
  );
  
  -- Account event
  INSERT INTO public.account_events (account_id, event_type, event_data, request_id)
  VALUES (
    _account.id,
    'payout_paid',
    jsonb_build_object('payout_id', _payout_id, 'amount', _payout.amount),
    _request_id
  );
  
  RETURN jsonb_build_object(
    'success', true,
    'payout_id', _payout_id,
    'amount', _payout.amount,
    'paid_at', now(),
    'request_id', _request_id
  );
END;
$$;