
ALTER TABLE public.accounts ENABLE TRIGGER trg_breaker_block_account_create;
ALTER TABLE public.accounts ENABLE TRIGGER trg_account_breaker_eval;
ALTER TABLE public.payouts ENABLE TRIGGER trg_breaker_enforce_payout_status;
ALTER TABLE public.payouts ENABLE TRIGGER trg_breaker_enforce_payout_status_insert;
ALTER TABLE public.payouts ENABLE TRIGGER trg_payout_breaker_eval_insert;
ALTER TABLE public.payouts ENABLE TRIGGER trg_payout_breaker_eval_update;
