
-- Reset breaker to normal
UPDATE econ_breaker_state
SET breaker_level = 'normal',
    evaluations_frozen = false,
    approvals_blocked = false,
    payouts_blocked = false,
    pending_liability = 0,
    net_buffer = 50000,
    rolling_pass_rate = 0.15,
    rolling_pass_count = 3,
    rolling_total_count = 20,
    previous_level = NULL,
    triggered_by = NULL,
    updated_at = now()
WHERE id = '00000000-0000-0000-0000-000000000001';

-- Disable breaker triggers during seed
ALTER TABLE accounts DISABLE TRIGGER trg_breaker_block_account_create;
ALTER TABLE accounts DISABLE TRIGGER trg_account_breaker_eval;
