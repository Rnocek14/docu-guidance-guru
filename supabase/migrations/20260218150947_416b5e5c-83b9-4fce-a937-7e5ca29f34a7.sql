
-- Governor certification log — immutable record of every automated check
CREATE TABLE public.governor_certifications (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  certified_at timestamptz NOT NULL DEFAULT now(),
  verdict text NOT NULL CHECK (verdict IN ('safe', 'not_safe', 'error')),
  capital_safe boolean NOT NULL DEFAULT false,
  processor_safe boolean NOT NULL DEFAULT false,
  cohort_safe boolean NOT NULL DEFAULT false,
  risk_engine_safe boolean NOT NULL DEFAULT false,
  auto_action text,
  auto_action_detail text,
  blockers jsonb NOT NULL DEFAULT '[]'::jsonb,
  domains jsonb NOT NULL DEFAULT '{}'::jsonb,
  source text NOT NULL DEFAULT 'cron'
);

ALTER TABLE public.governor_certifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "No client writes on governor_certifications"
  ON public.governor_certifications FOR INSERT
  WITH CHECK (false);

CREATE POLICY "No client updates on governor_certifications"
  ON public.governor_certifications FOR UPDATE
  USING (false);

CREATE POLICY "No client deletes on governor_certifications"
  ON public.governor_certifications FOR DELETE
  USING (false);

CREATE POLICY "Staff can view governor certifications"
  ON public.governor_certifications FOR SELECT
  USING (
    has_any_role(auth.uid(), ARRAY['risk_officer'::app_role, 'admin'::app_role])
  );

CREATE INDEX idx_governor_certifications_latest 
  ON public.governor_certifications (certified_at DESC);

INSERT INTO public.system_settings (key, value)
VALUES ('governor_config', '{"enabled": true, "check_interval_minutes": 5, "auto_lock": true, "auto_unlock": true, "drill_expiry_minutes": 60}'::jsonb)
ON CONFLICT (key) DO NOTHING;
