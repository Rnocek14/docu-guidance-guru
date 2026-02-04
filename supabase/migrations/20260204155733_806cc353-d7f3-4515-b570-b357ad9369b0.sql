-- ============================================
-- FIX 1: Add indexes for efficient correlation queries
-- ============================================

-- For t2 join on (symbol, opened_at) with side filtering
CREATE INDEX IF NOT EXISTS idx_trades_symbol_opened_at
ON trades (symbol, opened_at DESC);

-- Even better: include side for both correlation types
CREATE INDEX IF NOT EXISTS idx_trades_symbol_side_opened_at
ON trades (symbol, side, opened_at DESC);

-- ============================================
-- FIX 2: Document status model + add comment in function
-- The 'passed' status IS correct for new payout requests.
-- Once requested, status transitions to payout_requested → payout_under_review → payout_approved
-- This function validates NEW requests only (must be 'passed')
-- ============================================

-- No change needed to validate_payout_request - the logic is correct.
-- 'passed' = account has passed evaluation and can request payout
-- After request, status changes so they can't spam requests.

-- ============================================
-- FIX 3: Add payout_cycle_start_balance for reset-safe profit accounting
-- This tracks the baseline for the CURRENT payout cycle.
-- On reset: payout_cycle_start_balance := current_balance
-- This prevents "double-dip" disputes after resets.
-- ============================================

-- Add column to track payout cycle baseline (nullable for backwards compat)
ALTER TABLE accounts 
ADD COLUMN IF NOT EXISTS payout_cycle_start_balance numeric;

-- Initialize for existing accounts: use starting_balance if no payouts, else use current_balance
UPDATE accounts 
SET payout_cycle_start_balance = COALESCE(
  (SELECT current_balance FROM accounts a2 
   JOIN payouts p ON p.account_id = a2.id 
   WHERE a2.id = accounts.id AND p.status = 'paid'
   ORDER BY p.paid_at DESC LIMIT 1),
  starting_balance
)
WHERE payout_cycle_start_balance IS NULL;

-- Set default for new accounts
ALTER TABLE accounts 
ALTER COLUMN payout_cycle_start_balance SET DEFAULT 100000.00;

-- ============================================
-- UPDATED: calculate_payout_eligibility using payout_cycle_start_balance
-- This makes profit calculation reset-safe
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
  _cycle_baseline numeric;
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
  
  -- Status check: only 'passed' can make NEW payout requests
  -- (payout_requested/under_review/approved already have active requests)
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
  
  -- FIX 3: Use payout_cycle_start_balance for reset-safe profit calculation
  -- Falls back to starting_balance for backwards compatibility
  _cycle_baseline := COALESCE(_account.payout_cycle_start_balance, _account.starting_balance);
  
  -- Realized profit = current balance - cycle baseline
  _realized_profit := _account.current_balance - _cycle_baseline;
  
  -- Subtract payouts made AFTER the cycle baseline was set
  -- (only relevant if payout_cycle_start_balance was set mid-cycle)
  IF _last_payout IS NOT NULL AND _account.payout_cycle_start_balance IS NOT NULL THEN
    SELECT COALESCE(SUM(amount), 0) INTO _max_eligible
    FROM payouts
    WHERE account_id = _account_id 
      AND status = 'paid'
      AND paid_at > (
        -- Get when the cycle baseline was last reset
        SELECT COALESCE(
          (SELECT MAX(paid_at) FROM payouts 
           WHERE account_id = _account_id AND status = 'paid'),
          _account.created_at
        )
      );
  ELSE
    -- Fallback: subtract ALL paid payouts from starting_balance baseline
    SELECT COALESCE(SUM(amount), 0) INTO _max_eligible
    FROM payouts
    WHERE account_id = _account_id AND status = 'paid';
    
    _realized_profit := _realized_profit - _max_eligible;
  END IF;
  
  IF _realized_profit <= 0 THEN
    RETURN jsonb_build_object(
      'eligible', false, 
      'reason', 'No realized profit available for payout',
      'realized_profit', _realized_profit,
      'cycle_baseline', _cycle_baseline
    );
  END IF;
  
  _eligible_by_split := _realized_profit * (_cohort.payout_split_percent / 100.0);
  _max_eligible := _eligible_by_split * (_cohort.max_payout_percent / 100.0);
  
  IF _cohort.max_payout_absolute IS NOT NULL THEN
    _max_eligible := LEAST(_max_eligible, _cohort.max_payout_absolute);
  END IF;
  
  RETURN jsonb_build_object(
    'eligible', true,
    'max_eligible_amount', ROUND(_max_eligible, 2),
    'total_eligible_by_split', ROUND(_eligible_by_split, 2),
    'realized_profit', ROUND(_realized_profit, 2),
    'cycle_baseline', _cycle_baseline,
    'payout_split_percent', _cohort.payout_split_percent,
    'max_payout_percent_of_eligible', _cohort.max_payout_percent,
    'max_payout_absolute', _cohort.max_payout_absolute,
    'account_status', _account.status,
    'days_since_last_payout', _days_since_last_payout,
    'trading_days_since_payout', _trading_days_since_payout
  );
END;
$function$;

-- ============================================
-- Helper function to reset payout cycle (call after paid payout or account reset)
-- ============================================
CREATE OR REPLACE FUNCTION public.reset_payout_cycle(_account_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _current_balance numeric;
BEGIN
  SELECT current_balance INTO _current_balance
  FROM accounts WHERE id = _account_id;
  
  UPDATE accounts
  SET 
    payout_cycle_start_balance = _current_balance,
    highest_balance = _current_balance  -- Also reset high watermark
  WHERE id = _account_id;
END;
$$;