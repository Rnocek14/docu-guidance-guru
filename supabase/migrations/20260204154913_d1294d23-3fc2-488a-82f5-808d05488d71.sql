-- Fix 1: Correct cooldown day calculation + trading day boundary
-- Fix 2: Correct correlation detection with CTE + add same-side detection
-- Fix 3: Add bump_fingerprint_seen function for atomic increment

-- ============================================
-- FIX: calculate_payout_eligibility
-- ============================================
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
  _result jsonb;
BEGIN
  -- Get account with cohort
  SELECT a.*, c.*
  INTO _account
  FROM accounts a
  JOIN cohorts c ON a.cohort_id = c.id
  WHERE a.id = _account_id;
  
  IF NOT FOUND THEN
    RETURN jsonb_build_object('eligible', false, 'reason', 'Account not found');
  END IF;
  
  -- Get cohort separately for clarity
  SELECT * INTO _cohort FROM cohorts WHERE id = _account.cohort_id;
  
  -- Check account status
  IF _account.status NOT IN ('passed', 'payout_requested', 'payout_under_review', 'payout_approved') THEN
    RETURN jsonb_build_object(
      'eligible', false, 
      'reason', 'Account status must be passed or in payout flow',
      'current_status', _account.status
    );
  END IF;
  
  -- Check for pending violations
  SELECT COUNT(*) INTO _pending_violations
  FROM violations
  WHERE account_id = _account_id AND confirmed_at IS NULL;
  
  IF _pending_violations > 0 THEN
    RETURN jsonb_build_object(
      'eligible', false, 
      'reason', 'Account has pending violations',
      'pending_violations', _pending_violations
    );
  END IF;
  
  -- Check for pending flags
  SELECT COUNT(*) INTO _pending_flags
  FROM flags
  WHERE account_id = _account_id AND status = 'pending';
  
  IF _pending_flags > 0 THEN
    RETURN jsonb_build_object(
      'eligible', false, 
      'reason', 'Account has pending flags',
      'pending_flags', _pending_flags
    );
  END IF;
  
  -- Check for pending fraud reviews
  SELECT COUNT(*) INTO _pending_fraud_reviews
  FROM fraud_reviews
  WHERE entity_type = 'account' AND entity_id = _account_id::text AND status IN ('pending', 'in_review');
  
  IF _pending_fraud_reviews > 0 THEN
    RETURN jsonb_build_object(
      'eligible', false, 
      'reason', 'Account has pending fraud review',
      'pending_fraud_reviews', _pending_fraud_reviews
    );
  END IF;
  
  -- Get last paid payout
  SELECT * INTO _last_payout
  FROM payouts
  WHERE account_id = _account_id AND status = 'paid'
  ORDER BY paid_at DESC
  LIMIT 1;
  
  -- Check cooldown period using correct date arithmetic
  IF _last_payout IS NOT NULL THEN
    -- FIX: Use date subtraction for accurate day count across months
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
    
    -- FIX: Calculate trading days using 5pm ET (CME close) boundary
    -- Subtract 17 hours so 5pm ET becomes the "start" of the next trading day
    SELECT COUNT(DISTINCT (
      (opened_at AT TIME ZONE 'America/New_York' - interval '17 hours')::date
    )) INTO _trading_days_since_payout
    FROM trades
    WHERE account_id = _account_id 
      AND opened_at > _last_payout.paid_at
      AND status = 'closed';
    
    IF _trading_days_since_payout < _cohort.min_trading_days_between_payouts THEN
      RETURN jsonb_build_object(
        'eligible', false, 
        'reason', 'Not enough trading days since last payout',
        'trading_days_since_payout', _trading_days_since_payout,
        'required_trading_days', _cohort.min_trading_days_between_payouts
      );
    END IF;
  END IF;
  
  -- Calculate realized profit from balance (TODO: migrate to ledger-based calculation)
  -- Note: current_balance is authoritative; not reduced when payouts are marked paid
  -- Future: sum(trades.pnl WHERE status='closed') - sum(payouts WHERE status='paid')
  _realized_profit := _account.current_balance - _account.starting_balance;
  
  -- Subtract already paid amounts
  SELECT COALESCE(SUM(amount), 0) INTO _max_eligible
  FROM payouts
  WHERE account_id = _account_id AND status = 'paid';
  
  _realized_profit := _realized_profit - _max_eligible;
  
  IF _realized_profit <= 0 THEN
    RETURN jsonb_build_object(
      'eligible', false, 
      'reason', 'No realized profit available for payout',
      'realized_profit', _realized_profit
    );
  END IF;
  
  -- FIX: Clarify split vs cap semantics
  -- payout_split_percent: overall share trader can withdraw (e.g., 80% of profits)
  -- max_payout_percent: per-request cap as % of eligible amount (e.g., 50% per request)
  _eligible_by_split := _realized_profit * (_cohort.payout_split_percent / 100.0);
  
  -- Apply per-request percentage cap (% of eligible, not % of profit)
  _max_eligible := _eligible_by_split * (_cohort.max_payout_percent / 100.0);
  
  -- Apply absolute cap if set
  IF _cohort.max_payout_absolute IS NOT NULL THEN
    _max_eligible := LEAST(_max_eligible, _cohort.max_payout_absolute);
  END IF;
  
  RETURN jsonb_build_object(
    'eligible', true,
    'max_eligible_amount', ROUND(_max_eligible, 2),
    'total_eligible_by_split', ROUND(_eligible_by_split, 2),
    'realized_profit', ROUND(_realized_profit, 2),
    'payout_split_percent', _cohort.payout_split_percent,
    'max_payout_percent', _cohort.max_payout_percent,
    'max_payout_absolute', _cohort.max_payout_absolute,
    'account_status', _account.status,
    'days_since_last_payout', _days_since_last_payout,
    'trading_days_since_payout', _trading_days_since_payout
  );
END;
$function$;

-- ============================================
-- FIX: detect_trade_correlations with CTE + same-side detection
-- ============================================
CREATE OR REPLACE FUNCTION public.detect_trade_correlations(
  _account_id uuid,
  _time_window_seconds integer DEFAULT 60,
  _min_match_count integer DEFAULT 3
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _correlations jsonb := '[]'::jsonb;
  _correlation record;
  _account_user_id uuid;
BEGIN
  -- Get the account's user_id
  SELECT user_id INTO _account_user_id FROM accounts WHERE id = _account_id;
  
  IF _account_user_id IS NULL THEN
    RETURN jsonb_build_object(
      'has_correlations', false,
      'correlation_count', 0,
      'correlations', '[]'::jsonb,
      'error', 'Account not found'
    );
  END IF;
  
  -- FIX: Use CTE for proper aggregation with ORDER BY
  -- Detect OPPOSITE-SIDE trades (hedging/arbitrage between accounts)
  FOR _correlation IN
    WITH opposite_matches AS (
      SELECT
        t2.account_id AS other_account_id,
        a2.account_number AS other_account_number,
        a2.user_id AS other_user_id,
        t1.symbol,
        t1.side AS our_side,
        t2.side AS their_side,
        t1.opened_at AS our_time,
        t2.opened_at AS their_time,
        ABS(EXTRACT(EPOCH FROM (t2.opened_at - t1.opened_at))) AS time_diff_seconds
      FROM trades t1
      JOIN trades t2 ON t1.symbol = t2.symbol
        AND t1.side != t2.side
        AND t1.account_id != t2.account_id
        AND ABS(EXTRACT(EPOCH FROM (t2.opened_at - t1.opened_at))) <= _time_window_seconds
      JOIN accounts a2 ON t2.account_id = a2.id
      WHERE t1.account_id = _account_id
        AND a2.user_id != _account_user_id
    ),
    ranked_matches AS (
      SELECT *,
        ROW_NUMBER() OVER (PARTITION BY other_account_id ORDER BY our_time DESC) as rn
      FROM opposite_matches
    )
    SELECT
      other_account_id,
      other_account_number,
      COUNT(*) AS match_count,
      'opposite_side' AS correlation_type,
      jsonb_agg(
        jsonb_build_object(
          'symbol', symbol,
          'our_side', our_side,
          'their_side', their_side,
          'our_time', our_time,
          'their_time', their_time,
          'time_diff_seconds', time_diff_seconds
        ) ORDER BY our_time DESC
      ) FILTER (WHERE rn <= 10) AS sample_trades
    FROM ranked_matches
    GROUP BY other_account_id, other_account_number
    HAVING COUNT(*) >= _min_match_count
  LOOP
    _correlations := _correlations || jsonb_build_object(
      'other_account_id', _correlation.other_account_id,
      'other_account_number', _correlation.other_account_number,
      'match_count', _correlation.match_count,
      'correlation_type', _correlation.correlation_type,
      'sample_trades', _correlation.sample_trades
    );
  END LOOP;
  
  -- FIX: Also detect SAME-SIDE trades (copy trading / signal sharing)
  FOR _correlation IN
    WITH same_side_matches AS (
      SELECT
        t2.account_id AS other_account_id,
        a2.account_number AS other_account_number,
        a2.user_id AS other_user_id,
        t1.symbol,
        t1.side AS our_side,
        t2.side AS their_side,
        t1.opened_at AS our_time,
        t2.opened_at AS their_time,
        ABS(EXTRACT(EPOCH FROM (t2.opened_at - t1.opened_at))) AS time_diff_seconds
      FROM trades t1
      JOIN trades t2 ON t1.symbol = t2.symbol
        AND t1.side = t2.side  -- Same side = copy trading
        AND t1.account_id != t2.account_id
        AND ABS(EXTRACT(EPOCH FROM (t2.opened_at - t1.opened_at))) <= _time_window_seconds
      JOIN accounts a2 ON t2.account_id = a2.id
      WHERE t1.account_id = _account_id
        AND a2.user_id != _account_user_id
    ),
    ranked_matches AS (
      SELECT *,
        ROW_NUMBER() OVER (PARTITION BY other_account_id ORDER BY our_time DESC) as rn
      FROM same_side_matches
    )
    SELECT
      other_account_id,
      other_account_number,
      COUNT(*) AS match_count,
      'same_side' AS correlation_type,
      jsonb_agg(
        jsonb_build_object(
          'symbol', symbol,
          'our_side', our_side,
          'their_side', their_side,
          'our_time', our_time,
          'their_time', their_time,
          'time_diff_seconds', time_diff_seconds
        ) ORDER BY our_time DESC
      ) FILTER (WHERE rn <= 10) AS sample_trades
    FROM ranked_matches
    GROUP BY other_account_id, other_account_number
    HAVING COUNT(*) >= _min_match_count
  LOOP
    _correlations := _correlations || jsonb_build_object(
      'other_account_id', _correlation.other_account_id,
      'other_account_number', _correlation.other_account_number,
      'match_count', _correlation.match_count,
      'correlation_type', _correlation.correlation_type,
      'sample_trades', _correlation.sample_trades
    );
  END LOOP;
  
  RETURN jsonb_build_object(
    'has_correlations', jsonb_array_length(_correlations) > 0,
    'correlation_count', jsonb_array_length(_correlations),
    'correlations', _correlations
  );
END;
$function$;

-- ============================================
-- NEW: Atomic fingerprint seen_count increment
-- ============================================
CREATE OR REPLACE FUNCTION public.bump_fingerprint_seen(_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  UPDATE device_fingerprints
  SET seen_count = seen_count + 1,
      last_seen_at = now()
  WHERE id = _id;
$$;

-- ============================================
-- NEW: Check payout method for duplicates (enforce at creation)
-- Returns true if method_hash is already used by another user
-- ============================================
CREATE OR REPLACE FUNCTION public.check_payout_method_duplicate(_method_hash text, _user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _existing_count integer;
  _blocked boolean;
  _other_users uuid[];
BEGIN
  -- Check if this method hash is used by other users
  SELECT 
    COUNT(*),
    ARRAY_AGG(DISTINCT user_id),
    BOOL_OR(is_blocked)
  INTO _existing_count, _other_users, _blocked
  FROM payout_methods
  WHERE method_hash = _method_hash
    AND user_id != _user_id;
  
  IF _blocked THEN
    RETURN jsonb_build_object(
      'allowed', false,
      'reason', 'This payout method has been blocked',
      'is_blocked', true
    );
  END IF;
  
  IF _existing_count > 0 THEN
    RETURN jsonb_build_object(
      'allowed', false,
      'reason', 'This payout method is already registered to another user',
      'duplicate_count', _existing_count,
      'requires_review', true
    );
  END IF;
  
  RETURN jsonb_build_object(
    'allowed', true,
    'reason', null
  );
END;
$function$;

-- ============================================
-- NEW: Enforce payout eligibility at REQUEST time
-- ============================================
CREATE OR REPLACE FUNCTION public.validate_payout_request(_account_id uuid, _requested_amount numeric)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _eligibility jsonb;
  _max_eligible numeric;
BEGIN
  -- Get full eligibility check
  _eligibility := calculate_payout_eligibility(_account_id);
  
  -- If not eligible, return the reason
  IF NOT (_eligibility->>'eligible')::boolean THEN
    RETURN _eligibility;
  END IF;
  
  _max_eligible := (_eligibility->>'max_eligible_amount')::numeric;
  
  -- Check if requested amount exceeds eligible
  IF _requested_amount > _max_eligible THEN
    RETURN jsonb_build_object(
      'eligible', false,
      'reason', 'Requested amount exceeds maximum eligible payout',
      'requested_amount', _requested_amount,
      'max_eligible_amount', _max_eligible
    );
  END IF;
  
  -- Check for minimum payout threshold ($50)
  IF _requested_amount < 50 THEN
    RETURN jsonb_build_object(
      'eligible', false,
      'reason', 'Minimum payout amount is $50',
      'requested_amount', _requested_amount,
      'minimum_amount', 50
    );
  END IF;
  
  -- All checks passed
  RETURN jsonb_build_object(
    'eligible', true,
    'requested_amount', _requested_amount,
    'max_eligible_amount', _max_eligible,
    'eligibility_details', _eligibility
  );
END;
$function$;