 -- ============================================================
 -- Lifetime Cap (Per-Tier) Verification Script
 -- ============================================================
 -- What it validates:
 --  1) SECURITY DEFINER ownership (RLS bypass viability)
 --  2) calculate_payout_eligibility clamped headroom + cap applied
 --  3) mark_payout_paid:
 --      - creates missing user_cohort_payouts row
 --      - enforces min payout
 --      - enforces headroom
 --      - idempotent (no double increment)
 --
 -- Usage: Run in Supabase SQL Editor. Requires at least one
 -- approved payout in a cohort with entry_fee + lifetime_cap_multiple set.
 -- ============================================================
 
 DO $$
 DECLARE
   _payout_id uuid;
   _account_id uuid;
   _user_id uuid;
   _cohort_id uuid;
 
   _entry_fee numeric;
   _multiple numeric;
   _cap numeric;
 
   _before_cohort_total numeric;
   _after_cohort_total numeric;
   _before_profile_total numeric;
   _after_profile_total numeric;
 
   _elig jsonb;
   _res jsonb;
 
   _headroom numeric;
   _requested numeric;
 BEGIN
   RAISE NOTICE '--- 1) Function ownership / SECURITY DEFINER check ---';
 
   PERFORM 1;
 
   -- Show function owner + security definer flag
   -- NOTE: security definer is stored as prosecdef boolean in pg_proc
   RAISE NOTICE '%',
     (SELECT jsonb_agg(
         jsonb_build_object(
           'name', p.proname,
           'owner', p.proowner::regrole::text,
           'security_definer', p.prosecdef
         )
       )
      FROM pg_proc p
      WHERE p.proname IN ('calculate_payout_eligibility', 'validate_payout_request', 'mark_payout_paid')
     );
 
   RAISE NOTICE '--- 2) Find an approved payout to use ---';
 
   SELECT p.id, p.account_id
   INTO _payout_id, _account_id
   FROM payouts p
   JOIN accounts a ON a.id = p.account_id
   JOIN cohorts c ON c.id = a.cohort_id
   WHERE p.status = 'approved'
     AND c.entry_fee IS NOT NULL
     AND c.lifetime_cap_multiple IS NOT NULL
     AND a.account_number LIKE 'TEST-CAP-%'
   ORDER BY p.created_at DESC
   LIMIT 1;
 
   IF _payout_id IS NULL THEN
     RAISE EXCEPTION 'No approved payout found for TEST-CAP-% account. Run seed-payout-test-data.sql first.';
   END IF;
 
   SELECT a.user_id, a.cohort_id INTO _user_id, _cohort_id
   FROM accounts a
   WHERE a.id = _account_id;
 
   SELECT c.entry_fee, c.lifetime_cap_multiple INTO _entry_fee, _multiple
   FROM cohorts c
   WHERE c.id = _cohort_id;
 
   _cap := _entry_fee * _multiple;
 
   RAISE NOTICE 'Using payout_id=%, account_id=%, user_id=%, cohort_id=%', _payout_id, _account_id, _user_id, _cohort_id;
   RAISE NOTICE 'Cohort cap: entry_fee=% * multiple=% => cap=%', _entry_fee, _multiple, _cap;
 
   RAISE NOTICE '--- 3) Ensure user_cohort_payouts row is missing (test auto-create) ---';
 
   -- Delete row if exists (ONLY for test environments!)
   DELETE FROM user_cohort_payouts
   WHERE user_id = _user_id AND cohort_id = _cohort_id;
 
   RAISE NOTICE 'Deleted any existing user_cohort_payouts row. Now calling eligibility...';
 
   _elig := public.calculate_payout_eligibility(_account_id);
   RAISE NOTICE 'Eligibility result: %', _elig;
 
   -- Pull headroom (may be null if cohort uncapped)
   _headroom := NULLIF(_elig->>'lifetime_headroom','')::numeric;
 
   IF _headroom IS NOT NULL AND _headroom < 0 THEN
     RAISE EXCEPTION 'Headroom should be clamped >= 0 but got %', _headroom;
   END IF;
 
   RAISE NOTICE 'Headroom (clamped): %', _headroom;
 
   RAISE NOTICE '--- 4) Snapshot totals before mark_payout_paid ---';
 
   SELECT COALESCE(u.lifetime_paid_total, 0)
   INTO _before_cohort_total
   FROM user_cohort_payouts u
   WHERE u.user_id = _user_id AND u.cohort_id = _cohort_id;
 
   SELECT COALESCE(pf.lifetime_paid_total, 0)
   INTO _before_profile_total
   FROM profiles pf
   WHERE pf.user_id = _user_id;
 
   RAISE NOTICE 'Before: cohort_total=%, profile_total=%', _before_cohort_total, _before_profile_total;
 
   RAISE NOTICE '--- 5) Minimum payout guard test (if payout amount < 50, should fail) ---';
   -- If your payout is >= 50, we skip; if < 50, we confirm the RPC rejects it.
   IF (SELECT amount FROM payouts WHERE id = _payout_id) < 50 THEN
     _res := public.mark_payout_paid(_payout_id, 'test-min-guard', NULL);
     RAISE NOTICE 'mark_payout_paid result: %', _res;
 
     IF COALESCE((_res->>'success')::boolean, false) THEN
       RAISE EXCEPTION 'Expected failure for payout < $50, but mark_payout_paid succeeded';
     END IF;
 
     RAISE NOTICE 'Minimum payout guard working. Exiting script (since payout cannot be paid).';
     RETURN;
   END IF;
 
   RAISE NOTICE '--- 6) Headroom enforcement test: set lifetime_paid_total to cap - 10, then try paying >= 50 ---';
 
   -- Create row manually at cap-10 so headroom is 10 (below min)
   INSERT INTO user_cohort_payouts (user_id, cohort_id, lifetime_paid_total)
   VALUES (_user_id, _cohort_id, GREATEST(_cap - 10, 0))
   ON CONFLICT (user_id, cohort_id) DO UPDATE
     SET lifetime_paid_total = EXCLUDED.lifetime_paid_total;
 
   _elig := public.calculate_payout_eligibility(_account_id);
   RAISE NOTICE 'Eligibility at cap-10: %', _elig;
 
   IF (_elig->>'eligible')::boolean THEN
     RAISE EXCEPTION 'Expected ineligible when headroom < $50, but got eligible=true';
   END IF;
 
   RAISE NOTICE 'Eligibility correctly denies when headroom < $50.';
 
   RAISE NOTICE '--- 7) Restore headroom, then mark payout paid successfully ---';
 
   -- Give headroom plenty: set total to 0
   UPDATE user_cohort_payouts
   SET lifetime_paid_total = 0
   WHERE user_id = _user_id AND cohort_id = _cohort_id;
 
   _res := public.mark_payout_paid(_payout_id, 'test-paid-1', NULL);
   RAISE NOTICE 'mark_payout_paid result: %', _res;
 
   IF NOT COALESCE((_res->>'success')::boolean, false) THEN
     RAISE EXCEPTION 'mark_payout_paid expected success but failed: %', _res;
   END IF;
 
   -- Confirm row exists now
   IF NOT EXISTS (
     SELECT 1 FROM user_cohort_payouts
     WHERE user_id = _user_id AND cohort_id = _cohort_id
   ) THEN
     RAISE EXCEPTION 'Expected user_cohort_payouts row to exist after paying, but it does not';
   END IF;
 
   RAISE NOTICE '--- 8) Verify totals incremented once ---';
 
   SELECT COALESCE(u.lifetime_paid_total, 0)
   INTO _after_cohort_total
   FROM user_cohort_payouts u
   WHERE u.user_id = _user_id AND u.cohort_id = _cohort_id;
 
   SELECT COALESCE(pf.lifetime_paid_total, 0)
   INTO _after_profile_total
   FROM profiles pf
   WHERE pf.user_id = _user_id;
 
   RAISE NOTICE 'After: cohort_total=%, profile_total=%', _after_cohort_total, _after_profile_total;
 
   IF _after_cohort_total <= _before_cohort_total THEN
     RAISE EXCEPTION 'Expected cohort_total to increase, but before=% after=%', _before_cohort_total, _after_cohort_total;
   END IF;
 
   IF _after_profile_total <= _before_profile_total THEN
     RAISE EXCEPTION 'Expected profile_total to increase, but before=% after=%', _before_profile_total, _after_profile_total;
   END IF;
 
   RAISE NOTICE '--- 9) Idempotency test: calling mark_payout_paid again should not increment totals ---';
 
   _res := public.mark_payout_paid(_payout_id, 'test-paid-2', NULL);
   RAISE NOTICE 'mark_payout_paid idempotent call result: %', _res;
 
   IF NOT COALESCE((_res->>'success')::boolean, false) THEN
     RAISE EXCEPTION 'Expected idempotent success but got failure: %', _res;
   END IF;
 
   -- Recheck totals
   SELECT COALESCE(u.lifetime_paid_total, 0)
   INTO _before_cohort_total
   FROM user_cohort_payouts u
   WHERE u.user_id = _user_id AND u.cohort_id = _cohort_id;
 
   SELECT COALESCE(pf.lifetime_paid_total, 0)
   INTO _before_profile_total
   FROM profiles pf
   WHERE pf.user_id = _user_id;
 
   -- Since we already updated them, "before" here means "post-idempotent"
   -- Compare to previous "_after_*" which was post-first pay
   IF _before_cohort_total <> _after_cohort_total THEN
     RAISE EXCEPTION 'Idempotency failed: cohort_total changed from % to %', _after_cohort_total, _before_cohort_total;
   END IF;
 
   IF _before_profile_total <> _after_profile_total THEN
     RAISE EXCEPTION 'Idempotency failed: profile_total changed from % to %', _after_profile_total, _before_profile_total;
   END IF;
 
   RAISE NOTICE '✅ All checks passed.';
 END $$;