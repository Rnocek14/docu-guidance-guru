
-- Add clean_evaluated_at column for audit trail
ALTER TABLE public.payouts ADD COLUMN IF NOT EXISTS clean_evaluated_at timestamptz;
