 -- ============================================================
 -- Lifetime Cap Concurrency/Race Test
 -- ============================================================
 -- What it validates:
 --  1) FOR UPDATE locking prevents double-pay
 --  2) Exactly one increment to user_cohort_payouts
 --  3) Idempotency returns success without re-incrementing
 --
 -- HOW TO RUN (2-session test):
 --  1) Run seed-payout-test-data.sql first (note the payout_id)
 --  2) Open TWO SQL Editor tabs
 --  3) In Tab A: run "SESSION A" block (starts transaction, sleeps 5s)
 --  4) IMMEDIATELY in Tab B: run "SESSION B" block (will block on lock)
 --  5) After both complete, run "VERIFY" block
 --
 -- Expected: Session A pays, Session B gets idempotent success,
 --           totals increment exactly once.
 -- ============================================================
 
 -- ============================================================
 -- SETUP: Find the TEST-CAP payout to use
 -- ============================================================
 DO $$
 DECLARE
   _payout_id uuid;
   _account_id uuid;
   _user_id uuid;
   _cohort_id uuid;
   _starting_total numeric;
   _payout_amount numeric;
 BEGIN
   -- Find the TEST-CAP payout
   SELECT p.id, p.account_id, p.amount
   INTO _payout_id, _account_id, _payout_amount
   FROM payouts p
   JOIN accounts a ON a.id = p.account_id
   WHERE p.status = 'approved'
     AND a.account_number LIKE 'TEST-CAP-%'
   ORDER BY p.created_at DESC
   LIMIT 1;
 
   IF _payout_id IS NULL THEN
     RAISE EXCEPTION 'No approved TEST-CAP payout found. Run seed-payout-test-data.sql first.';
   END IF;
 
   SELECT a.user_id, a.cohort_id INTO _user_id, _cohort_id
   FROM accounts a WHERE a.id = _account_id;
 
   SELECT COALESCE(ucp.lifetime_paid_total, 0)
   INTO _starting_total
   FROM user_cohort_payouts ucp
   WHERE ucp.user_id = _user_id AND ucp.cohort_id = _cohort_id;
 
   RAISE NOTICE '============================================';
   RAISE NOTICE 'CONCURRENCY TEST SETUP';
   RAISE NOTICE '============================================';
   RAISE NOTICE 'payout_id:      %', _payout_id;
   RAISE NOTICE 'account_id:     %', _account_id;
   RAISE NOTICE 'payout_amount:  $%', _payout_amount;
   RAISE NOTICE 'starting_total: $%', _starting_total;
   RAISE NOTICE '';
   RAISE NOTICE 'Copy this payout_id for the SESSION blocks below:';
   RAISE NOTICE '  %', _payout_id;
   RAISE NOTICE '';
   RAISE NOTICE 'Expected final total after test: $%', _starting_total + _payout_amount;
   RAISE NOTICE '============================================';
 END $$;
 
 
 -- ============================================================
 -- SESSION A: Run this in Tab 1 (holds lock for 5 seconds)
 -- Replace <PAYOUT_ID> with the UUID from SETUP above
 -- ============================================================
 /*
 BEGIN;
 
 -- Lock the payout row (Session B will block here)
 SELECT id, status, amount
 FROM payouts
 WHERE id = '<PAYOUT_ID>'
 FOR UPDATE;
 
 -- Hold lock so Session B collides
 SELECT pg_sleep(5);
 
 -- Attempt to mark paid
 SELECT public.mark_payout_paid(
   '<PAYOUT_ID>'::uuid,
   'race-session-A',
   NULL
 ) AS session_a_result;
 
 COMMIT;
 */
 
 
 -- ============================================================
 -- SESSION B: Run this in Tab 2 IMMEDIATELY after starting A
 -- Replace <PAYOUT_ID> with the same UUID
 -- ============================================================
 /*
 BEGIN;
 
 -- This will block until Session A commits
 SELECT public.mark_payout_paid(
   '<PAYOUT_ID>'::uuid,
   'race-session-B',
   NULL
 ) AS session_b_result;
 
 COMMIT;
 */
 
 
 -- ============================================================
 -- VERIFY: Run after both sessions complete
 -- Replace <PAYOUT_ID> with the same UUID
 -- ============================================================
 /*
 DO $$
 DECLARE
   _payout_id uuid := '<PAYOUT_ID>';
   _payout record;
   _account record;
   _cohort_total numeric;
   _profile_total numeric;
  _payout_amount numeric;
 BEGIN
   SELECT * INTO _payout FROM payouts WHERE id = _payout_id;
  
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payout not found for id=%. Did you paste the correct UUID?', _payout_id;
  END IF;
  
   SELECT * INTO _account FROM accounts WHERE id = _payout.account_id;
 
  -- Derive amount from actual payout (not hardcoded)
  _payout_amount := _payout.amount;

  SELECT COALESCE(ucp.lifetime_paid_total, 0) INTO _cohort_total
   FROM user_cohort_payouts ucp
   WHERE ucp.user_id = _account.user_id
     AND ucp.cohort_id = _account.cohort_id;
 
  SELECT COALESCE(pf.lifetime_paid_total, 0) INTO _profile_total
   FROM profiles pf
   WHERE pf.user_id = _account.user_id;
 
   RAISE NOTICE '============================================';
   RAISE NOTICE 'VERIFICATION RESULTS';
   RAISE NOTICE '============================================';
   RAISE NOTICE 'Payout status:         %', _payout.status;
   RAISE NOTICE 'Payout paid_at:        %', _payout.paid_at;
   RAISE NOTICE 'Payment reference:     %', _payout.payment_reference;
  RAISE NOTICE 'Payout amount:         $%', _payout_amount;
   RAISE NOTICE '';
   RAISE NOTICE 'Cohort lifetime_total: $%', _cohort_total;
   RAISE NOTICE 'Profile lifetime_total: $%', _profile_total;
   RAISE NOTICE '============================================';
 
   -- Assertions
   IF _payout.status != 'paid' THEN
     RAISE EXCEPTION 'FAIL: Payout should be paid, got %', _payout.status;
   END IF;
 
  IF _payout.paid_at IS NULL THEN
    RAISE EXCEPTION 'FAIL: Payout is paid but paid_at is NULL';
  END IF;

   -- The first session's reference should win
   IF _payout.payment_reference NOT IN ('race-session-A', 'race-session-B') THEN
     RAISE EXCEPTION 'FAIL: Unexpected payment_reference: %', _payout.payment_reference;
   END IF;
 
  -- Check cohort total incremented exactly once
   IF _cohort_total != _payout_amount THEN
    RAISE EXCEPTION 'FAIL: Cohort total should be $% but got $% (possible double-increment!)',
       _payout_amount, _cohort_total;
   END IF;
 
  -- Check profile total incremented exactly once (catches bug where profiles increments twice)
  IF _profile_total != _payout_amount THEN
    RAISE EXCEPTION 'FAIL: Profile total should be $% but got $% (possible double-increment!)',
      _payout_amount, _profile_total;
  END IF;

  RAISE NOTICE '✅ Paid once. ref=% amount=$% cohort_total=$% profile_total=$%',
    _payout.payment_reference, _payout_amount, _cohort_total, _profile_total;
   RAISE NOTICE '';
   RAISE NOTICE '✅ ALL CONCURRENCY CHECKS PASSED';
   RAISE NOTICE '   - FOR UPDATE locking prevented race';
   RAISE NOTICE '   - Idempotency prevented double-increment';
  RAISE NOTICE '   - Both totals (cohort + profile) incremented exactly once';
   RAISE NOTICE '============================================';
 END $$;
 */