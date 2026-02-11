-- Reset breaker AND fix the economics that trigger it
UPDATE econ_breaker_state 
SET breaker_level = 'normal',
    evaluations_frozen = false,
    approvals_blocked = false,
    payouts_blocked = false,
    previous_level = NULL,
    triggered_by = 'manual-seed-reset',
    updated_at = now(),
    last_evaluated_at = now(),
    rolling_pass_rate = 50,
    rolling_pass_count = 50,
    rolling_total_count = 100,
    net_buffer = 10000,
    pending_liability = 0
WHERE id = '00000000-0000-0000-0000-000000000001';

-- Also temporarily disable the breaker evaluation trigger during seeding
ALTER TABLE accounts DISABLE TRIGGER trg_account_breaker_eval;
ALTER TABLE accounts DISABLE TRIGGER trg_breaker_block_account_create;