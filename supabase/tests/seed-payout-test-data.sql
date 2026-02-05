 -- ============================================================
 -- Seed Data for Lifetime Cap Verification Testing
 -- ============================================================
 -- Rerunnable: cleans up prior test artifacts before seeding.
 -- Creates: 1 passed account + 1 approved payout >= $50 in a capped cohort.
 -- Prerequisites: A user must exist in profiles table.
 -- Output: account_id + payout_id printed via NOTICE.
 -- ============================================================
 
 DO $$
 DECLARE
   _user_id uuid;
   _cohort_id uuid;
   _account_id uuid;
   _payout_id uuid;
   _entry_fee numeric := 149;
   _cap_multiple numeric := 7;
 BEGIN
   -- 0) Fetch existing test user from profiles
   SELECT user_id INTO _user_id FROM profiles LIMIT 1;
 
   IF _user_id IS NULL THEN
     RAISE EXCEPTION 'No user found in profiles. Create a user first via signup.';
   END IF;
 
   -- 1) Find a capped cohort by entry_fee + lifetime_cap_multiple (not name)
   SELECT c.id INTO _cohort_id
   FROM public.cohorts c
   WHERE c.entry_fee = _entry_fee
     AND c.lifetime_cap_multiple = _cap_multiple
   ORDER BY c.created_at DESC
   LIMIT 1;
 
   IF _cohort_id IS NULL THEN
     RAISE EXCEPTION 'No cohort found with entry_fee=% and lifetime_cap_multiple=%', _entry_fee, _cap_multiple;
   END IF;
 
   RAISE NOTICE 'Using user_id=%, cohort_id=%', _user_id, _cohort_id;
 
   -- 2) Cleanup prior seeded artifacts for this user/cohort (safe reruns)
   -- Delete payouts tied to our prior seeded accounts in this cohort
   DELETE FROM public.payouts p
   USING public.accounts a
   WHERE p.account_id = a.id
     AND a.user_id = _user_id
     AND a.cohort_id = _cohort_id
     AND a.status IN ('passed','payout_requested','payout_under_review','payout_approved','active','under_review');
 
   -- Delete those accounts
   DELETE FROM public.accounts a
   WHERE a.user_id = _user_id
     AND a.cohort_id = _cohort_id
     AND a.status IN ('passed','payout_requested','payout_under_review','payout_approved','active','under_review');
 
   -- Wipe per-cohort totals so tests start clean
   DELETE FROM public.user_cohort_payouts
   WHERE user_id = _user_id AND cohort_id = _cohort_id;
 
   RAISE NOTICE 'Cleaned up prior test artifacts.';
 
   -- 3) Create a passed account with profit
   INSERT INTO public.accounts (
     user_id,
     cohort_id,
     account_number,
     status,
     starting_balance,
     current_balance,
     highest_balance,
     total_pnl,
     trading_days_count,
     passed_at,
     payout_cycle_start_balance,
     payout_cycle_started_at,
     created_at
   )
   VALUES (
     _user_id,
     _cohort_id,
     'TEST-CAP-' || substr(gen_random_uuid()::text, 1, 8),
     'passed',
     50000,
     52000,               -- $2000 profit available
     52000,
     2000,
     10,                   -- Met min trading days
     now() - interval '14 days',
     50000,
     now() - interval '14 days',
     now() - interval '14 days'
   )
   RETURNING id INTO _account_id;
 
   RAISE NOTICE 'Created test account: %', _account_id;
 
   -- 4) Create an approved payout >= $50 with calculated_eligible_amount set
   INSERT INTO public.payouts (
     account_id,
     amount,
     status,
     requested_at,
     reviewed_at,
     calculated_eligible_amount
   )
   VALUES (
     _account_id,
     100,                  -- $100 payout (>= $50 min)
     'approved',
     now() - interval '1 day',
     now(),
     100                   -- must be >= amount to pass mark_payout_paid guard
   )
   RETURNING id INTO _payout_id;
 
   RAISE NOTICE '✅ Seed complete.';
   RAISE NOTICE '  user_id:    %', _user_id;
   RAISE NOTICE '  cohort_id:  %', _cohort_id;
   RAISE NOTICE '  account_id: %', _account_id;
   RAISE NOTICE '  payout_id:  %', _payout_id;
   RAISE NOTICE '';
   RAISE NOTICE 'Next: run supabase/tests/lifetime-cap-verification.sql';
   RAISE NOTICE '      (it auto-selects the approved payout)';
 END $$;