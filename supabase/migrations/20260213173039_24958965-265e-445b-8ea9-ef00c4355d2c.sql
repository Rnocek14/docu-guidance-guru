
-- P0 FIX 1: Set cash reserve to realistic launch value ($15,000)
-- and threshold to $5,000 (alert when net buffer drops below this)
UPDATE liability_alerts
SET cash_reserve = 15000,
    threshold = 5000,
    last_state = 'ok',
    last_triggered_at = NULL,
    updated_at = now();

-- P0 FIX 2: Reset econ_breaker_state to clean production baseline
-- All metrics zeroed, level normal, no seed contamination
UPDATE econ_breaker_state
SET breaker_level = 'normal',
    rolling_pass_rate = 0,
    rolling_pass_count = 0,
    rolling_total_count = 0,
    net_buffer = 15000,
    pending_liability = 0,
    payouts_blocked = false,
    approvals_blocked = false,
    evaluations_frozen = false,
    previous_level = NULL,
    triggered_by = 'pre_launch_reset',
    last_evaluated_at = now(),
    updated_at = now();
