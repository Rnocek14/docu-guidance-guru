
-- Disable ALL breaker triggers for seed
ALTER TABLE public.payouts DISABLE TRIGGER trg_breaker_enforce_payout_status;
ALTER TABLE public.payouts DISABLE TRIGGER trg_breaker_enforce_payout_status_insert;
ALTER TABLE public.payouts DISABLE TRIGGER trg_payout_breaker_eval_insert;
ALTER TABLE public.payouts DISABLE TRIGGER trg_payout_breaker_eval_update;

-- Also ensure breaker state is clean
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
