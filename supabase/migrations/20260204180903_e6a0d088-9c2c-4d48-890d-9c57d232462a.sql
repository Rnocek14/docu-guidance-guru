-- Fix type mismatch: fraud_reviews.entity_id is uuid, not text
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
  
  -- FIX: entity_id is uuid type, compare directly without casting to text
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

-- Now run the 5 tests
DO $$
DECLARE
  v_cohort_id uuid := '11111111-1111-1111-1111-111111111111';
  v_user_id   uuid := '65c43a0a-7182-448f-9753-ed9818030602';
  v_account_id uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  v_payout_paid_seed uuid := 'bbbbbbbb-0000-0000-0000-000000000002';
  v_payout_bypass uuid := 'dddddddd-0000-0000-0000-000000000001';
  v_now timestamptz := now();
  v_test1 jsonb; v_test2 jsonb; v_test3 jsonb; v_test4 jsonb; v_test5 jsonb;
BEGIN
  DELETE FROM payouts WHERE account_id = v_account_id;
  DELETE FROM accounts WHERE id = v_account_id;
  DELETE FROM cohorts WHERE id = v_cohort_id;

  INSERT INTO cohorts (id, name, payout_split_percent, max_payout_percent, payout_cooldown_days, min_trading_days_between_payouts, first_payout_cap_amount)
  VALUES (v_cohort_id, 'TEST COHORT CAP 300', 80, 80, 0, 0, 300);

  INSERT INTO accounts (id, user_id, cohort_id, account_number, status, starting_balance, current_balance, payout_cycle_start_balance, payout_cycle_started_at, highest_balance)
  VALUES (v_account_id, v_user_id, v_cohort_id, 'TEST-CAP-001', 'passed', 50000, 60000, 50000, v_now - interval '7 days', 60000);

  SELECT public.calculate_payout_eligibility(v_account_id) INTO v_test1;
  IF NOT ((v_test1->>'eligible')::boolean AND (v_test1->>'is_first_payout_in_cycle')::boolean AND (v_test1->>'first_payout_cap_applied')::boolean AND (v_test1->>'max_eligible_amount')::numeric <= 300) THEN
    RAISE EXCEPTION 'TEST 1 FAILED: %', v_test1;
  END IF;
  RAISE NOTICE 'TEST 1 PASS - First payout cap applies';

  INSERT INTO payouts (id, account_id, status, amount, paid_at, payment_reference, requested_at)
  VALUES (v_payout_paid_seed, v_account_id, 'paid', 100, v_now - interval '1 day', 'seed', v_now - interval '2 days');

  SELECT public.calculate_payout_eligibility(v_account_id) INTO v_test2;
  IF NOT ((v_test2->>'eligible')::boolean AND NOT (v_test2->>'is_first_payout_in_cycle')::boolean AND NOT COALESCE((v_test2->>'first_payout_cap_applied')::boolean, false)) THEN
    RAISE EXCEPTION 'TEST 2 FAILED: %', v_test2;
  END IF;
  RAISE NOTICE 'TEST 2 PASS - Second payout not capped';

  DELETE FROM payouts WHERE id = v_payout_paid_seed;
  SELECT public.validate_payout_request(v_account_id, 500) INTO v_test3;
  IF NOT (NOT (v_test3->>'eligible')::boolean AND (v_test3->>'first_payout_cap_applied')::boolean AND (v_test3->>'reason') ILIKE '%First payout cap applies%') THEN
    RAISE EXCEPTION 'TEST 3 FAILED: %', v_test3;
  END IF;
  RAISE NOTICE 'TEST 3 PASS - Cap message shown';

  UPDATE cohorts SET first_payout_cap_amount = NULL WHERE id = v_cohort_id;
  SELECT public.validate_payout_request(v_account_id, 200) INTO v_test4;
  IF NOT (v_test4 ? 'first_payout_cap_amount') THEN
    RAISE EXCEPTION 'TEST 4 FAILED: %', v_test4;
  END IF;
  RAISE NOTICE 'TEST 4 PASS - NULL cap safe';
  UPDATE cohorts SET first_payout_cap_amount = 300 WHERE id = v_cohort_id;

  INSERT INTO payouts (id, account_id, status, amount, calculated_eligible_amount, requested_at)
  VALUES (v_payout_bypass, v_account_id, 'approved', 999, 300, v_now);
  SELECT public.mark_payout_paid(v_payout_bypass, 'TEST', v_user_id) INTO v_test5;
  IF NOT (NOT (v_test5->>'success')::boolean AND (v_test5->>'error') ILIKE '%exceeds calculated eligible%') THEN
    RAISE EXCEPTION 'TEST 5 FAILED: %', v_test5;
  END IF;
  RAISE NOTICE 'TEST 5 PASS - Bypass blocked';

  DELETE FROM payouts WHERE account_id = v_account_id;
  DELETE FROM accounts WHERE id = v_account_id;
  DELETE FROM cohorts WHERE id = v_cohort_id;
  RAISE NOTICE '=== ALL 5 TESTS PASSED ===';
END $$;