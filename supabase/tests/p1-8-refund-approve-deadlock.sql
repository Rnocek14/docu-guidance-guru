-- ============================================================
-- P1-8 Test #5 — Concurrent approve+refund deadlock guard
--
-- Locks in the canonical lock order established by the P0-2 batch:
--   payouts (ORDER BY id) → accounts
-- Both handle_charge_refunded and approve_payout_atomic must acquire
-- these in the same order. If a future change reverses the order on
-- either side, this test deadlocks (SQLSTATE 40P01) within ~5 seconds.
--
-- ─── HOW TO RUN (2-session, manual orchestration) ───────────
--
-- COVERAGE: this variant catches a regression in handle_charge_refunded's
-- internal lock order (Tab B calls the real RPC; Tab A is hardcoded to
-- the canonical payouts → accounts order). To also catch a regression on
-- the approve side, a follow-up variant should replace Tab A's manual
-- sequence with `SELECT approve_payout_atomic(<payout_id>, ...)` so both
-- sides of the lock-order contract are exercised against real RPCs.
--
-- This requires real concurrent transactions, so it cannot run inside
-- a single DO block. Run from two separate SQL Editor tabs as
-- service_role.
--
-- TAB A — paste and run first (will block ~5s holding payouts lock):
--   BEGIN;
--   -- pretend we are mid-approve: lock payouts row first
--   SELECT id FROM payouts
--     WHERE id = '<PAYOUT_ID>' FOR UPDATE;
--   SELECT pg_sleep(5);
--   -- now try to lock the account (canonical order: payouts → accounts)
--   SELECT id FROM accounts WHERE id = '<ACCOUNT_ID>' FOR UPDATE;
--   COMMIT;
--
-- TAB B — paste IMMEDIATELY after Tab A (within 5s window):
--   SELECT handle_charge_refunded('ch_test', '<PAYMENT_INTENT>', 50000, 'USD');
--
-- EXPECTED:
--   Both transactions succeed. Tab B blocks on Tab A's payout lock, then
--   proceeds in order once Tab A commits. NEITHER returns SQLSTATE 40P01
--   (deadlock_detected). If you see 40P01, the lock order regressed.
--
-- ─── FIXTURE BUILDER (run once before the 2-tab test) ───────
-- Copy the printed IDs into the templates above, then run Tabs A + B.
-- Wrap in BEGIN; ... ROLLBACK; once done to clean up.
-- ============================================================

-- ── FIXTURE BUILDER ──────────────────────────────────────────
DO $$
DECLARE
  _user_id uuid;
  _cohort_id uuid;
  _account_id uuid := gen_random_uuid();
  _payout_id uuid := gen_random_uuid();
  _pi_id text := 'pi_p18_dl_' || substr(gen_random_uuid()::text, 1, 8);
  _session_id text := 'cs_p18_dl_' || substr(gen_random_uuid()::text, 1, 8);
BEGIN
  SELECT user_id INTO _user_id FROM accounts LIMIT 1;
  SELECT id INTO _cohort_id FROM cohorts WHERE is_active = true LIMIT 1;
  IF _user_id IS NULL OR _cohort_id IS NULL THEN
    RAISE EXCEPTION 'Need user + active cohort';
  END IF;

  INSERT INTO accounts (id, user_id, cohort_id, account_number, status,
                        provider, provider_session_id, provider_payment_id)
  VALUES (_account_id, _user_id, _cohort_id, 'P18-DL-' || substr(_account_id::text, 1, 8),
          'passed', 'stripe', _session_id, _pi_id);

  INSERT INTO payouts (id, account_id, amount, status)
  VALUES (_payout_id, _account_id, 500, 'approved');

  INSERT INTO payment_transactions (user_id, provider, provider_payment_id,
                                    direction, purpose, amount, currency,
                                    status, metadata)
  VALUES (_user_id, 'stripe', _pi_id, 'inbound', 'evaluation_purchase',
          50000, 'USD', 'succeeded',
          jsonb_build_object('account_id', _account_id::text,
                             'stripe_session_id', _session_id));

  RAISE NOTICE '── COPY THESE INTO THE 2-TAB SCRIPT ABOVE ──';
  RAISE NOTICE 'ACCOUNT_ID       = %', _account_id;
  RAISE NOTICE 'PAYOUT_ID        = %', _payout_id;
  RAISE NOTICE 'PAYMENT_INTENT   = %', _pi_id;
  RAISE NOTICE 'STRIPE_SESSION   = %', _session_id;
  RAISE NOTICE '────────────────────────────────────────────';
  RAISE NOTICE 'Then in Tab A:  BEGIN; SELECT FROM payouts WHERE id=''%'' FOR UPDATE;', _payout_id;
  RAISE NOTICE '                SELECT pg_sleep(5);';
  RAISE NOTICE '                SELECT FROM accounts WHERE id=''%'' FOR UPDATE; COMMIT;', _account_id;
  RAISE NOTICE 'In Tab B:       SELECT handle_charge_refunded(''ch_dl_test'', ''%'', 50000, ''USD'');', _pi_id;
  RAISE NOTICE 'Pass criterion: neither tab returns SQLSTATE 40P01 (deadlock_detected).';
END $$;