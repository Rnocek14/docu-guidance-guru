
-- 1) Add dedicated winning-days column for clarity
ALTER TABLE public.cohorts
ADD COLUMN IF NOT EXISTS min_winning_days_between_payouts integer DEFAULT NULL;

-- 2) Performance index for the winning-days query
CREATE INDEX IF NOT EXISTS idx_trades_account_closed_opened
ON public.trades (account_id, closed_at, opened_at);
