
-- Simulation persistence tables (staff-only, read-only for production safety)

CREATE TABLE public.simulation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seed integer NOT NULL DEFAULT 42,
  iterations integer NOT NULL DEFAULT 2000,
  months_per_iteration integer NOT NULL DEFAULT 12,
  
  -- Input params (frozen at run time)
  assumptions jsonb NOT NULL,
  cohort_configs jsonb NOT NULL DEFAULT '[]'::jsonb,  -- snapshot of cohort table at run time
  
  -- Summary results
  profit_mean numeric NOT NULL,
  profit_p5 numeric NOT NULL,
  profit_p50 numeric NOT NULL,
  profit_p95 numeric NOT NULL,
  profit_std_dev numeric NOT NULL,
  
  -- Risk
  probability_of_loss numeric NOT NULL,
  max_drawdown numeric NOT NULL,
  worst_month numeric NOT NULL,
  best_month numeric NOT NULL,
  consecutive_loss_months integer NOT NULL DEFAULT 0,
  
  -- Reserve analysis
  reserve_breach_probability numeric,  -- probability of breaching configured reserve threshold
  reserve_threshold numeric,           -- threshold used for this run
  
  -- Full results blob
  full_results jsonb NOT NULL,
  
  -- Metadata
  status text NOT NULL DEFAULT 'completed',
  triggered_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  duration_ms integer
);

ALTER TABLE public.simulation_runs ENABLE ROW LEVEL SECURITY;

-- Staff-only read access
CREATE POLICY "Staff can view simulation runs"
  ON public.simulation_runs FOR SELECT
  USING (has_any_role(auth.uid(), ARRAY['risk_officer'::app_role, 'support'::app_role, 'admin'::app_role]));

-- No client writes (edge function uses service_role)
CREATE POLICY "No client inserts on simulation_runs"
  ON public.simulation_runs FOR INSERT
  WITH CHECK (false);

CREATE POLICY "No client updates on simulation_runs"
  ON public.simulation_runs FOR UPDATE
  USING (false);

CREATE POLICY "No client deletes on simulation_runs"
  ON public.simulation_runs FOR DELETE
  USING (false);

-- Index for quick lookups
CREATE INDEX idx_simulation_runs_created ON public.simulation_runs(created_at DESC);

-- Reserve-aware payout config (system_settings key)
-- This will be checked by payout-actions before approving
INSERT INTO public.system_settings (key, value)
VALUES ('reserve_aware_approval', jsonb_build_object(
  'enabled', false,
  'min_reserve_after_approval', 5000,
  'block_if_simulated_loss_prob_above', 0.6,
  'last_simulation_run_id', null
))
ON CONFLICT (key) DO NOTHING;
