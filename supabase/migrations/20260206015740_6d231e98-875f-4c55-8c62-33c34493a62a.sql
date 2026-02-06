-- Fix A3: Create canonical stringify function for hash consistency
CREATE OR REPLACE FUNCTION public.audit_row_canonical(
  _id uuid,
  _user_id uuid,
  _account_id uuid,
  _action text,
  _details jsonb,
  _created_at timestamptz,
  _request_id uuid,
  _reason text,
  _ip text,
  _ua text,
  _idempotency text,
  _prev_hash text
) RETURNS text
LANGUAGE sql IMMUTABLE
AS $$
  SELECT concat_ws('|',
    _id::text,
    coalesce(_user_id::text, ''),
    coalesce(_account_id::text, ''),
    coalesce(_action, ''),
    coalesce(_details::text, '{}'),
    _created_at::text,
    coalesce(_request_id::text, ''),
    coalesce(_reason, ''),
    coalesce(_ip, ''),
    coalesce(_ua, ''),
    coalesce(_idempotency, ''),
    coalesce(_prev_hash, 'GENESIS')
  );
$$;

-- Fix A1 & A3: Recreate trigger using canonical function and bytea cast
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
  -- Get the most recent row's hash using deterministic ordering
  SELECT row_hash INTO v_prev_hash
  FROM public.audit_logs
  ORDER BY created_at DESC, id DESC
  LIMIT 1;
  
  NEW.prev_hash := v_prev_hash;
  
  -- Use canonical function for consistent hashing
  v_row_data := public.audit_row_canonical(
    NEW.id,
    NEW.user_id,
    NEW.account_id,
    NEW.action::text,
    NEW.details,
    NEW.created_at,
    NEW.request_id,
    NEW.reason,
    NEW.ip_address,
    NEW.user_agent,
    NEW.idempotency_key,
    NEW.prev_hash
  );
  
  -- Fix A1: explicit bytea cast
  NEW.row_hash := encode(digest(v_row_data::bytea, 'sha256'), 'hex');
  
  RETURN NEW;
END;
$$;

-- Fix A2 & A3: Recreate verifier with correct advance logic
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
  v_prev_mismatch boolean;
  v_hash_mismatch boolean;
BEGIN
  FOR v_row IN
    SELECT *
    FROM public.audit_logs
    WHERE (_from_date IS NULL OR created_at >= _from_date)
      AND (_to_date IS NULL OR created_at <= _to_date)
    ORDER BY created_at ASC, id ASC
  LOOP
    v_rows_checked := v_rows_checked + 1;
    v_prev_mismatch := false;
    v_hash_mismatch := false;
    
    -- Check prev_hash continuity
    IF v_row.prev_hash IS DISTINCT FROM v_expected_prev_hash THEN
      v_prev_mismatch := true;
      v_breaks := v_breaks || jsonb_build_object(
        'id', v_row.id,
        'created_at', v_row.created_at,
        'issue', 'prev_hash_mismatch',
        'expected', v_expected_prev_hash,
        'actual', v_row.prev_hash
      );
    END IF;
    
    -- Recompute row_hash using canonical function
    v_row_data := public.audit_row_canonical(
      v_row.id,
      v_row.user_id,
      v_row.account_id,
      v_row.action::text,
      v_row.details,
      v_row.created_at,
      v_row.request_id,
      v_row.reason,
      v_row.ip_address,
      v_row.user_agent,
      v_row.idempotency_key,
      v_row.prev_hash
    );
    
    -- Fix A1: explicit bytea cast
    v_computed_hash := encode(digest(v_row_data::bytea, 'sha256'), 'hex');
    
    IF v_row.row_hash IS DISTINCT FROM v_computed_hash THEN
      v_hash_mismatch := true;
      v_breaks := v_breaks || jsonb_build_object(
        'id', v_row.id,
        'created_at', v_row.created_at,
        'issue', 'row_hash_mismatch',
        'expected', v_computed_hash,
        'actual', v_row.row_hash
      );
    END IF;
    
    -- Fix A2: Only advance expected hash if BOTH checks passed
    IF NOT v_prev_mismatch AND NOT v_hash_mismatch THEN
      v_expected_prev_hash := v_row.row_hash;
    END IF;
  END LOOP;
  
  RETURN jsonb_build_object(
    'valid', jsonb_array_length(v_breaks) = 0,
    'rows_checked', v_rows_checked,
    'breaks', v_breaks,
    'checked_at', now()
  );
END;
$$;

-- Fix C4: Add correct audit action for paid payouts
ALTER TYPE public.audit_action ADD VALUE IF NOT EXISTS 'payout_paid';

-- Fix C1-C4: Rewrite mark_payout_paid with timestamp capture and correct action
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
  _new_lifetime_total numeric;
  _request_id uuid := gen_random_uuid();
  _ts timestamptz := now();  -- Fix C1: capture once
  _pause_check jsonb;
  _jurisdiction_check jsonb;
BEGIN
  -- LOCK ORDER: payouts -> accounts -> user_cohort_payouts -> profiles
  
  -- Check kill-switch FIRST
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
  
  -- Fix C3: Compute new total once for clarity
  _new_lifetime_total := _ucp.lifetime_paid_total + _payout.amount;
  
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
  
  -- Update payout to paid (using captured timestamp)
  UPDATE public.payouts
  SET status = 'paid',
      paid_at = _ts,
      payment_reference = _payment_reference,
      reviewed_by = _reviewed_by,
      reviewed_at = _ts,
      request_id = _request_id
  WHERE id = _payout_id;
  
  -- Increment user_cohort_payouts
  UPDATE public.user_cohort_payouts
  SET lifetime_paid_total = _new_lifetime_total,
      updated_at = _ts
  WHERE user_id = _account.user_id AND cohort_id = _account.cohort_id;
  
  -- Mirror to profiles.lifetime_paid_total
  UPDATE public.profiles
  SET lifetime_paid_total = lifetime_paid_total + _payout.amount,
      updated_at = _ts
  WHERE user_id = _account.user_id;
  
  -- Reset payout cycle
  UPDATE public.accounts
  SET payout_cycle_start_balance = current_balance,
      payout_cycle_started_at = _ts,
      highest_balance = current_balance,
      updated_at = _ts
  WHERE id = _account.id;
  
  -- Fix C4: Correct audit action 'payout_paid' (not 'payout_approved')
  INSERT INTO public.audit_logs (user_id, account_id, action, details, request_id)
  VALUES (
    _account.user_id,
    _account.id,
    'payout_paid',
    jsonb_build_object(
      'payout_id', _payout_id,
      'amount', _payout.amount,
      'payment_reference', _payment_reference,
      'reviewed_by', _reviewed_by,
      'lifetime_paid_after', _new_lifetime_total,
      'selected_rail_key', _payout.selected_rail_key
    ),
    _request_id
  );
  
  -- Account event
  INSERT INTO public.account_events (account_id, event_type, event_data, request_id)
  VALUES (
    _account.id,
    'payout_paid',
    jsonb_build_object('payout_id', _payout_id, 'amount', _payout.amount, 'payment_reference', _payment_reference),
    _request_id
  );
  
  -- Fix C2: Return captured timestamp
  RETURN jsonb_build_object(
    'success', true,
    'payout_id', _payout_id,
    'amount', _payout.amount,
    'paid_at', _ts,
    'request_id', _request_id,
    'lifetime_paid_after', _new_lifetime_total
  );
END;
$$;