-- Add timestamp_deltas column to reconciliation_runs
ALTER TABLE reconciliation_runs ADD COLUMN IF NOT EXISTS timestamp_deltas jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Add index for UI history page (account + created_at desc)
CREATE INDEX IF NOT EXISTS idx_reconciliation_runs_account_created 
ON reconciliation_runs (account_id, created_at DESC);