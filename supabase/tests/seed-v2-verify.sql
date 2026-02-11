-- ============================================================
-- POST-SEED VERIFICATION QUERIES
-- ============================================================
-- Run after seed-demo-data to confirm all integrity invariants.
-- Every query MUST return 0 rows when seeding is correct.
-- ============================================================

-- V1: Breached/failed SEEDV2 accounts without violation records
SELECT 'V1_BREACHED_NO_VIOLATION' as check_name, a.id, a.account_number, a.status
FROM accounts a
WHERE a.account_number LIKE 'SEEDV2-%'
  AND a.status IN ('breached_detected', 'failed_confirmed')
  AND NOT EXISTS (SELECT 1 FROM violations v WHERE v.account_id = a.id);

-- V2: SEEDV2 accounts with no events at all
SELECT 'V2_NO_EVENTS' as check_name, a.id, a.account_number, a.status
FROM accounts a
WHERE a.account_number LIKE 'SEEDV2-%'
  AND NOT EXISTS (SELECT 1 FROM account_events ae WHERE ae.account_id = a.id);

-- V3: SEEDV2 Veri/Perf accounts without lineage
SELECT 'V3_MISSING_LINEAGE' as check_name, a.id, a.account_number, c.cohort_phase
FROM accounts a JOIN cohorts c ON c.id = a.cohort_id
WHERE a.account_number LIKE 'SEEDV2-%'
  AND c.cohort_phase IN ('verification', 'performance')
  AND (a.root_account_id IS NULL OR a.parent_account_id IS NULL);

-- V4: SEEDV2 accounts with trades but no daily stats
SELECT 'V4_TRADES_NO_STATS' as check_name, a.id, a.account_number, t.cnt as trade_count
FROM accounts a
CROSS JOIN LATERAL (SELECT count(*) as cnt FROM trades t WHERE t.account_id = a.id) t
WHERE a.account_number LIKE 'SEEDV2-%'
  AND t.cnt > 0
  AND NOT EXISTS (SELECT 1 FROM account_daily_stats ads WHERE ads.account_id = a.id);

-- V5: SEEDV2 paid payouts without payment trail
SELECT 'V5_PAID_NO_TRAIL' as check_name, p.id as payout_id, p.status, a.account_number
FROM payouts p
JOIN accounts a ON a.id = p.account_id
WHERE a.account_number LIKE 'SEEDV2-%'
  AND p.status IN ('paid', 'paid_confirmed')
  AND NOT EXISTS (SELECT 1 FROM payout_payments pp WHERE pp.payout_id = p.id);

-- V6: SEEDV2 passed accounts without phase transitions OUT (eval/veri only)
SELECT 'V6_PASSED_NO_TRANSITION' as check_name, a.id, a.account_number, c.cohort_phase
FROM accounts a
JOIN cohorts c ON c.id = a.cohort_id
WHERE a.account_number LIKE 'SEEDV2-%'
  AND a.passed_at IS NOT NULL
  AND c.cohort_phase IN ('evaluation', 'verification')
  AND NOT EXISTS (SELECT 1 FROM account_phase_transitions apt WHERE apt.from_account_id = a.id);

-- V7: SEEDV2 accounts missing rule_snapshot
SELECT 'V7_NO_RULE_SNAPSHOT' as check_name, a.id, a.account_number, a.status
FROM accounts a
WHERE a.account_number LIKE 'SEEDV2-%'
  AND a.rule_snapshot IS NULL
  AND a.status NOT IN ('closed');

-- V8: Financial drift — profile lifetime_paid_total vs actual paid payouts
SELECT 'V8_TOTAL_DRIFT' as check_name, p.user_id, p.email,
  p.lifetime_paid_total as profile_total,
  COALESCE(s.total, 0) as actual_sum,
  p.lifetime_paid_total - COALESCE(s.total, 0) as drift
FROM profiles p
CROSS JOIN LATERAL (
  SELECT SUM(pay.amount) as total FROM payouts pay
  JOIN accounts a ON a.id = pay.account_id
  WHERE a.user_id = p.user_id
    AND a.account_number LIKE 'SEEDV2-%'
    AND pay.status IN ('paid', 'paid_confirmed')
) s
WHERE p.lifetime_paid_total != COALESCE(s.total, 0)
  AND EXISTS (SELECT 1 FROM accounts a2 WHERE a2.user_id = p.user_id AND a2.account_number LIKE 'SEEDV2-%');

-- SUMMARY: Count of all violations (should be 0)
SELECT 'SUMMARY' as check_name,
  (SELECT count(*) FROM accounts a WHERE a.account_number LIKE 'SEEDV2-%'
    AND a.status IN ('breached_detected','failed_confirmed')
    AND NOT EXISTS (SELECT 1 FROM violations v WHERE v.account_id = a.id)) as v1_fails,
  (SELECT count(*) FROM accounts a WHERE a.account_number LIKE 'SEEDV2-%'
    AND NOT EXISTS (SELECT 1 FROM account_events ae WHERE ae.account_id = a.id)) as v2_fails,
  (SELECT count(*) FROM accounts a JOIN cohorts c ON c.id = a.cohort_id
    WHERE a.account_number LIKE 'SEEDV2-%' AND c.cohort_phase IN ('verification','performance')
    AND (a.root_account_id IS NULL OR a.parent_account_id IS NULL)) as v3_fails;
