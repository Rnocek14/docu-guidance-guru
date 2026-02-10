
-- Risk Throttle State: singleton table for automated pass-rate throttling
CREATE TABLE public.risk_throttle_state (
  id uuid PRIMARY KEY DEFAULT '00000000-0000-0000-0000-000000000002'::uuid,
  state text NOT NULL DEFAULT 'green',
  purchase_enabled boolean NOT NULL DEFAULT true,
  eligibility_delay_bonus_days integer NOT NULL DEFAULT 0,
  pass_rate_7d numeric NOT NULL DEFAULT 0,
  pass_rate_14d numeric NOT NULL DEFAULT 0,
  pass_rate_30d numeric NOT NULL DEFAULT 0,
  metrics_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  reason text,
  auto_updated_at timestamptz,
  manual_override_by uuid,
  manual_override_at timestamptz,
  manual_override_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT risk_throttle_state_valid CHECK (state IN ('green', 'yellow', 'orange', 'red')),
  CONSTRAINT risk_throttle_singleton CHECK (id = '00000000-0000-0000-0000-000000000002'::uuid)
);

INSERT INTO public.risk_throttle_state (id) VALUES ('00000000-0000-0000-0000-000000000002'::uuid);

ALTER TABLE public.risk_throttle_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY "No client inserts on risk_throttle_state"
  ON public.risk_throttle_state AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (false);

CREATE POLICY "No client deletes on risk_throttle_state"
  ON public.risk_throttle_state AS RESTRICTIVE FOR DELETE TO authenticated
  USING (false);

CREATE POLICY "Admins can update risk_throttle_state"
  ON public.risk_throttle_state AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Staff can view risk_throttle_state"
  ON public.risk_throttle_state AS RESTRICTIVE FOR SELECT TO authenticated
  USING (has_any_role(auth.uid(), ARRAY['risk_officer'::app_role, 'admin'::app_role]));

-- RPC: cron engine updates throttle (service_role only)
CREATE OR REPLACE FUNCTION public.update_risk_throttle(
  p_state text,
  p_purchase_enabled boolean,
  p_eligibility_delay_bonus_days integer,
  p_pass_rate_7d numeric,
  p_pass_rate_14d numeric,
  p_pass_rate_30d numeric,
  p_metrics_snapshot jsonb,
  p_reason text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE risk_throttle_state SET
    state = p_state,
    purchase_enabled = p_purchase_enabled,
    eligibility_delay_bonus_days = p_eligibility_delay_bonus_days,
    pass_rate_7d = p_pass_rate_7d,
    pass_rate_14d = p_pass_rate_14d,
    pass_rate_30d = p_pass_rate_30d,
    metrics_snapshot = p_metrics_snapshot,
    reason = p_reason,
    auto_updated_at = now(),
    updated_at = now()
  WHERE id = '00000000-0000-0000-0000-000000000002'::uuid;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.update_risk_throttle FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.update_risk_throttle FROM anon;
GRANT EXECUTE ON FUNCTION public.update_risk_throttle TO service_role;

-- RPC: admin manual override (loosen only)
CREATE OR REPLACE FUNCTION public.manual_risk_throttle_override(
  p_purchase_enabled boolean,
  p_eligibility_delay_bonus_days integer,
  p_reason text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT has_role(auth.uid(), 'admin'::app_role) THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  UPDATE risk_throttle_state SET
    purchase_enabled = p_purchase_enabled,
    eligibility_delay_bonus_days = p_eligibility_delay_bonus_days,
    manual_override_by = auth.uid(),
    manual_override_at = now(),
    manual_override_reason = p_reason,
    updated_at = now()
  WHERE id = '00000000-0000-0000-0000-000000000002'::uuid;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.manual_risk_throttle_override FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.manual_risk_throttle_override FROM anon;
GRANT EXECUTE ON FUNCTION public.manual_risk_throttle_override TO authenticated;

-- Register in cron health monitoring
INSERT INTO public.cron_health_config (jobname, expected_interval, min_expected_runs, enabled)
VALUES ('evaluate-risk-throttle', '6 hours'::interval, 3, true);
