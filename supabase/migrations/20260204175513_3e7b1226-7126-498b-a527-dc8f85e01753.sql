-- Add first payout cap column to cohorts
ALTER TABLE public.cohorts 
ADD COLUMN first_payout_cap_amount numeric NULL;

-- Set default cap for existing cohorts ($300 as recommended by Monte Carlo analysis)
UPDATE public.cohorts 
SET first_payout_cap_amount = 300 
WHERE first_payout_cap_amount IS NULL;

COMMENT ON COLUMN public.cohorts.first_payout_cap_amount IS 
  'Maximum amount for the first payout in each cycle. NULL = no cap. Based on Monte Carlo sensitivity analysis showing $300 as optimal knee-of-curve for risk reduction.';

-- Update calculate_payout_eligibility to apply first payout cap
CREATE OR REPLACE FUNCTION public.calculate_payout_eligibility(_account_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _account record;
  _cohort record;
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
BEGIN
  SELECT a.*, c.*
  INTO _account
  FROM accounts a
  JOIN cohorts c ON a.cohort_id = c.id
  WHERE a.id = _account_id;
  
  IF NOT FOUND THEN
    RETURN jsonb_build_object('eligible', false, 'reason', 'Account not found');
  END IF;
  
  SELECT * INTO _cohort FROM cohorts WHERE id = _account.cohort_id;
  
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
    AND entity_id = _account_id::text 
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
  
  -- ============================================
  -- CYCLE-SAFE PROFIT CALCULATION
  -- ============================================
  
  _cycle_baseline := COALESCE(_account.payout_cycle_start_balance, _account.starting_balance);
  _cycle_started_at := COALESCE(_account.payout_cycle_started_at, _account.created_at);
  
  _realized_profit := _account.current_balance - _cycle_baseline;
  
  -- Count paid payouts since cycle start (for first payout cap logic)
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
  
  -- Split and caps
  _eligible_by_split := _realized_profit * (_cohort.payout_split_percent / 100.0);
  _max_eligible := _eligible_by_split * (_cohort.max_payout_percent / 100.0);
  
  IF _cohort.max_payout_absolute IS NOT NULL THEN
    _max_eligible := LEAST(_max_eligible, _cohort.max_payout_absolute);
  END IF;
  
  -- Store pre-cap amount for audit transparency
  _max_eligible_before_cap := _max_eligible;
  
  -- ============================================
  -- FIRST PAYOUT CAP (Monte Carlo validated)
  -- ============================================
  
  _is_first_payout_in_cycle := (_paid_count_since_cycle = 0);
  _first_payout_cap := _cohort.first_payout_cap_amount;
  
  -- Apply first payout cap if this is the first payout and cap is configured
  IF _is_first_payout_in_cycle AND _first_payout_cap IS NOT NULL THEN
    _max_eligible := LEAST(_max_eligible, _first_payout_cap);
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
    'payout_split_percent', _cohort.payout_split_percent,
    'max_payout_percent_of_eligible', _cohort.max_payout_percent,
    'max_payout_absolute', _cohort.max_payout_absolute,
    'account_status', _account.status,
    'days_since_last_payout', _days_since_last_payout,
    'trading_days_since_payout', _trading_days_since_payout
  );
END;
$function$;

-- Update validate_payout_request to use capped max_eligible_amount with clear messaging
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
  _account_status text;
  _pending_payout_count integer;
BEGIN
  SELECT status INTO _account_status FROM accounts WHERE id = _account_id;
  
  IF _account_status IS NULL THEN
    RETURN jsonb_build_object('eligible', false, 'reason', 'Account not found');
  END IF;
  
  IF _account_status NOT IN ('passed') THEN
    RETURN jsonb_build_object(
      'eligible', false,
      'reason', 'Account must be in passed status to request payout',
      'current_status', _account_status,
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
  
  SELECT COUNT(*) INTO _pending_payout_count
  FROM payouts
  WHERE account_id = _account_id AND status IN ('pending', 'under_review', 'approved');
  
  IF _pending_payout_count > 0 THEN
    RETURN jsonb_build_object(
      'eligible', false,
      'reason', 'An active payout request already exists for this account',
      'pending_payout_count', _pending_payout_count,
      'hint', 'Wait for current payout to be processed before requesting another'
    );
  END IF;
  
  _eligibility := calculate_payout_eligibility(_account_id);
  
  IF NOT (_eligibility->>'eligible')::boolean THEN
    RETURN _eligibility;
  END IF;
  
  _max_eligible := (_eligibility->>'max_eligible_amount')::numeric;
  _max_eligible_before_cap := (_eligibility->>'max_eligible_before_first_cap')::numeric;
  _first_payout_cap_applied := COALESCE((_eligibility->>'first_payout_cap_applied')::boolean, false);
  _first_payout_cap_amount := (_eligibility->>'first_payout_cap_amount')::numeric;
  
  IF _requested_amount > _max_eligible THEN
    RETURN jsonb_build_object(
      'eligible', false,
      'reason', CASE 
        WHEN _first_payout_cap_applied 
        THEN 'First payout cap applies: maximum $' || _first_payout_cap_amount || ' for first payout in cycle'
        ELSE 'Requested amount exceeds maximum eligible payout'
      END,
      'requested_amount', _requested_amount,
      'max_eligible_amount', _max_eligible,
      'max_eligible_before_first_cap', _max_eligible_before_cap,
      'first_payout_cap_applied', _first_payout_cap_applied,
      'first_payout_cap_amount', _first_payout_cap_amount,
      'hint', CASE 
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
      'minimum_amount', 50
    );
  END IF;
  
  RETURN jsonb_build_object(
    'eligible', true,
    'requested_amount', _requested_amount,
    'max_eligible_amount', _max_eligible,
    'max_eligible_before_first_cap', _max_eligible_before_cap,
    'first_payout_cap_applied', _first_payout_cap_applied,
    'first_payout_cap_amount', _first_payout_cap_amount,
    'is_first_payout_in_cycle', (_eligibility->>'is_first_payout_in_cycle')::boolean,
    'eligibility_details', _eligibility
  );
END;
$function$;