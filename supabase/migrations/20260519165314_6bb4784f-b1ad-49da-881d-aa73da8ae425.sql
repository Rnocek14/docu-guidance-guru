-- Treasury projections: results of the scaling-velocity simulator
CREATE TABLE public.treasury_projections (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  scenario_key text NOT NULL,
  label text,
  starting_reserve numeric NOT NULL,
  starting_traders integer NOT NULL,
  inputs_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  results_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  verdict_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  safe_growth_ceiling_pct numeric,
  min_reserve_recommended numeric,
  min_reserve_stress numeric,
  min_reserve_catastrophic numeric,
  worst_month_trough numeric,
  insolvent boolean NOT NULL DEFAULT false,
  insolvent_month integer,
  breaker_freeze_months integer NOT NULL DEFAULT 0,
  breaker_l1_months integer NOT NULL DEFAULT 0,
  created_by uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX idx_treasury_projections_created_at ON public.treasury_projections (created_at DESC);
CREATE INDEX idx_treasury_projections_scenario ON public.treasury_projections (scenario_key, created_at DESC);

ALTER TABLE public.treasury_projections ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can view treasury projections"
  ON public.treasury_projections
  FOR SELECT
  TO authenticated
  USING (has_any_role(auth.uid(), ARRAY['risk_officer'::app_role, 'admin'::app_role]));

CREATE POLICY "Staff can insert treasury projections"
  ON public.treasury_projections
  FOR INSERT
  TO authenticated
  WITH CHECK (
    has_any_role(auth.uid(), ARRAY['risk_officer'::app_role, 'admin'::app_role])
    AND created_by = auth.uid()
  );

CREATE POLICY "No client updates on treasury projections"
  ON public.treasury_projections
  FOR UPDATE
  TO public
  USING (false);

CREATE POLICY "No client deletes on treasury projections"
  ON public.treasury_projections
  FOR DELETE
  TO public
  USING (false);