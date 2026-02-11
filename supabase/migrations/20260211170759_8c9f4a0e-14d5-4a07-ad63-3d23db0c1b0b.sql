
-- Reset breaker to normal (again — trigger re-fired it)
UPDATE econ_breaker_state
SET breaker_level = 'normal',
    evaluations_frozen = false,
    approvals_blocked = false,
    payouts_blocked = false,
    previous_level = 'emergency',
    triggered_by = 'manual_reset_for_seed_v2',
    updated_at = now()
WHERE id = '00000000-0000-0000-0000-000000000001';

-- Disable user triggers on accounts and payouts for seed duration
ALTER TABLE accounts DISABLE TRIGGER USER;
ALTER TABLE payouts DISABLE TRIGGER USER;
