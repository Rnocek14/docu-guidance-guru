-- Fix #1: Clean up calculate_payout_eligibility to avoid field collisions
-- Fix #2: Add comment documenting profiles.lifetime_paid_total as reporting-only
-- Fix #3: Ensure functions have proper ownership for RLS bypass

-- Add comment to profiles.lifetime_paid_total documenting it's reporting-only
COMMENT ON COLUMN public.profiles.lifetime_paid_total IS 
  'REPORTING ONLY - Global lifetime paid total across all tiers. Do NOT use for cap enforcement. '
  'Cap enforcement uses user_cohort_payouts.lifetime_paid_total (per-tier). '
  'This column is maintained for backward compatibility and cross-tier reporting dashboards.';

-- Fix calculate_payout_eligibility: separate account and cohort fetches to avoid field collisions
CREATE OR REPLACE FUNCTION public.calculate_payout_eligibility(_account_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
  -- Lifetime cap variables (now per-cohort)
  _lifetime_cap_amount numeric;
  _lifetime_paid_total numeric;
  _lifetime_headroom numeric;
  _lifetime_cap_applied boolean := false;
BEGIN
  -- FIX #1: Separate fetches to avoid field collisions
  SELECT * INTO _account
  FROM accounts
  WHERE id = _account_id;
  
  IF NOT FOUND THEN
    RETURN jsonb_build_object('eligible', false, 'reason', 'Account not found');
  END IF;
  
  SELECT * INTO _cohort 
  FROM cohorts 
  WHERE id = _account.cohort_id;
  
  IF NOT FOUND THEN
    RETURN jsonb_build_object('eligible', false, 'reason', 'Cohort not found');
  END IF;
  
  -- Get per-cohort lifetime paid total (may not exist yet)
  SELECT * INTO _cohort_payout
  FROM user_cohort_payouts
  WHERE user_id = _account.user_id AND cohort_id = _account.cohort_id;
  
  _lifetime_paid_total := COALESCE(_cohort_payout.lifetime_paid_total, 0);
  
  IF _account.status NOT IN ('passed', 'payout_requested', 'payout_under_review', 'payout_approved') THEN
    RETURN jsonb_build_object(
      'eligible', false, 
      'reason', 'Account status must be passed or in payout flow',
      'current_status', _account.status
    );
  END IF;
  
  SELECT COUNT(*) INTO _pending_violations
  FROM violations WHERE account_id = _account_id AND confirmed_at IS NULL;
  
  IF _pending_violations > 0 THEN
    RETURN jsonb_build_object(
      'eligible', false, 
      'reason', 'Account has pending violations',
      'pending_violations', _pending_violations
    );
  END IF;
  
  SELECT COUNT(*) INTO _pending_flags
  FROM flags WHERE account_id = _account_id AND status = 'pending';
  
  IF _pending_flags > 0 THEN
    RETURN jsonb_build_object(
      'eligible', false, 
      'reason', 'Account has pending flags',
      'pending_flags', _pending_flags
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
      'pending_fraud_reviews', _pending_fraud_reviews
    );
  END IF;
  
  SELECT * INTO _last_payout
  FROM payouts
  WHERE account_id = _account_id AND status = 'paid'
  ORDER BY paid_at DESC LIMIT 1;
  
  IF _last_payout IS NOT NULL THEN
    _days_since_last_payout := (now()::date - _last_payout.paid_at::date);
    
    IF _days_since_last_payout < _cohort.payout_cooldown_days THEN
      RETURN jsonb_build_object(
        'eligible', false, 
        'reason', 'Payout cooldown period not met',
        'days_since_last_payout', _days_since_last_payout,
        'required_cooldown_days', _cohort.payout_cooldown_days,
        'days_remaining', _cohort.payout_cooldown_days - _days_since_last_payout
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
        'required_trading_days', _cohort.min_trading_days_between_payouts
      );
    END IF;
  END IF;
  
  -- Compute lifetime cap (entry_fee × lifetime_cap_multiple) - per cohort
  IF _cohort.entry_fee IS NOT NULL AND _cohort.lifetime_cap_multiple IS NOT NULL THEN
    _lifetime_cap_amount := _cohort.entry_fee * _cohort.lifetime_cap_multiple;
    _lifetime_headroom := _lifetime_cap_amount - _lifetime_paid_total;
    
    -- If headroom is below minimum payout threshold ($50), user is capped out for this tier
    IF _lifetime_headroom < 50 THEN
      RETURN jsonb_build_object(
        'eligible', false,
        'reason', 'Lifetime payout cap reached for this tier',
        'lifetime_paid_total', _lifetime_paid_total,
        'lifetime_cap_amount', _lifetime_cap_amount,
        'lifetime_headroom', GREATEST(_lifetime_headroom, 0),
        'cohort_id', _account.cohort_id,
        'hint', 'You have reached the maximum lifetime payout for this account tier.'
      );
    END IF;
  ELSE
    _lifetime_cap_amount := NULL;
    _lifetime_headroom := NULL;
  END IF;
  
  -- CYCLE-SAFE PROFIT CALCULATION
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
      'paid_since_cycle', _paid_since_cycle
    );
  END IF;
  
  _eligible_by_split := _realized_profit * (_cohort.payout_split_percent / 100.0);
  _max_eligible := _eligible_by_split * (_cohort.max_payout_percent / 100.0);
  
  IF _cohort.max_payout_absolute IS NOT NULL THEN
    _max_eligible := LEAST(_max_eligible, _cohort.max_payout_absolute);
  END IF;
  
  _max_eligible_before_cap := _max_eligible;
  
  -- FIRST PAYOUT CAP
  _is_first_payout_in_cycle := (_paid_count_since_cycle = 0);
  _first_payout_cap := _cohort.first_payout_cap_amount;
  
  IF _is_first_payout_in_cycle AND _first_payout_cap IS NOT NULL THEN
    _max_eligible := LEAST(_max_eligible, _first_payout_cap);
  END IF;
  
  -- LIFETIME CAP ENFORCEMENT (per-cohort)
  IF _lifetime_headroom IS NOT NULL AND _max_eligible > _lifetime_headroom THEN
    _max_eligible := _lifetime_headroom;
    _lifetime_cap_applied := true;
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
    'lifetime_headroom', GREATEST(_lifetime_headroom, 0),  -- FIX #4: Always clamp to 0
    'lifetime_cap_applied', _lifetime_cap_applied,
    'cohort_id', _account.cohort_id,
    'payout_split_percent', _cohort.payout_split_percent,
    'max_payout_percent_of_eligible', _cohort.max_payout_percent,
    'max_payout_absolute', _cohort.max_payout_absolute,
    'account_status', _account.status,
    'days_since_last_payout', _days_since_last_payout,
    'trading_days_since_payout', _trading_days_since_payout
  );
END;
$$;