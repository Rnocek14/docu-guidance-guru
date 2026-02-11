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
    rolling_total_count = 100
WHERE id = '00000000-0000-0000-0000-000000000001';