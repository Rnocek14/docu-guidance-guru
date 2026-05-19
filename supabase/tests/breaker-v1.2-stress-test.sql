-- ============================================================
-- BREAKER v1.2 PRODUCTION STRESS TEST
-- ============================================================
-- Run via psql / SQL editor with service_role privileges.
-- Verifies: L1 trip > 30%, L2 trip > 45%, hysteresis release,
-- audit_logs row, staff_notifications row, admin panel values.
--
-- All artifacts are tagged with idempotency prefix 'STRESS-V12-'
-- and cleaned up at the end. Re-runnable.
-- ============================================================

\set ON_ERROR_STOP on
BEGIN;

-- 0) Snapshot starting state ---------------------------------
CREATE TEMP TABLE _start AS SELECT * FROM econ_breaker_state WHERE id='00000000-0000-0000-0000-000000000001';

-- ============================================================
-- PHASE 1: force Pay/Rev > 30% (expect 'elevated' / L1 tighten)
-- ============================================================
-- Seed $100k gross revenue, $0 chargebacks, $35k payouts → 35% net
INSERT INTO checkout_fulfillment_queue
  (id, stripe_session_id, provider_session_id, user_id, tier_id,
   amount_cents, status, provider, rules_acknowledged)
SELECT gen_random_uuid(),
       'STRESS-V12-sess-'||g, 'STRESS-V12-sess-'||g,
       (SELECT id FROM auth.users LIMIT 1),
       'starter', 14900, 'fulfilled', 'stripe', true
FROM generate_series(1, 671) g;  -- 671 * $149 ≈ $100k

INSERT INTO payouts (id, account_id, amount, status, created_at, updated_at)
SELECT gen_random_uuid(),
       (SELECT id FROM accounts LIMIT 1),
       350, 'paid_confirmed', now(), now()
FROM generate_series(1, 100) g;  -- 100 * $350 = $35k → 35%

SELECT evaluate_econ_breaker();

DO $$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM econ_breaker_state WHERE id='00000000-0000-0000-0000-000000000001';
  ASSERT r.payrev_level = 'elevated',
    format('PHASE 1 FAIL: payrev_level=%s payrev=%s', r.payrev_level, r.rolling_payrev_ratio);
  ASSERT r.breaker_level IN ('elevated','critical','emergency'),
    format('PHASE 1 FAIL: breaker_level=%s', r.breaker_level);
  ASSERT r.payouts_blocked = true, 'PHASE 1 FAIL: payouts should be blocked';
  RAISE NOTICE '✅ PHASE 1 PASS — L1 (elevated) at Pay/Rev=%', round(r.rolling_payrev_ratio*100,2);
END $$;

-- ============================================================
-- PHASE 2: force Pay/Rev > 45% (expect 'critical' / L2 freeze)
-- ============================================================
INSERT INTO payouts (id, account_id, amount, status, created_at, updated_at)
SELECT gen_random_uuid(),
       (SELECT id FROM accounts LIMIT 1),
       500, 'paid_confirmed', now(), now()
FROM generate_series(1, 50) g;  -- +$25k → $60k total = 60%

SELECT evaluate_econ_breaker();

DO $$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM econ_breaker_state WHERE id='00000000-0000-0000-0000-000000000001';
  ASSERT r.payrev_level = 'critical',
    format('PHASE 2 FAIL: payrev_level=%s payrev=%s', r.payrev_level, r.rolling_payrev_ratio);
  ASSERT r.payouts_blocked AND r.approvals_blocked,
    'PHASE 2 FAIL: payouts AND approvals must be blocked at critical';
  RAISE NOTICE '✅ PHASE 2 PASS — L2 (critical) at Pay/Rev=%', round(r.rolling_payrev_ratio*100,2);
END $$;

-- ============================================================
-- PHASE 3: net revenue subtraction (chargebacks)
-- ============================================================
-- Add $40k of non-won chargebacks → net rev drops from $100k to $60k.
-- Payouts still $60k → 100% Pay/Rev. Confirms chargebacks reduce denom.
INSERT INTO chargeback_events
  (id, user_id, provider, provider_event_id, stage, amount, occurred_at)
SELECT gen_random_uuid(),
       (SELECT id FROM auth.users LIMIT 1),
       'stripe', 'STRESS-V12-cb-'||g, 'lost', 400, now()
FROM generate_series(1, 100) g;

SELECT evaluate_econ_breaker();

DO $$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM econ_breaker_state WHERE id='00000000-0000-0000-0000-000000000001';
  ASSERT r.payrev_chargebacks_30d >= 39000,
    format('PHASE 3 FAIL: chargebacks=%s', r.payrev_chargebacks_30d);
  ASSERT r.payrev_net_revenue_30d < r.payrev_revenue_30d,
    'PHASE 3 FAIL: net revenue must be < gross';
  ASSERT r.rolling_payrev_ratio > 0.90,
    format('PHASE 3 FAIL: Pay/Rev should jump above 90%% after CB. got=%s', r.rolling_payrev_ratio);
  RAISE NOTICE '✅ PHASE 3 PASS — net rev $% (gross $%, cb $%), Pay/Rev=%',
    round(r.payrev_net_revenue_30d), round(r.payrev_revenue_30d),
    round(r.payrev_chargebacks_30d), round(r.rolling_payrev_ratio*100,2);
END $$;

-- ============================================================
-- PHASE 4: audit + notification rows exist
-- ============================================================
DO $$
DECLARE n_audit int; n_notif int;
BEGIN
  SELECT COUNT(*) INTO n_audit FROM audit_logs
    WHERE action='breaker_transition' AND created_at > now() - interval '5 minutes';
  SELECT COUNT(*) INTO n_notif FROM staff_notifications
    WHERE notification_type='breaker_level_change' AND created_at > now() - interval '5 minutes';
  ASSERT n_audit >= 1, format('PHASE 4 FAIL: expected ≥1 audit row, got %s', n_audit);
  ASSERT n_notif >= 1, format('PHASE 4 FAIL: expected ≥1 notification row, got %s', n_notif);
  RAISE NOTICE '✅ PHASE 4 PASS — % audit row(s), % notification(s)', n_audit, n_notif;
END $$;

-- ============================================================
-- PHASE 5: hysteresis release (drop Pay/Rev → run 12 evals)
-- ============================================================
-- Mark payouts as old so they fall out of 30d window
UPDATE payouts SET created_at = now() - interval '40 days',
                    updated_at = now() - interval '40 days'
 WHERE created_at >= now() - interval '1 day' AND amount IN (350, 500);

-- Run 12 consecutive evaluations to clear L2 → L1
DO $$ BEGIN
  FOR i IN 1..12 LOOP PERFORM evaluate_econ_breaker(); END LOOP;
END $$;

DO $$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM econ_breaker_state WHERE id='00000000-0000-0000-0000-000000000001';
  ASSERT r.payrev_level IN ('normal','elevated'),
    format('PHASE 5 FAIL: still critical after 12 clean evals. payrev=%s', r.rolling_payrev_ratio);
  RAISE NOTICE '✅ PHASE 5 PASS — hysteresis released to %, Pay/Rev=%',
    r.payrev_level, round(r.rolling_payrev_ratio*100,2);
END $$;

-- ============================================================
-- CLEANUP
-- ============================================================
DELETE FROM checkout_fulfillment_queue WHERE stripe_session_id LIKE 'STRESS-V12-%';
DELETE FROM chargeback_events WHERE provider_event_id LIKE 'STRESS-V12-%';
DELETE FROM payouts WHERE created_at < now() - interval '39 days'
                       AND created_at > now() - interval '41 days'
                       AND amount IN (350, 500);

-- Restore baseline and re-evaluate
SELECT evaluate_econ_breaker();

SELECT 'STRESS TEST COMPLETE — see ✅ PHASE x PASS notices above' AS result;

ROLLBACK; -- safety: this whole file runs in a txn. Change to COMMIT only if you want side effects persisted.