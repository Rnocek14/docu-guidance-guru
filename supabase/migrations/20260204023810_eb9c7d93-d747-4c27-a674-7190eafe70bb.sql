-- P0-1 + P0-2: Violation trade linkage and hybrid deduplication
-- This enables dispute-grade audit trails by linking violations to triggering trades

-- A) Add linkage columns
ALTER TABLE public.violations
ADD COLUMN IF NOT EXISTS trade_id uuid NULL REFERENCES public.trades(id);

ALTER TABLE public.violations
ADD COLUMN IF NOT EXISTS platform_trade_id text NULL;

-- B) Add breach_day as a regular column (populated by application code)
-- Cannot use GENERATED because timestamptz::date depends on session timezone
ALTER TABLE public.violations
ADD COLUMN IF NOT EXISTS breach_day date NULL;

-- C) Hybrid dedupe indexes
-- 1) When trade_id exists → unique per trade (prevents duplicate breach from same trade)
CREATE UNIQUE INDEX IF NOT EXISTS uq_violations_account_rule_trade
ON public.violations(account_id, rule_type, trade_id)
WHERE trade_id IS NOT NULL;

-- 2) When trade_id is null → unique per day (prevents spam duplicates for aggregate breaches)
CREATE UNIQUE INDEX IF NOT EXISTS uq_violations_account_rule_day_null_trade
ON public.violations(account_id, rule_type, breach_day)
WHERE trade_id IS NULL;

-- D) Add index for efficient trade lookups in evidence pack joins
CREATE INDEX IF NOT EXISTS idx_violations_trade_id
ON public.violations(trade_id)
WHERE trade_id IS NOT NULL;