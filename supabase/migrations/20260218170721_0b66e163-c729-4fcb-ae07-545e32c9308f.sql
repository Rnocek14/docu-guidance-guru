
-- CPC daily snapshots
CREATE TABLE public.cpc_snapshots (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  computed_at timestamptz NOT NULL DEFAULT now(),
  score numeric NOT NULL DEFAULT 0,
  band text NOT NULL DEFAULT 'low',
  realized_margin numeric NOT NULL DEFAULT 0,
  realized_margin_score numeric NOT NULL DEFAULT 0,
  buffer_coverage_ratio numeric NOT NULL DEFAULT 0,
  buffer_coverage_score numeric NOT NULL DEFAULT 0,
  pass_rate numeric NOT NULL DEFAULT 0,
  pass_rate_score numeric NOT NULL DEFAULT 0,
  monte_carlo_ruin_pct numeric NOT NULL DEFAULT 0,
  monte_carlo_score numeric NOT NULL DEFAULT 1,
  breaker_level text NOT NULL DEFAULT 'normal',
  breaker_penalty boolean NOT NULL DEFAULT false,
  revenue_30d numeric NOT NULL DEFAULT 0,
  payouts_30d numeric NOT NULL DEFAULT 0,
  pending_liability numeric NOT NULL DEFAULT 0,
  net_buffer numeric,
  source text NOT NULL DEFAULT 'cron',
  details jsonb NOT NULL DEFAULT '{}'::jsonb
);

-- Enable RLS
ALTER TABLE public.cpc_snapshots ENABLE ROW LEVEL SECURITY;

-- Staff read-only
CREATE POLICY "Staff can view CPC snapshots"
  ON public.cpc_snapshots FOR SELECT
  USING (has_any_role(auth.uid(), ARRAY['risk_officer'::app_role, 'admin'::app_role]));

CREATE POLICY "No client inserts on cpc_snapshots"
  ON public.cpc_snapshots FOR INSERT
  WITH CHECK (false);

CREATE POLICY "No client updates on cpc_snapshots"
  ON public.cpc_snapshots FOR UPDATE
  USING (false);

CREATE POLICY "No client deletes on cpc_snapshots"
  ON public.cpc_snapshots FOR DELETE
  USING (false);

-- Index for latest-first queries
CREATE INDEX idx_cpc_snapshots_computed_at ON public.cpc_snapshots (computed_at DESC);
