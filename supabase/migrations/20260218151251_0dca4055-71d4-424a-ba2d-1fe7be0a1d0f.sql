
-- Fix drill residue: unpause inbound payments
UPDATE payment_system_state 
SET is_paused_inbound = false, 
    pause_reason = NULL,
    paused_at = NULL
WHERE is_paused_inbound = true;

-- Reset breaker to normal if elevated from drill
UPDATE econ_breaker_state 
SET breaker_level = 'normal',
    previous_level = breaker_level,
    payouts_blocked = false,
    approvals_blocked = false,
    evaluations_frozen = false,
    triggered_by = 'governor-drill-cleanup',
    updated_at = now()
WHERE breaker_level != 'normal';
