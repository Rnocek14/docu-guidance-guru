-- Fix remaining issues in payout RPCs:
-- 1. Add ownership enforcement (CRITICAL SECURITY)
-- 2. Fix cooldown timezone (same off-by-one bug)
-- 3. Ensure variable declarations are correct

CREATE OR REPLACE FUNCTION public.calculate_payout_eligibility(_account_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _account record;
  _cohort record;
  _cohort_payout record;
  _last_payout record;
  _pending_violations integer;
  _pending_flags integer;
  _pending_fraud_reviews integer;
  _trading_days_since_payout integer;
  _days_since_last_payout integer;
  _realized_profit numeric;
  _eligible_by_split numeric;
  _max_eligible numeric;
  _max_eligible_before_cap numeric;
  _cycle_baseline numeric;
  _cycle_started_at timestamptz;
  _paid_since_cycle numeric;
  _paid_count_since_cycle integer;
  _is_first_payout_in_cycle boolean;
  _first_payout_cap numeric;
  _lifetime_cap_amount numeric;
  _lifetime_paid_total numeric;
  _lifetime_headroom numeric;
  _lifetime_cap_applied boolean := false;
  _kyc_status text;
  -- Cooling period variables
  _has_prior_payout boolean;
  _days_since_pass integer;
  _cooling_period_days integer;
  _payout_window_opens_at date;
  _payout_window_opened boolean := true;
  -- Timezone-safe date variables
  _now_ny date;
  _passed_at_ny date;
  _paid_at_ny date;
BEGIN
  SELECT * INTO _account
  FROM accounts
  WHERE id = _account_id;
  
  IF NOT FOUND THEN
    RETURN jsonb_build_object('eligible', false, 'reason', 'Account not found', 'payout_window_opened', false);
  END IF;

  -- SECURITY: Ownership enforcement (non-negotiable for SECURITY DEFINER)
  IF _account.user_id <> auth.uid() THEN
    RETURN jsonb_build_object(
      'eligible', false,
      'reason', 'Unauthorized',
      'payout_window_opened', false
    );
  END IF;

  -- KYC GATE
  SELECT kyc_status INTO _kyc_status
  FROM public.profiles
  WHERE user_id = _account.user_id;

  IF COALESCE(_kyc_status, 'pending') NOT IN ('verified') THEN
    RETURN jsonb_build_object(
      'eligible', false,
      'reason', 'KYC verification required before payout',
      'kyc_status', COALESCE(_kyc_status, 'pending'),
      'hint', 'Complete identity verification to unlock payouts',
      'payout_window_opened', false
    );
  END IF;
  
  SELECT * INTO _cohort 
  FROM cohorts 
  WHERE id = _account.cohort_id;
  
  IF NOT FOUND THEN
    RETURN jsonb_build_object('eligible', false, 'reason', 'Cohort not found', 'payout_window_opened', false);
  END IF;
  
  SELECT * INTO _cohort_payout
  FROM user_cohort_payouts
  WHERE user_id = _account.user_id AND cohort_id = _account.cohort_id;
  
  _lifetime_paid_total := COALESCE(_cohort_payout.lifetime_paid_total, 0);
  
  IF _account.status NOT IN ('passed', 'payout_requested', 'payout_under_review', 'payout_approved') THEN
    RETURN jsonb_build_object(
      'eligible', false, 
      'reason', 'Account status must be passed or in payout flow',
      'current_status', _account.status,
      'payout_window_opened', false
    );
  END IF;
  
  SELECT COUNT(*) INTO _pending_violations
  FROM violations WHERE account_id = _account_id AND confirmed_at IS NULL;
  
  IF _pending_violations > 0 THEN
    RETURN jsonb_build_object(
      'eligible', false, 
      'reason', 'Account has pending violations',
      'pending_violations', _pending_violations,
      'payout_window_opened', true
    );
  END IF;
  
  SELECT COUNT(*) INTO _pending_flags
  FROM flags WHERE account_id = _account_id AND status = 'pending';
  
  IF _pending_flags > 0 THEN
    RETURN jsonb_build_object(
      'eligible', false, 
      'reason', 'Account has pending flags',
      'pending_flags', _pending_flags,
      'payout_window_opened', true
    );
  END IF;
  
  SELECT COUNT(*) INTO _pending_fraud_reviews
  FROM fraud_reviews
  WHERE entity_type = 'account' 
    AND entity_id = _account_id
    AND status IN ('pending', 'in_review');
  
  IF _pending_fraud_reviews > 0 THEN
    RETURN jsonb_build_object(
      'eligible', false, 
      'reason', 'Account has pending fraud review',
      'pending_fraud_reviews', _pending_fraud_reviews,
      'payout_window_opened', true
    );
  END IF;
  
  -- COOLING PERIOD CHECK (timezone-safe)
  SELECT EXISTS(
    SELECT 1 FROM payouts 
    WHERE account_id = _account_id AND status = 'paid'
  ) INTO _has_prior_payout;
  
  _cooling_period_days := COALESCE(_cohort.payout_eligibility_delay_days, 7);
  
  -- Timezone-safe date math using America/New_York
  IF NOT _has_prior_payout AND _account.passed_at IS NOT NULL THEN
    _now_ny := (now() AT TIME ZONE 'America/New_York')::date;
    _passed_at_ny := (_account.passed_at AT TIME ZONE 'America/New_York')::date;
    _days_since_pass := (_now_ny - _passed_at_ny);
    _payout_window_opens_at := (_passed_at_ny + _cooling_period_days);
    
    IF _days_since_pass < _cooling_period_days THEN
      _payout_window_opened := false;
      RETURN jsonb_build_object(
        'eligible', false,
        'reason', 'Payout window not yet open',
        'payout_window_opened', false,
        'cooling_period_days', _cooling_period_days,
        'days_since_pass', _days_since_pass,
        'days_remaining', _cooling_period_days - _days_since_pass,
        'payout_window_opens_at', _payout_window_opens_at,
        'passed_at', _account.passed_at,
        'has_prior_payout', false,
        'hint', 'Your payout window opens on ' || to_char(_payout_window_opens_at, 'Mon DD, YYYY')
      );
    END IF;
  END IF;
  
  SELECT * INTO _last_payout
  FROM payouts
  WHERE account_id = _account_id AND status = 'paid'
  ORDER BY paid_at DESC LIMIT 1;
  
  IF _last_payout IS NOT NULL THEN
    -- FIX: Timezone-safe cooldown calculation (same as cooling)
    _now_ny := (now() AT TIME ZONE 'America/New_York')::date;
    _paid_at_ny := (_last_payout.paid_at AT TIME ZONE 'America/New_York')::date;
    _days_since_last_payout := (_now_ny - _paid_at_ny);
    
    IF _days_since_last_payout < _cohort.payout_cooldown_days THEN
      RETURN jsonb_build_object(
        'eligible', false, 
        'reason', 'Payout cooldown period not met',
        'days_since_last_payout', _days_since_last_payout,
        'required_cooldown_days', _cohort.payout_cooldown_days,
        'days_remaining', _cohort.payout_cooldown_days - _days_since_last_payout,
        'payout_window_opened', true
      );
    END IF;
    
    SELECT COUNT(DISTINCT (
      (COALESCE(closed_at, opened_at) AT TIME ZONE 'America/New_York' - interval '17 hours')::date
    )) INTO _trading_days_since_payout
    FROM trades
    WHERE account_id = _account_id 
      AND COALESCE(closed_at, opened_at) > _last_payout.paid_at;
    
    IF _trading_days_since_payout < _cohort.min_trading_days_between_payouts THEN
      RETURN jsonb_build_object(
        'eligible', false, 
        'reason', 'Not enough trading days since last payout',
        'trading_days_since_payout', _trading_days_since_payout,
        'required_trading_days', _cohort.min_trading_days_between_payouts,
        'payout_window_opened', true
      );
    END IF;
  END IF;
  
  IF _cohort.entry_fee IS NOT NULL AND _cohort.lifetime_cap_multiple IS NOT NULL THEN
    _lifetime_cap_amount := _cohort.entry_fee * _cohort.lifetime_cap_multiple;
    _lifetime_headroom := _lifetime_cap_amount - _lifetime_paid_total;
    
    IF _lifetime_headroom < 50 THEN
      RETURN jsonb_build_object(
        'eligible', false,
        'reason', 'Lifetime payout cap reached for this tier',
        'lifetime_paid_total', _lifetime_paid_total,
        'lifetime_cap_amount', _lifetime_cap_amount,
        'lifetime_headroom', GREATEST(_lifetime_headroom, 0),
        'cohort_id', _account.cohort_id,
        'hint', 'You have reached the maximum lifetime payout for this account tier.',
        'payout_window_opened', true
      );
    END IF;
  ELSE
    _lifetime_cap_amount := NULL;
    _lifetime_headroom := NULL;
  END IF;
  
  _cycle_baseline := COALESCE(_account.payout_cycle_start_balance, _account.starting_balance);
  _cycle_started_at := COALESCE(_account.payout_cycle_started_at, _account.created_at);
  
  _realized_profit := _account.current_balance - _cycle_baseline;
  
  SELECT 
    COALESCE(SUM(amount), 0),
    COUNT(*)
  INTO _paid_since_cycle, _paid_count_since_cycle
  FROM payouts
  WHERE account_id = _account_id
    AND status = 'paid'
    AND paid_at >= _cycle_started_at;
  
  _realized_profit := _realized_profit - _paid_since_cycle;
  
  IF _realized_profit <= 0 THEN
    RETURN jsonb_build_object(
      'eligible', false, 
      'reason', 'No realized profit available for payout',
      'realized_profit', _realized_profit,
      'cycle_baseline', _cycle_baseline,
      'cycle_started_at', _cycle_started_at,
      'paid_since_cycle', _paid_since_cycle,
      'payout_window_opened', true
    );
  END IF;
  
  _eligible_by_split := _realized_profit * (_cohort.payout_split_percent / 100.0);
  _max_eligible := _eligible_by_split * (_cohort.max_payout_percent / 100.0);
  
  IF _cohort.max_payout_absolute IS NOT NULL THEN
    _max_eligible := LEAST(_max_eligible, _cohort.max_payout_absolute);
  END IF;
  
  _max_eligible_before_cap := _max_eligible;
  
  _is_first_payout_in_cycle := (_paid_count_since_cycle = 0);
  _first_payout_cap := _cohort.first_payout_cap_amount;
  
  IF _is_first_payout_in_cycle AND _first_payout_cap IS NOT NULL THEN
    _max_eligible := LEAST(_max_eligible, _first_payout_cap);
  END IF;
  
  IF _lifetime_headroom IS NOT NULL AND _max_eligible > _lifetime_headroom THEN
    _max_eligible := _lifetime_headroom;
    _lifetime_cap_applied := true;
  END IF;
  
  -- Compute days_since_pass for transparency (timezone-safe)
  IF _account.passed_at IS NOT NULL THEN
    _now_ny := (now() AT TIME ZONE 'America/New_York')::date;
    _passed_at_ny := (_account.passed_at AT TIME ZONE 'America/New_York')::date;
    _days_since_pass := (_now_ny - _passed_at_ny);
    _payout_window_opens_at := (_passed_at_ny + _cooling_period_days);
  END IF;
  
  RETURN jsonb_build_object(
    'eligible', true,
    'max_eligible_amount', ROUND(_max_eligible, 2),
    'max_eligible_before_first_cap', ROUND(_max_eligible_before_cap, 2),
    'total_eligible_by_split', ROUND(_eligible_by_split, 2),
    'realized_profit', ROUND(_realized_profit, 2),
    'cycle_baseline', _cycle_baseline,
    'cycle_started_at', _cycle_started_at,
    'paid_since_cycle', _paid_since_cycle,
    'paid_count_since_cycle', _paid_count_since_cycle,
    'is_first_payout_in_cycle', _is_first_payout_in_cycle,
    'first_payout_cap_amount', _first_payout_cap,
    'first_payout_cap_applied', (_is_first_payout_in_cycle AND _first_payout_cap IS NOT NULL AND _max_eligible_before_cap > _first_payout_cap),
    'lifetime_cap_amount', _lifetime_cap_amount,
    'lifetime_paid_total', _lifetime_paid_total,
    'lifetime_headroom', GREATEST(_lifetime_headroom, 0),
    'lifetime_cap_applied', _lifetime_cap_applied,
    'cohort_id', _account.cohort_id,
    'payout_split_percent', _cohort.payout_split_percent,
    'max_payout_percent_of_eligible', _cohort.max_payout_percent,
    'max_payout_absolute', _cohort.max_payout_absolute,
    'account_status', _account.status,
    'days_since_last_payout', _days_since_last_payout,
    'trading_days_since_payout', _trading_days_since_payout,
    'kyc_status', _kyc_status,
    'payout_window_opened', true,
    'cooling_period_days', _cooling_period_days,
    'days_since_pass', _days_since_pass,
    'payout_window_opens_at', _payout_window_opens_at,
    'has_prior_payout', _has_prior_payout
  );
END;
$function$;

-- Also fix validate_payout_request with ownership check
CREATE OR REPLACE FUNCTION public.validate_payout_request(_account_id uuid, _requested_amount numeric)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _eligibility jsonb;
  _max_eligible numeric;
  _max_eligible_before_cap numeric;
  _first_payout_cap_applied boolean;
  _first_payout_cap_amount numeric;
  _lifetime_cap_applied boolean;
  _lifetime_cap_amount numeric;
  _lifetime_headroom numeric;
  _account_status text;
  _pending_payout_count integer;
  _recent_request_count integer;
  _payout_window_opened boolean;
  _account record;
BEGIN
  SELECT * INTO _account FROM accounts WHERE id = _account_id;
  _account_status := _account.status;
  
  IF _account_status IS NULL THEN
    RETURN jsonb_build_object('eligible', false, 'reason', 'Account not found', 'payout_window_opened', false);
  END IF;

  -- SECURITY: Ownership enforcement (non-negotiable for SECURITY DEFINER)
  IF _account.user_id <> auth.uid() THEN
    RETURN jsonb_build_object(
      'eligible', false,
      'reason', 'Unauthorized',
      'payout_window_opened', false
    );
  END IF;
  
  IF _account_status NOT IN ('passed') THEN
    RETURN jsonb_build_object(
      'eligible', false,
      'reason', 'Account must be in passed status to request payout',
      'current_status', _account_status,
      'payout_window_opened', false,
      'hint', CASE 
        WHEN _account_status IN ('payout_requested', 'payout_under_review', 'payout_approved') 
          THEN 'Account already has an active payout request'
        WHEN _account_status IN ('active', 'breached_detected', 'under_review')
          THEN 'Account must pass evaluation before requesting payout'
        WHEN _account_status IN ('failed_confirmed', 'closed')
          THEN 'Account is not eligible for payouts'
        ELSE 'Invalid account status for payout request'
      END
    );
  END IF;
  
  -- Velocity limit
  SELECT COUNT(*) INTO _recent_request_count
  FROM payouts
  WHERE account_id = _account_id
    AND status IN ('pending', 'under_review', 'approved')
    AND COALESCE(requested_at, now()) >= now() - interval '24 hours';

  IF _recent_request_count >= 3 THEN
    RETURN jsonb_build_object(
      'eligible', false,
      'reason', 'Too many payout requests in the last 24 hours',
      'recent_request_count', _recent_request_count,
      'max_requests_per_day', 3,
      'payout_window_opened', true,
      'hint', 'Please wait before submitting another payout request'
    );
  END IF;
  
  SELECT COUNT(*) INTO _pending_payout_count
  FROM payouts
  WHERE account_id = _account_id AND status IN ('pending', 'under_review', 'approved');
  
  IF _pending_payout_count > 0 THEN
    RETURN jsonb_build_object(
      'eligible', false,
      'reason', 'An active payout request already exists for this account',
      'pending_payout_count', _pending_payout_count,
      'payout_window_opened', true,
      'hint', 'Wait for current payout to be processed before requesting another'
    );
  END IF;
  
  _eligibility := calculate_payout_eligibility(_account_id);
  
  IF NOT (_eligibility->>'eligible')::boolean THEN
    -- Safe audit logging (wrapped in exception handler)
    _payout_window_opened := COALESCE((_eligibility->>'payout_window_opened')::boolean, true);
    
    IF NOT _payout_window_opened THEN
      -- Log cooling denial - wrapped so failure doesn't break the function
      BEGIN
        INSERT INTO audit_logs (
          user_id,
          account_id,
          action,
          details,
          reason
        ) VALUES (
          _account.user_id,
          _account_id,
          'payout_requested',
          jsonb_build_object(
            'blocked_reason', 'cooling_period',
            'days_remaining', _eligibility->>'days_remaining',
            'cooling_period_days', _eligibility->>'cooling_period_days',
            'payout_window_opens_at', _eligibility->>'payout_window_opens_at',
            'requested_amount', _requested_amount
          ),
          'Payout request blocked: cooling period not complete'
        );
      EXCEPTION WHEN OTHERS THEN
        -- Logging must never block core flows - silently continue
        NULL;
      END;
    END IF;
    
    RETURN _eligibility;
  END IF;
  
  -- Server-side hard stop returns JSON instead of RAISE EXCEPTION
  _payout_window_opened := COALESCE((_eligibility->>'payout_window_opened')::boolean, true);
  
  IF NOT _payout_window_opened THEN
    -- Defense in depth: return clean JSON denial instead of exception
    RETURN jsonb_build_object(
      'eligible', false,
      'reason', 'Payout window not yet open',
      'payout_window_opened', false,
      'eligibility_details', _eligibility
    );
  END IF;
  
  _max_eligible := (_eligibility->>'max_eligible_amount')::numeric;
  _max_eligible_before_cap := (_eligibility->>'max_eligible_before_first_cap')::numeric;
  _first_payout_cap_applied := COALESCE((_eligibility->>'first_payout_cap_applied')::boolean, false);
  _lifetime_cap_applied := COALESCE((_eligibility->>'lifetime_cap_applied')::boolean, false);
  
  _first_payout_cap_amount := CASE
    WHEN (_eligibility ? 'first_payout_cap_amount')
     AND (_eligibility->>'first_payout_cap_amount') IS NOT NULL
     AND (_eligibility->>'first_payout_cap_amount') NOT IN ('', 'null')
    THEN (_eligibility->>'first_payout_cap_amount')::numeric
    ELSE NULL
  END;
  
  _lifetime_cap_amount := CASE
    WHEN (_eligibility ? 'lifetime_cap_amount')
     AND (_eligibility->>'lifetime_cap_amount') IS NOT NULL
     AND (_eligibility->>'lifetime_cap_amount') NOT IN ('', 'null')
    THEN (_eligibility->>'lifetime_cap_amount')::numeric
    ELSE NULL
  END;
  
  _lifetime_headroom := CASE
    WHEN (_eligibility ? 'lifetime_headroom')
     AND (_eligibility->>'lifetime_headroom') IS NOT NULL
     AND (_eligibility->>'lifetime_headroom') NOT IN ('', 'null')
    THEN (_eligibility->>'lifetime_headroom')::numeric
    ELSE NULL
  END;
  
  IF _requested_amount > _max_eligible THEN
    RETURN jsonb_build_object(
      'eligible', false,
      'reason', CASE 
        WHEN _lifetime_cap_applied
        THEN 'Lifetime payout cap applies for this tier: maximum $' || ROUND(_lifetime_headroom, 2) || ' remaining'
        WHEN _first_payout_cap_applied 
        THEN 'First payout cap applies: maximum $' || _first_payout_cap_amount || ' for first payout in cycle'
        ELSE 'Requested amount exceeds maximum eligible payout'
      END,
      'requested_amount', _requested_amount,
      'max_eligible_amount', _max_eligible,
      'max_eligible_before_first_cap', _max_eligible_before_cap,
      'first_payout_cap_applied', _first_payout_cap_applied,
      'first_payout_cap_amount', _first_payout_cap_amount,
      'lifetime_cap_applied', _lifetime_cap_applied,
      'lifetime_cap_amount', _lifetime_cap_amount,
      'lifetime_headroom', _lifetime_headroom,
      'payout_window_opened', true,
      'hint', CASE 
        WHEN _lifetime_cap_applied
        THEN 'You are approaching or have reached your lifetime payout cap for this tier.'
        WHEN _first_payout_cap_applied 
        THEN 'Your first payout each cycle is capped. Subsequent payouts in this cycle are not capped.'
        ELSE NULL
      END
    );
  END IF;
  
  IF _requested_amount < 50 THEN
    RETURN jsonb_build_object(
      'eligible', false,
      'reason', 'Minimum payout amount is $50',
      'requested_amount', _requested_amount,
      'minimum_amount', 50,
      'payout_window_opened', true
    );
  END IF;
  
  RETURN jsonb_build_object(
    'eligible', true,
    'requested_amount', _requested_amount,
    'max_eligible_amount', _max_eligible,
    'max_eligible_before_first_cap', _max_eligible_before_cap,
    'first_payout_cap_applied', _first_payout_cap_applied,
    'first_payout_cap_amount', _first_payout_cap_amount,
    'lifetime_cap_applied', _lifetime_cap_applied,
    'lifetime_cap_amount', _lifetime_cap_amount,
    'lifetime_headroom', _lifetime_headroom,
    'is_first_payout_in_cycle', (_eligibility->>'is_first_payout_in_cycle')::boolean,
    'payout_window_opened', true,
    'eligibility_details', _eligibility
  );
END;
$function$;