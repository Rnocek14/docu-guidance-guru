UPDATE econ_breaker_state 
SET breaker_level = 'normal',
    evaluations_frozen = false,
    approvals_blocked = false,
    payouts_blocked = false,
    previous_level = 'emergency',
    triggered_by = 'seed-reset',
    updated_at = now()
WHERE id = '00000000-0000-0000-0000-000000000001';