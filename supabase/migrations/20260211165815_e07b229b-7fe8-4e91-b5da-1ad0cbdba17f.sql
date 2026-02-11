
-- Step 1: Reset breaker to normal
UPDATE econ_breaker_state
SET breaker_level = 'normal',
    evaluations_frozen = false,
    approvals_blocked = false,
    payouts_blocked = false,
    previous_level = 'emergency',
    triggered_by = 'manual_reset_for_seed',
    updated_at = now()
WHERE id = '00000000-0000-0000-0000-000000000001';

-- Step 2: Disable USER triggers on accounts and payouts
ALTER TABLE accounts DISABLE TRIGGER USER;
ALTER TABLE payouts DISABLE TRIGGER USER;

-- Step 3: Clean partial SEEDV2 data
DELETE FROM payout_payments pp
USING payouts p, accounts a
WHERE pp.payout_id = p.id AND p.account_id = a.id AND a.account_number LIKE 'SEEDV2-%';

DELETE FROM payouts p
USING accounts a
WHERE p.account_id = a.id AND a.account_number LIKE 'SEEDV2-%';

DELETE FROM account_daily_stats ads
USING accounts a
WHERE ads.account_id = a.id AND a.account_number LIKE 'SEEDV2-%';

DELETE FROM violations v
USING accounts a
WHERE v.account_id = a.id AND a.account_number LIKE 'SEEDV2-%';

DELETE FROM account_events e
USING accounts a
WHERE e.account_id = a.id AND a.account_number LIKE 'SEEDV2-%';

DELETE FROM account_phase_transitions apt
USING accounts a
WHERE (apt.from_account_id = a.id OR apt.to_account_id = a.id) AND a.account_number LIKE 'SEEDV2-%';

DELETE FROM flags f
USING accounts a
WHERE f.account_id = a.id AND a.account_number LIKE 'SEEDV2-%';

DELETE FROM risk_scores rs
USING accounts a
WHERE rs.account_id = a.id AND a.account_number LIKE 'SEEDV2-%';

DELETE FROM reconciliation_runs rr
USING accounts a
WHERE rr.account_id = a.id AND a.account_number LIKE 'SEEDV2-%';

DELETE FROM platform_accounts pa
USING accounts a
WHERE pa.account_id = a.id AND a.account_number LIKE 'SEEDV2-%';

DELETE FROM audit_logs al
USING accounts a
WHERE al.account_id = a.id AND a.account_number LIKE 'SEEDV2-%';

DELETE FROM trades t
USING accounts a
WHERE t.account_id = a.id AND a.account_number LIKE 'SEEDV2-%';

DELETE FROM accounts WHERE account_number LIKE 'SEEDV2-%';

-- Step 4: Re-enable triggers
ALTER TABLE accounts ENABLE TRIGGER USER;
ALTER TABLE payouts ENABLE TRIGGER USER;
