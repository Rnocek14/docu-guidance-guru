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
 -- Replace <PAYOUT_A_ID> with UUID from SETUP
 -- ============================================================
 /*
 BEGIN;
 
 -- Small delay to ensure both sessions start near-simultaneously
 SELECT pg_sleep(1);
 
 SELECT public.mark_payout_paid(
   '<PAYOUT_A_ID>'::uuid,
   'headroom-race-A',
   NULL
 ) AS session_a_result;
 
 COMMIT;
 */
 
 
 -- ============================================================
 -- SESSION B: Run in Tab 2 IMMEDIATELY after starting A
 -- Replace <PAYOUT_B_ID> with UUID from SETUP
 -- ============================================================
 /*
 BEGIN;
 
 SELECT public.mark_payout_paid(
   '<PAYOUT_B_ID>'::uuid,
   'headroom-race-B',
   NULL
 ) AS session_b_result;
 
 COMMIT;
 */
 
 
 -- ============================================================
 -- VERIFY: Run after both sessions complete
 -- Replace UUIDs with values from SETUP
 -- ============================================================
 /*
 DO $$
 DECLARE
   _payout_a_id uuid := '<PAYOUT_A_ID>';
   _payout_b_id uuid := '<PAYOUT_B_ID>';
   _payout_a record;
   _payout_b record;
   _account record;
   _cohort record;
   _cohort_total numeric;
   _profile_total numeric;
   _cap_amount numeric;
   _paid_count integer := 0;
   _expected_total numeric;
 BEGIN
   SELECT * INTO _payout_a FROM payouts WHERE id = _payout_a_id;
   SELECT * INTO _payout_b FROM payouts WHERE id = _payout_b_id;
 
   IF _payout_a IS NULL THEN
     RAISE EXCEPTION 'Payout A not found. Check UUID.';
   END IF;
   IF _payout_b IS NULL THEN
     RAISE EXCEPTION 'Payout B not found. Check UUID.';
   END IF;
 
   SELECT * INTO _account FROM accounts WHERE id = _payout_a.account_id;
   SELECT * INTO _cohort FROM cohorts WHERE id = _account.cohort_id;
 
   _cap_amount := _cohort.entry_fee * _cohort.lifetime_cap_multiple;
 
   SELECT COALESCE(ucp.lifetime_paid_total, 0) INTO _cohort_total
   FROM user_cohort_payouts ucp
   WHERE ucp.user_id = _account.user_id
     AND ucp.cohort_id = _account.cohort_id;
 
   SELECT COALESCE(pf.lifetime_paid_total, 0) INTO _profile_total
   FROM profiles pf
   WHERE pf.user_id = _account.user_id;
 
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
   RAISE NOTICE '============================================';
 
   -- Count how many actually paid
   IF _payout_a.status = 'paid' THEN _paid_count := _paid_count + 1; END IF;
   IF _payout_b.status = 'paid' THEN _paid_count := _paid_count + 1; END IF;
 
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
 
   -- ASSERTION 3: Total should equal cap (we set headroom = payout amount)
   IF _cohort_total != _cap_amount THEN
     RAISE EXCEPTION 'FAIL: Cohort total should be $% (cap) but got $%',
       _cap_amount, _cohort_total;
   END IF;
 
   IF _profile_total != _cap_amount THEN
     RAISE EXCEPTION 'FAIL: Profile total should be $% (cap) but got $%',
       _cap_amount, _profile_total;
   END IF;
 
   RAISE NOTICE '✅ Lifetime totals exactly at cap: $%', _cap_amount;
 
   -- ASSERTION 4: The unpaid payout should still be approved (not corrupted)
   IF _payout_a.status = 'approved' AND _payout_b.status = 'paid' THEN
     RAISE NOTICE '✅ Payout A stayed approved (blocked by headroom check)';
     RAISE NOTICE '✅ Payout B won the race and paid';
   ELSIF _payout_b.status = 'approved' AND _payout_a.status = 'paid' THEN
     RAISE NOTICE '✅ Payout B stayed approved (blocked by headroom check)';
     RAISE NOTICE '✅ Payout A won the race and paid';
   END IF;
 
   RAISE NOTICE '';
   RAISE NOTICE '✅ ALL HEADROOM RACE CHECKS PASSED';
   RAISE NOTICE '   - FOR UPDATE lock serialized concurrent updates';
   RAISE NOTICE '   - Second payout saw updated total and was blocked';
   RAISE NOTICE '   - Cap not exceeded despite race condition';
   RAISE NOTICE '============================================';
 END $$;
 */