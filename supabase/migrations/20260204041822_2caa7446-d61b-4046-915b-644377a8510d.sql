-- ============================================
-- Reconciliation Runs History Table
-- Stores complete reconciliation results for audit/dispute defense
-- ============================================

CREATE TABLE IF NOT EXISTS public.reconciliation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  platform_account_id text NOT NULL,
  from_ts timestamptz NOT NULL,
  to_ts timestamptz NOT NULL,
  summary jsonb NOT NULL,
  missing_in_db jsonb NOT NULL DEFAULT '[]'::jsonb,
  extra_in_db jsonb NOT NULL DEFAULT '[]'::jsonb,
  mismatched jsonb NOT NULL DEFAULT '[]'::jsonb,
  invalid_external jsonb NOT NULL DEFAULT '[]'::jsonb,
  integrity_hash text NOT NULL,
  request_id uuid NOT NULL,
  created_by uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Unique constraint for idempotency (same request_id = same reconciliation run)
CREATE UNIQUE INDEX IF NOT EXISTS uq_reconciliation_runs_account_request
ON public.reconciliation_runs (account_id, request_id);

-- Index for querying by account
CREATE INDEX IF NOT EXISTS idx_reconciliation_runs_account_id
ON public.reconciliation_runs (account_id);

-- Index for querying by time range
CREATE INDEX IF NOT EXISTS idx_reconciliation_runs_created_at
ON public.reconciliation_runs (created_at DESC);

-- Enable RLS
ALTER TABLE public.reconciliation_runs ENABLE ROW LEVEL SECURITY;

-- Staff can view reconciliation runs
CREATE POLICY "Staff can view reconciliation runs"
ON public.reconciliation_runs
FOR SELECT
USING (has_any_role(auth.uid(), ARRAY['risk_officer'::app_role, 'support'::app_role, 'admin'::app_role]));

-- No client inserts on reconciliation_runs (only edge function via service role)
CREATE POLICY "No client inserts on reconciliation_runs"
ON public.reconciliation_runs
FOR INSERT
WITH CHECK (false);

-- No client updates on reconciliation_runs (immutable audit trail)
CREATE POLICY "No client updates on reconciliation_runs"
ON public.reconciliation_runs
FOR UPDATE
USING (false);

-- No client deletes on reconciliation_runs (immutable audit trail)
CREATE POLICY "No client deletes on reconciliation_runs"
ON public.reconciliation_runs
FOR DELETE
USING (false);

COMMENT ON TABLE public.reconciliation_runs IS 'Immutable history of trade reconciliation runs for audit/dispute defense';
COMMENT ON COLUMN public.reconciliation_runs.integrity_hash IS 'SHA-256 hash of canonical result JSON for tamper detection';
COMMENT ON COLUMN public.reconciliation_runs.summary IS 'Counts: external_count, internal_count, matched_count, missing_in_db_count, extra_in_db_count, mismatched_count, invalid_external_count';