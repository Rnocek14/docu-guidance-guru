
-- Collapse simulation runs — audit-grade logging for hostile scenario validation
CREATE TABLE public.collapse_sim_runs (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  preset_id text,
  scenario_version text NOT NULL DEFAULT 'v1.0',
  inputs_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  db_snapshot_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  results_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  assertions_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  overall_pass boolean NOT NULL DEFAULT false,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id)
);

-- RLS
ALTER TABLE public.collapse_sim_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can view collapse sim runs"
  ON public.collapse_sim_runs FOR SELECT
  USING (has_any_role(auth.uid(), ARRAY['risk_officer'::app_role, 'admin'::app_role]));

CREATE POLICY "Staff can insert collapse sim runs"
  ON public.collapse_sim_runs FOR INSERT
  WITH CHECK (has_any_role(auth.uid(), ARRAY['risk_officer'::app_role, 'admin'::app_role]));

CREATE POLICY "No client updates on collapse sim runs"
  ON public.collapse_sim_runs FOR UPDATE
  USING (false);

CREATE POLICY "No client deletes on collapse sim runs"
  ON public.collapse_sim_runs FOR DELETE
  USING (false);

-- Index for querying by preset
CREATE INDEX idx_collapse_sim_runs_preset ON public.collapse_sim_runs (preset_id, created_at DESC);
