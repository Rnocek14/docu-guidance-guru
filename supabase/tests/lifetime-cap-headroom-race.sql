 -- ============================================================
 -- Lifetime Cap Headroom Race Test (Double-Spend Prevention)
 -- ============================================================
 -- What it validates:
 --   1) Two approved payouts for same user+cohort can't both succeed
 --      when combined amount exceeds remaining headroom
 --   2) FOR UPDATE lock on user_cohort_payouts serializes updates
 --   3) Second payout sees updated total and fails
 --
 -- This is the "cap-bypass" attack scenario:
 --   - User has $50 headroom remaining
 --   - Two $50 payouts are approved (each individually fits)
 --   - Race condition: both check headroom, both see $50, both try to pay
 --   - Without locking: $100 paid, exceeds cap by $50
 --   - With locking: only one succeeds, other blocked
 --
 -- HOW TO RUN (2-session test):
 --   1) Run SETUP block first (creates two approved payouts)
 --   2) Open TWO SQL Editor tabs
 --   3) In Tab A: run "SESSION A" block
 --   4) IMMEDIATELY in Tab B: run "SESSION B" block
 --   5) After both complete, run "VERIFY" block
 --
 -- Expected: One payout pays, other fails with headroom error
 -- ============================================================
 
 -- ============================================================
 -- SETUP: Create two payouts that individually fit but together exceed cap
 -- ============================================================
 DO $$
 DECLARE
   _user_id uuid;
   _cohort_id uuid;
   _account_id uuid;
   _payout_a_id uuid;
   _payout_b_id uuid;
   _cap_amount numeric;
   _payout_amount numeric := 50;  -- Each payout is $50
   _headroom_target numeric := 50; -- Set headroom to exactly $50
   _lifetime_to_set numeric;
   _acct_prefix text := 'TEST-HEADROOM-';
 BEGIN
   -- Find a capped cohort
   SELECT c.id, (c.entry_fee * c.lifetime_cap_multiple)
   INTO _cohort_id, _cap_amount
   FROM cohorts c
   WHERE c.entry_fee IS NOT NULL
     AND c.lifetime_cap_multiple IS NOT NULL
   ORDER BY c.created_at DESC
   LIMIT 1;
 
   IF _cohort_id IS NULL THEN
     RAISE EXCEPTION 'No capped cohort found. Create one with entry_fee and lifetime_cap_multiple.';
   END IF;
 
   -- Find a real user
   SELECT p.user_id INTO _user_id
   FROM profiles p
   JOIN auth.users u ON u.id = p.user_id
   ORDER BY p.created_at DESC NULLS LAST
   LIMIT 1;
 
   IF _user_id IS NULL THEN
     RAISE EXCEPTION 'No user found. Create a user first via signup.';
   END IF;
 
   -- Cleanup prior test artifacts
   DELETE FROM payouts p
   USING accounts a
   WHERE p.account_id = a.id
     AND a.user_id = _user_id
     AND a.cohort_id = _cohort_id
     AND a.account_number LIKE (_acct_prefix || '%');
 
   DELETE FROM accounts a
   WHERE a.user_id = _user_id
     AND a.cohort_id = _cohort_id
     AND a.account_number LIKE (_acct_prefix || '%');
 
   -- Set lifetime total to (cap - headroom_target) so only $50 headroom remains
   _lifetime_to_set := _cap_amount - _headroom_target;
 
   INSERT INTO user_cohort_payouts (user_id, cohort_id, lifetime_paid_total)
   VALUES (_user_id, _cohort_id, _lifetime_to_set)
   ON CONFLICT (user_id, cohort_id) DO UPDATE
   SET lifetime_paid_total = _lifetime_to_set;
 
   -- Reset profile total to match (for consistency)
   UPDATE profiles
   SET lifetime_paid_total = _lifetime_to_set
   WHERE user_id = _user_id;
 
   RAISE NOTICE 'Set lifetime_paid_total to $% (cap=$%, headroom=$%)',
     _lifetime_to_set, _cap_amount, _headroom_target;
 
   -- Create a passed account with profit
   INSERT INTO accounts (
     user_id, cohort_id, account_number, status,
     starting_balance, current_balance, highest_balance, total_pnl,
     trading_days_count, passed_at,
     payout_cycle_start_balance, payout_cycle_started_at, created_at
   )
   VALUES (
     _user_id, _cohort_id,
     _acct_prefix || substr(gen_random_uuid()::text, 1, 8),
     'passed',
     50000, 52000, 52000, 2000, 10,
     now() - interval '14 days',
     50000, now() - interval '14 days', now() - interval '14 days'
   )
   RETURNING id INTO _account_id;
 
   -- Create PAYOUT A: $50 approved
   INSERT INTO payouts (
     account_id, amount, status, requested_at, reviewed_at, calculated_eligible_amount
   )
   VALUES (
     _account_id, _payout_amount, 'approved',
     now() - interval '2 hours', now() - interval '1 hour', _payout_amount
   )
   RETURNING id INTO _payout_a_id;
 
   -- Create PAYOUT B: $50 approved (same account, same amount)
   INSERT INTO payouts (
     account_id, amount, status, requested_at, reviewed_at, calculated_eligible_amount
   )
   VALUES (
     _account_id, _payout_amount, 'approved',
     now() - interval '1 hour', now() - interval '30 minutes', _payout_amount
   )
   RETURNING id INTO _payout_b_id;
 
   RAISE NOTICE '============================================';
   RAISE NOTICE 'HEADROOM RACE TEST SETUP';
   RAISE NOTICE '============================================';
   RAISE NOTICE 'user_id:        %', _user_id;
   RAISE NOTICE 'cohort_id:      %', _cohort_id;
   RAISE NOTICE 'account_id:     %', _account_id;
   RAISE NOTICE 'cap_amount:     $%', _cap_amount;
   RAISE NOTICE 'lifetime_total: $%', _lifetime_to_set;
   RAISE NOTICE 'headroom:       $%', _headroom_target;
   RAISE NOTICE '';
   RAISE NOTICE 'PAYOUT A (use in Session A):';
   RAISE NOTICE '  %', _payout_a_id;
   RAISE NOTICE 'PAYOUT B (use in Session B):';
   RAISE NOTICE '  %', _payout_b_id;
   RAISE NOTICE '';
   RAISE NOTICE 'Each payout is $%, but only $% headroom exists.',
     _payout_amount, _headroom_target;
   RAISE NOTICE 'Expected: ONE succeeds, ONE fails with headroom error.';
   RAISE NOTICE '============================================';
 END $$;
 
 
 -- ============================================================
 -- SESSION A: Run in Tab 1 (attempts to pay Payout A)
-- Replace <PAYOUT_A_UUID> with Payout A UUID from SETUP
 -- ============================================================
 /*
 BEGIN;
 
-- Sleep to allow Session B to start simultaneously
-- The real contention happens on user_cohort_payouts row inside mark_payout_paid
-- (both RPCs will hit FOR UPDATE on the same {user_id, cohort_id} row)
SELECT pg_sleep(5);
 
-- Attempt to mark paid
 SELECT public.mark_payout_paid(
  '<PAYOUT_A_UUID>'::uuid,
   'headroom-race-A',
   NULL
 ) AS session_a_result;
 
 COMMIT;
 */
 
 
 -- ============================================================
-- SESSION B: Run in Tab 2 IMMEDIATELY after starting Session A
-- Replace <PAYOUT_B_UUID> with Payout B UUID from SETUP (DIFFERENT from A!)
 -- ============================================================
 /*
 BEGIN;
 
-- Attempt to mark Payout B paid (will contend on user_cohort_payouts row)
 SELECT public.mark_payout_paid(
  '<PAYOUT_B_UUID>'::uuid,
   'headroom-race-B',
   NULL
 ) AS session_b_result;
 
 COMMIT;
 */
 
 
 -- ============================================================
 -- VERIFY: Run after both sessions complete
-- Replace UUIDs with values from SETUP (must be DIFFERENT payouts!)
 -- ============================================================
 /*
 DO $$
 DECLARE
  _payout_a_id uuid := '<PAYOUT_A_UUID>';
  _payout_b_id uuid := '<PAYOUT_B_UUID>';
   _payout_a record;
   _payout_b record;
  _account_a record;
  _account_b record;
   _cohort record;
   _cohort_total numeric;
   _profile_total numeric;
   _cap_amount numeric;
   _paid_count integer := 0;
  _sum_paid numeric := 0;
  _winning_amount numeric;
  -- SETUP always primes with $50 payouts and $50 headroom, so baseline = cap - 50
  _headroom_target numeric := 50;  -- Must match SETUP
  _baseline_total numeric;
 BEGIN
  -- Sanity check: ensure user didn't paste the same UUID twice
  IF _payout_a_id = _payout_b_id THEN
    RAISE EXCEPTION 'FAIL: Payout A and B have the same UUID. Use DIFFERENT payouts from SETUP.';
  END IF;

  -- Use NOT FOUND pattern (record IS NULL doesn't work in PL/pgSQL)
  SELECT * INTO _payout_a FROM payouts WHERE id = _payout_a_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payout A not found. Check UUID=%', _payout_a_id;
  END IF;
 
  SELECT * INTO _payout_b FROM payouts WHERE id = _payout_b_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payout B not found. Check UUID=%', _payout_b_id;
   END IF;

  -- ASSERTION: Both payouts must be exactly $50 (matches SETUP)
  IF _payout_a.amount != _headroom_target OR _payout_b.amount != _headroom_target THEN
    RAISE EXCEPTION 'FAIL: Expected both payouts to be $%, got A=$% B=$%. SETUP/VERIFY mismatch.',
      _headroom_target, _payout_a.amount, _payout_b.amount;
  END IF;

  -- Load both accounts and verify they share user+cohort
  SELECT * INTO _account_a FROM accounts WHERE id = _payout_a.account_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Account A not found for payout A';
  END IF;

  SELECT * INTO _account_b FROM accounts WHERE id = _payout_b.account_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Account B not found for payout B';
   END IF;
 
  -- ASSERTION: Both payouts must target same user+cohort (otherwise test is invalid)
  IF _account_a.user_id != _account_b.user_id OR _account_a.cohort_id != _account_b.cohort_id THEN
    RAISE EXCEPTION 'Payouts are not for the same user/cohort. A: user=% cohort=%, B: user=% cohort=%. Test invalid.',
      _account_a.user_id, _account_a.cohort_id, _account_b.user_id, _account_b.cohort_id;
  END IF;
 
  SELECT * INTO _cohort FROM cohorts WHERE id = _account_a.cohort_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Cohort not found';
  END IF;

  -- Null-safe cap calculation
  IF _cohort.entry_fee IS NULL OR _cohort.lifetime_cap_multiple IS NULL THEN
    RAISE EXCEPTION 'Cohort is uncapped (entry_fee or lifetime_cap_multiple is NULL). Test invalid.';
  END IF;
  _cap_amount := _cohort.entry_fee * _cohort.lifetime_cap_multiple;

  -- Baseline is what SETUP primed: cap - headroom_target (deterministic, not derived from payout)
  _baseline_total := _cap_amount - _headroom_target;
 
   SELECT COALESCE(ucp.lifetime_paid_total, 0) INTO _cohort_total
   FROM user_cohort_payouts ucp
  WHERE ucp.user_id = _account_a.user_id
    AND ucp.cohort_id = _account_a.cohort_id;
 
   SELECT COALESCE(pf.lifetime_paid_total, 0) INTO _profile_total
   FROM profiles pf
  WHERE pf.user_id = _account_a.user_id;
 
   RAISE NOTICE '============================================';
   RAISE NOTICE 'HEADROOM RACE VERIFICATION';
   RAISE NOTICE '============================================';
   RAISE NOTICE 'PAYOUT A: status=% paid_at=% ref=%',
     _payout_a.status, _payout_a.paid_at, _payout_a.payment_reference;
   RAISE NOTICE 'PAYOUT B: status=% paid_at=% ref=%',
     _payout_b.status, _payout_b.paid_at, _payout_b.payment_reference;
   RAISE NOTICE '';
   RAISE NOTICE 'Cohort lifetime_total: $%', _cohort_total;
   RAISE NOTICE 'Profile lifetime_total: $%', _profile_total;
   RAISE NOTICE 'Cap amount: $%', _cap_amount;
  RAISE NOTICE 'Baseline (primed): $%', _baseline_total;
   RAISE NOTICE '============================================';
 
  -- Count how many actually paid and sum their amounts
  IF _payout_a.status = 'paid' THEN
    _paid_count := _paid_count + 1;
    _sum_paid := _sum_paid + _payout_a.amount;
    _winning_amount := _payout_a.amount;
  END IF;
  IF _payout_b.status = 'paid' THEN
    _paid_count := _paid_count + 1;
    _sum_paid := _sum_paid + _payout_b.amount;
    _winning_amount := _payout_b.amount;
  END IF;
 
   -- ASSERTION 1: Exactly one payout should be paid
   IF _paid_count = 0 THEN
     RAISE EXCEPTION 'FAIL: Neither payout was paid. At least one should succeed.';
   END IF;
 
   IF _paid_count = 2 THEN
     RAISE EXCEPTION 'FAIL: BOTH payouts were paid! Cap was bypassed. Double-spend occurred.';
   END IF;
 
   RAISE NOTICE '✅ Exactly one payout paid (as expected)';
 
   -- ASSERTION 2: The one that paid should have paid_at set
   IF _payout_a.status = 'paid' AND _payout_a.paid_at IS NULL THEN
     RAISE EXCEPTION 'FAIL: Payout A is paid but paid_at is NULL';
   END IF;
   IF _payout_b.status = 'paid' AND _payout_b.paid_at IS NULL THEN
     RAISE EXCEPTION 'FAIL: Payout B is paid but paid_at is NULL';
   END IF;
 
  -- ASSERTION 3: The paid payout must have payment_reference set
  IF _payout_a.status = 'paid' AND _payout_a.payment_reference IS NULL THEN
    RAISE EXCEPTION 'FAIL: Payout A is paid but payment_reference is NULL';
  END IF;
  IF _payout_b.status = 'paid' AND _payout_b.payment_reference IS NULL THEN
    RAISE EXCEPTION 'FAIL: Payout B is paid but payment_reference is NULL';
  END IF;

  RAISE NOTICE '✅ Paid payout has paid_at and payment_reference set';

  -- ASSERTION 4: Cohort total should equal baseline + one payout (= cap)
  IF _cohort_total != (_baseline_total + _winning_amount) THEN
    RAISE EXCEPTION 'FAIL: Cohort total should be $% (baseline $% + payout $%) but got $%',
      (_baseline_total + _winning_amount), _baseline_total, _winning_amount, _cohort_total;
   END IF;
 
  RAISE NOTICE '✅ Cohort total incremented by exactly one payout: $% → $%',
    _baseline_total, _cohort_total;

  -- ASSERTION 5: Profile total should be at least cohort total (may include other cohorts)
  -- We can't assert exact equality since profile is global across all cohorts
  IF _profile_total < _cohort_total THEN
    RAISE EXCEPTION 'FAIL: Profile total ($%) is less than cohort total ($%). Data inconsistency!',
      _profile_total, _cohort_total;
   END IF;
 
  RAISE NOTICE '✅ Profile total consistent (>= cohort total): $%', _profile_total;
 
  -- ASSERTION 6: The unpaid payout should still be approved (not corrupted)

  -- ASSERTION 5: Profile total should be at least cohort total (may include other cohorts)
  -- We can't assert exact equality since profile is global across all cohorts
  IF _profile_total < _cohort_total THEN
    RAISE EXCEPTION 'FAIL: Profile total ($%) is less than cohort total ($%). Data inconsistency!',
      _profile_total, _cohort_total;
   END IF;
 
  RAISE NOTICE '✅ Profile total consistent (>= cohort total): $%', _profile_total;
 
  -- ASSERTION 6: The unpaid payout should still be approved (not corrupted)
   IF _payout_a.status = 'approved' AND _payout_b.status = 'paid' THEN
     RAISE NOTICE '✅ Payout A stayed approved (blocked by headroom check)';
     RAISE NOTICE '✅ Payout B won the race and paid';
   ELSIF _payout_b.status = 'approved' AND _payout_a.status = 'paid' THEN
     RAISE NOTICE '✅ Payout B stayed approved (blocked by headroom check)';
     RAISE NOTICE '✅ Payout A won the race and paid';
   END IF;
 
  -- ASSERTION 7: Cap not exceeded
  IF _cohort_total > _cap_amount THEN
    RAISE EXCEPTION 'FAIL: Cohort total ($%) exceeds cap ($%)! Cap bypass detected.',
      _cohort_total, _cap_amount;
  END IF;

  RAISE NOTICE '✅ Cap respected: $% <= $%', _cohort_total, _cap_amount;

   RAISE NOTICE '';
   RAISE NOTICE '✅ ALL HEADROOM RACE CHECKS PASSED';
   RAISE NOTICE '   - FOR UPDATE lock serialized concurrent updates';
   RAISE NOTICE '   - Second payout saw updated total and was blocked';
   RAISE NOTICE '   - Cap not exceeded despite race condition';
  RAISE NOTICE '   - Sum paid = $% (exactly one payout)', _sum_paid;
   RAISE NOTICE '============================================';
 END $$;
 */