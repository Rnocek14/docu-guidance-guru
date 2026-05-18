-- ============================================================
-- P1-8 Test #1 — Hash chain integrity after refund
--
-- Regression guard for the two hash-chain bugs hit during P0-2:
--   - per-payout audit rows previously inserted with user_id = NULL then
--     UPDATEd, silently invalidating row_hash.
--   - cascading prev_hash breaks in verify_audit_chain.
--
-- WHAT IT DOES:
--   1. Creates one evaluation account + 2 'approved' payouts on it.
--   2. Inserts a matching payment_transactions row (purpose =
--      'evaluation_purchase', metadata.account_id set).
--   3. Calls handle_charge_refunded() — should cancel both payouts.
--   4. Runs verify_audit_chain() over the window covering the refund;
--      asserts valid = true.
--
-- HOW TO RUN: paste into the Supabase SQL Editor as the service_role.
--   Wrap in BEGIN; ... ROLLBACK; to avoid leaving test fixtures behind.
-- ============================================================

BEGIN;

DO $$
DECLARE
  _user_id uuid;
  _cohort_id uuid;
  _account_id uuid := gen_random_uuid();
  _payout_a uuid := gen_random_uuid();
  _payout_b uuid := gen_random_uuid();
  _charge_id text := 'ch_p18_hashchain_' || substr(gen_random_uuid()::text, 1, 8);
  _pi_id text := 'pi_p18_hashchain_' || substr(gen_random_uuid()::text, 1, 8);
  _session_id text := 'cs_p18_hashchain_' || substr(gen_random_uuid()::text, 1, 8);
  _window_start timestamptz := now();
  _refund_result jsonb;
  _verify_result jsonb;
BEGIN
  -- Pick any existing user + active cohort to satisfy FKs/constraints.
  SELECT user_id INTO _user_id FROM accounts LIMIT 1;
  SELECT id INTO _cohort_id FROM cohorts WHERE is_active = true LIMIT 1;
  IF _user_id IS NULL OR _cohort_id IS NULL THEN
    RAISE EXCEPTION 'Need at least one user + active cohort to run this test';
  END IF;

  -- Fixture account
  INSERT INTO accounts (id, user_id, cohort_id, account_number, status,
                        provider, provider_session_id, provider_payment_id)
  VALUES (_account_id, _user_id, _cohort_id, 'P18-HC-' || substr(_account_id::text, 1, 8),
          'passed', 'stripe', _session_id, _pi_id);

  -- Two approved payouts
  INSERT INTO payouts (id, account_id, amount, status)
  VALUES (_payout_a, _account_id, 500, 'approved'),
         (_payout_b, _account_id, 750, 'approved');

  -- Payment transaction the refund will resolve to
  INSERT INTO payment_transactions (user_id, provider, provider_payment_id,
                                    direction, purpose, amount, currency,
                                    status, metadata)
  VALUES (_user_id, 'stripe', _pi_id, 'inbound', 'evaluation_purchase',
          50000, 'USD', 'succeeded',
          jsonb_build_object('account_id', _account_id::text,
                             'stripe_session_id', _session_id));

  -- Trigger the refund handler
  _refund_result := handle_charge_refunded(_charge_id, _pi_id, 50000, 'USD');

  IF (_refund_result ->> 'ok')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'handle_charge_refunded returned not-ok: %', _refund_result;
  END IF;
  IF (_refund_result ->> 'cancelled_payouts_count')::int <> 2 THEN
    RAISE EXCEPTION 'Expected 2 cancelled payouts, got %: %',
      _refund_result ->> 'cancelled_payouts_count', _refund_result;
  END IF;

  -- The big assertion: chain still valid across the refund window.
  _verify_result := verify_audit_chain(_window_start, now());

  IF (_verify_result ->> 'valid')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'verify_audit_chain INVALID after refund: %', _verify_result;
  END IF;

  RAISE NOTICE 'PASS — hash chain remained valid after refund. rows_checked=%, cancelled=%',
    _verify_result ->> 'rows_checked',
    _refund_result ->> 'cancelled_payouts_count';
END $$;

ROLLBACK;