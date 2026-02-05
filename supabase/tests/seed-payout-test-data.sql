 -- ============================================================
 -- Seed Data for Lifetime Cap Verification Testing
 -- ============================================================
 -- Run this ONCE to create test data, then run lifetime-cap-verification.sql
 --
 -- Prerequisites: 
 --   - A user must exist in auth.users (use existing user)
 --   - The cohort "Standard Challenge" must exist with entry_fee and lifetime_cap_multiple
 -- ============================================================
 
 DO $$
 DECLARE
   _user_id uuid;
   _cohort_id uuid;
   _account_id uuid;
   _payout_id uuid;
 BEGIN
   -- Use existing user
   SELECT user_id INTO _user_id FROM profiles LIMIT 1;
   
   IF _user_id IS NULL THEN
     RAISE EXCEPTION 'No user found in profiles. Create a user first via signup.';
   END IF;
   
   -- Get the capped cohort
   SELECT id INTO _cohort_id
   FROM cohorts
   WHERE entry_fee IS NOT NULL AND lifetime_cap_multiple IS NOT NULL
   LIMIT 1;
   
   IF _cohort_id IS NULL THEN
     RAISE EXCEPTION 'No capped cohort found. Create a cohort with entry_fee and lifetime_cap_multiple first.';
   END IF;
   
   RAISE NOTICE 'Using user_id=%, cohort_id=%', _user_id, _cohort_id;
   
   -- Create a test account in 'passed' status
   INSERT INTO accounts (
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
     payout_cycle_started_at
   )
   VALUES (
     _user_id,
     _cohort_id,
     'TEST-PAYOUT-' || substr(gen_random_uuid()::text, 1, 8),
     'payout_approved',  -- Ready for mark_payout_paid
     100000,
     100500,  -- $500 profit
     100500,
     500,
     10,  -- Met min trading days
     now() - interval '35 days',  -- Passed 35 days ago (cooldown met)
     100000,
     now() - interval '35 days'
   )
   RETURNING id INTO _account_id;
   
   RAISE NOTICE 'Created test account: %', _account_id;
   
   -- Create an approved payout (amount >= $50)
   INSERT INTO payouts (
     account_id,
     amount,
     status,
     requested_at,
     reviewed_at,
     calculated_eligible_amount
   )
   VALUES (
     _account_id,
     100,  -- $100 payout (above $50 min)
     'approved',
     now() - interval '1 day',
     now(),
     100  -- Server-calculated amount at approval
   )
   RETURNING id INTO _payout_id;
   
   RAISE NOTICE 'Created approved payout: %', _payout_id;
   RAISE NOTICE '✅ Test data seeded. Now run lifetime-cap-verification.sql';
   
   -- Output the IDs for reference
   RAISE NOTICE 'Summary:';
   RAISE NOTICE '  user_id: %', _user_id;
   RAISE NOTICE '  cohort_id: %', _cohort_id;
   RAISE NOTICE '  account_id: %', _account_id;
   RAISE NOTICE '  payout_id: %', _payout_id;
 END $$;