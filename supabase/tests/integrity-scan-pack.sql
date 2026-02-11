-- ============================================================
-- INTEGRITY SCAN PACK v2.0
-- ============================================================
-- Run periodically (recommended: daily cron) to detect invariant breaks.
-- Every query MUST return 0 rows when the system is healthy.
-- Any non-zero result is a P0 alert requiring immediate investigation.
-- ============================================================
-- v2.0 changes:
--   - Fixed I4: split into I4a (transition OUT) and I4b (transition IN)
--   - Added I20: Trades present but no daily stats
--   - Added I21: Payout status transition without matching audit log
--   - Corrected column references (rule_type not rule_key)
-- ============================================================

-- =============================
-- SECTION 1: STATE CONSISTENCY
-- =============================

-- I1: Active accounts exceeding drawdown limit
-- Risk: Account should have been breached but wasn't
SELECT 'I1_ACTIVE_EXCEEDS_DRAWDOWN' as invariant, a.id, a.account_number, a.status,
  round(((a.highest_balance - a.current_balance) / NULLIF(a.highest_balance,0) * 100)::numeric, 2) as actual_dd_pct,
  c.max_total_drawdown_percent as limit_pct
FROM accounts a JOIN cohorts c ON c.id = a.cohort_id
WHERE a.status = 'active'
  AND ((a.highest_balance - a.current_balance) / NULLIF(a.highest_balance,0) * 100) > c.max_total_drawdown_percent;

-- I2: Breached/failed accounts without violation records
-- Risk: No dispute defense evidence
SELECT 'I2_BREACHED_NO_VIOLATION' as invariant, a.id, a.account_number, a.status
FROM accounts a
WHERE a.status IN ('breached_detected', 'failed_confirmed')
  AND NOT EXISTS (SELECT 1 FROM violations v WHERE v.account_id = a.id);

-- I3: Verification/Performance accounts without lineage
-- Risk: Lifetime cap calculation breaks (walks root chain)
SELECT 'I3_MISSING_LINEAGE' as invariant, a.id, a.account_number, c.cohort_phase
FROM accounts a JOIN cohorts c ON c.id = a.cohort_id
WHERE c.cohort_phase IN ('verification', 'performance')
  AND (a.root_account_id IS NULL OR a.parent_account_id IS NULL);

-- I4a: Passed eval/veri accounts without a transition OUT
-- Risk: Graduation didn't spawn next-phase account
-- Semantics: from_account_id = this passed account
SELECT 'I4a_PASSED_NO_TRANSITION_OUT' as invariant, a.id, a.account_number, a.passed_at, c.cohort_phase
FROM accounts a
JOIN cohorts c ON c.id = a.cohort_id
WHERE a.passed_at IS NOT NULL
  AND c.cohort_phase IN ('evaluation', 'verification')
  AND NOT EXISTS (SELECT 1 FROM account_phase_transitions apt WHERE apt.from_account_id = a.id);

-- I4b: Veri/perf accounts without a transition IN
-- Risk: Spawned account has no traceable origin
-- Semantics: to_account_id = this spawned account
SELECT 'I4b_SPAWNED_NO_TRANSITION_IN' as invariant, a.id, a.account_number, c.cohort_phase
FROM accounts a
JOIN cohorts c ON c.id = a.cohort_id
WHERE c.cohort_phase IN ('verification', 'performance')
  AND NOT EXISTS (SELECT 1 FROM account_phase_transitions apt WHERE apt.to_account_id = a.id);

-- I5: Accounts missing rule_snapshot
-- Risk: Breach detection cannot function, rules mutable
SELECT 'I5_NO_RULE_SNAPSHOT' as invariant, a.id, a.account_number, a.status
FROM accounts a WHERE a.rule_snapshot IS NULL AND a.status NOT IN ('closed');

-- =============================
-- SECTION 2: FINANCIAL INTEGRITY
-- =============================

-- I6: Profile lifetime_paid_total ≠ sum of paid payouts
-- Risk: Financial reporting drift, cap enforcement incorrect
SELECT 'I6_TOTAL_DRIFT' as invariant, p.user_id, p.email,
  p.lifetime_paid_total as profile_total,
  COALESCE(s.total, 0) as actual_paid_sum,
  p.lifetime_paid_total - COALESCE(s.total, 0) as drift
FROM profiles p
CROSS JOIN LATERAL (
  SELECT SUM(pay.amount) as total FROM payouts pay
  JOIN accounts a ON a.id = pay.account_id
  WHERE a.user_id = p.user_id AND pay.status IN ('paid', 'paid_confirmed')
) s
WHERE p.lifetime_paid_total != COALESCE(s.total, 0);

-- I7: user_cohort_payouts total ≠ cohort-scoped paid payouts
-- Risk: Per-cohort cap enforcement incorrect
SELECT 'I7_COHORT_TOTAL_DRIFT' as invariant, ucp.user_id, ucp.cohort_id,
  ucp.lifetime_paid_total as cohort_total,
  COALESCE(s.total, 0) as actual_sum,
  ucp.lifetime_paid_total - COALESCE(s.total, 0) as drift
FROM user_cohort_payouts ucp
CROSS JOIN LATERAL (
  SELECT SUM(pay.amount) as total FROM payouts pay
  JOIN accounts a ON a.id = pay.account_id
  WHERE a.user_id = ucp.user_id AND pay.status IN ('paid', 'paid_confirmed')
    AND a.cohort_id = ucp.cohort_id
) s
WHERE ucp.lifetime_paid_total != COALESCE(s.total, 0);

-- I8: Paid payouts without payment trail (payout_payments)
-- Risk: No reconciliation evidence, money moved without trail
SELECT 'I8_PAID_NO_PAYMENT_TRAIL' as invariant, p.id as payout_id, p.status,
  p.payment_reference, p.paid_at, a.account_number
FROM payouts p JOIN accounts a ON a.id = p.account_id
WHERE p.status IN ('paid', 'paid_confirmed')
  AND NOT EXISTS (SELECT 1 FROM payout_payments pp WHERE pp.payout_id = p.id);

-- I9: Paid payouts without payment_reference
-- Risk: Reconciliation impossible (CHECK constraint should catch this)
SELECT 'I9_PAID_NO_REFERENCE' as invariant, p.id, p.status, p.paid_at
FROM payouts p WHERE p.status IN ('paid', 'paid_confirmed') AND p.payment_reference IS NULL;

-- I10: Paid payouts without paid_at timestamp
SELECT 'I10_PAID_NO_TIMESTAMP' as invariant, p.id, p.status, p.payment_reference
FROM payouts p WHERE p.status IN ('paid', 'paid_confirmed') AND p.paid_at IS NULL;

-- =============================
-- SECTION 3: AUDIT COMPLETENESS
-- =============================

-- I11: Accounts with no events at all
-- Risk: Trader timeline empty, lifecycle not recorded
SELECT 'I11_NO_EVENTS' as invariant, a.id, a.account_number, a.status
FROM accounts a
WHERE NOT EXISTS (SELECT 1 FROM account_events ae WHERE ae.account_id = a.id);

-- I12: Terminal state changes without audit log
-- Risk: Staff actions untracked, tamper detection impossible
SELECT 'I12_TERMINAL_NO_AUDIT' as invariant, a.id, a.account_number, a.status
FROM accounts a
WHERE a.status IN ('failed_confirmed', 'payout_approved')
  AND NOT EXISTS (
    SELECT 1 FROM audit_logs al
    WHERE al.account_id = a.id
      AND al.action IN ('failure_confirmed', 'payout_approved', 'status_changed')
  );

-- I13: Payout status changes without audit
SELECT 'I13_PAYOUT_NO_AUDIT' as invariant, p.id, p.status, a.account_number
FROM payouts p JOIN accounts a ON a.id = p.account_id
WHERE p.status NOT IN ('pending')
  AND NOT EXISTS (
    SELECT 1 FROM audit_logs al
    WHERE al.account_id = a.id
      AND al.action IN ('payout_approved', 'payout_rejected', 'payout_paid', 'status_changed')
  );

-- =============================
-- SECTION 4: DAILY STATS COVERAGE
-- =============================

-- I14: Accounts with trading_days_count > 0 but no daily stats
-- Risk: Equity curves empty, consistency checks unreliable
SELECT 'I14_TRADING_NO_STATS' as invariant, a.id, a.account_number,
  a.trading_days_count, a.status
FROM accounts a
WHERE a.trading_days_count > 0
  AND NOT EXISTS (SELECT 1 FROM account_daily_stats ads WHERE ads.account_id = a.id);

-- I15: Daily stats count doesn't match trading_days_count
-- Warning only — can diverge if stats cover non-trading days
SELECT 'I15_STATS_COUNT_MISMATCH' as invariant, a.id, a.account_number,
  a.trading_days_count as expected, count(ads.id) as actual
FROM accounts a
JOIN account_daily_stats ads ON ads.account_id = a.id
GROUP BY a.id, a.account_number, a.trading_days_count
HAVING count(ads.id) != a.trading_days_count;

-- =============================
-- SECTION 5: COHORT CHAIN INTEGRITY
-- =============================

-- I16: Broken cohort chains (next_cohort_id points to inactive/missing cohort)
SELECT 'I16_BROKEN_COHORT_CHAIN' as invariant, c.id, c.name, c.next_cohort_id
FROM cohorts c
WHERE c.next_cohort_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM cohorts nc WHERE nc.id = c.next_cohort_id AND nc.is_active = true);

-- I17: Performance cohorts without entry_fee on their root eval cohort
-- Risk: Lifetime cap = entry_fee * multiple → NULL cap if entry_fee missing
SELECT 'I17_NO_ENTRY_FEE_ROOT' as invariant, c.id, c.name, c.cohort_phase
FROM cohorts c
WHERE c.cohort_phase = 'evaluation' AND c.is_active = true
  AND (c.entry_fee IS NULL OR c.entry_fee <= 0);

-- =============================
-- SECTION 6: SECURITY INVARIANTS
-- =============================

-- I18: Payouts approved_by = paid_by (separation of duties violation)
-- Note: In demo this may be acceptable, in production it's a P1
SELECT 'I18_SEPARATION_VIOLATION' as invariant, p.id, p.approved_by, p.paid_by
FROM payouts p
WHERE p.status IN ('paid', 'paid_confirmed')
  AND p.approved_by IS NOT NULL AND p.paid_by IS NOT NULL
  AND p.approved_by = p.paid_by;

-- I19: KYC not verified but has paid payouts
-- Risk: AML/compliance exposure
SELECT 'I19_KYC_BYPASS' as invariant, pr.user_id, pr.kyc_status, count(p.id) as paid_count
FROM profiles pr
JOIN accounts a ON a.user_id = pr.user_id
JOIN payouts p ON p.account_id = a.id
WHERE p.status IN ('paid', 'paid_confirmed')
  AND pr.kyc_status != 'verified'
GROUP BY pr.user_id, pr.kyc_status;

-- =============================
-- SECTION 7: TRADE + STATS COVERAGE (NEW in v2)
-- =============================

-- I20: Accounts with trades but no daily stats
-- Risk: Equity curves empty, consistency enforcement blind
SELECT 'I20_TRADES_NO_STATS' as invariant, a.id, a.account_number,
  t.trade_count, a.status
FROM accounts a
CROSS JOIN LATERAL (
  SELECT count(*) as trade_count FROM trades t WHERE t.account_id = a.id
) t
WHERE t.trade_count > 0
  AND NOT EXISTS (SELECT 1 FROM account_daily_stats ads WHERE ads.account_id = a.id);

-- I21: Payout status transition without matching audit log entry
-- More specific than I13: checks each individual payout
SELECT 'I21_PAYOUT_STATUS_NO_AUDIT' as invariant, p.id as payout_id, p.status,
  a.account_number
FROM payouts p
JOIN accounts a ON a.id = p.account_id
WHERE p.status IN ('approved', 'payment_initiated', 'paid', 'paid_confirmed', 'rejected')
  AND NOT EXISTS (
    SELECT 1 FROM audit_logs al
    WHERE al.account_id = a.id
      AND (
        (p.status IN ('approved') AND al.action = 'payout_approved')
        OR (p.status IN ('rejected') AND al.action = 'payout_rejected')
        OR (p.status IN ('paid', 'paid_confirmed') AND al.action = 'payout_paid')
        OR (p.status = 'payment_initiated' AND al.action = 'status_changed')
      )
  );
