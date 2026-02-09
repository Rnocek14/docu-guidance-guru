
-- ============================================================
-- A) Retention: purge cron_http_runs older than 90 days
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_cron_http_runs_ran_at
  ON public.cron_http_runs (ran_at);

CREATE OR REPLACE FUNCTION public.purge_cron_http_runs(retain_days integer DEFAULT 90)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
BEGIN
  DELETE FROM public.cron_http_runs
  WHERE ran_at < now() - make_interval(days => retain_days);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.purge_cron_http_runs(integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.purge_cron_http_runs(integer) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.purge_cron_http_runs(integer) TO service_role;

-- Schedule daily purge at 03:17 UTC (use $inner$ to avoid $$ collision)
DO $outer$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'cron-http-runs-retention') THEN
    PERFORM cron.schedule(
      'cron-http-runs-retention',
      '17 3 * * *',
      $inner$SELECT public.purge_cron_http_runs(90);$inner$
    );
  END IF;
END $outer$;

-- ============================================================
-- B) Per-job cadence config table
-- ============================================================

CREATE TABLE IF NOT EXISTS public.cron_health_config (
  jobname text PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT true,
  expected_interval interval NOT NULL,
  min_expected_runs integer NOT NULL,
  red_if_success_rate_below numeric NOT NULL DEFAULT 50,
  yellow_if_success_rate_below numeric NOT NULL DEFAULT 90,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.cron_health_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can view cron health config"
  ON public.cron_health_config
  FOR SELECT
  USING (has_any_role(auth.uid(), ARRAY['risk_officer'::app_role, 'admin'::app_role]));

CREATE POLICY "No client writes cron health config"
  ON public.cron_health_config
  FOR INSERT
  WITH CHECK (false);

CREATE POLICY "No client updates cron health config"
  ON public.cron_health_config
  FOR UPDATE
  USING (false);

CREATE POLICY "No client deletes cron health config"
  ON public.cron_health_config
  FOR DELETE
  USING (false);

-- Seed configs
INSERT INTO public.cron_health_config (jobname, expected_interval, min_expected_runs, red_if_success_rate_below, yellow_if_success_rate_below)
VALUES
  ('retry-fulfillment-queue', '5 minutes', 10, 50, 90),
  ('cron-health-monitor',     '1 hour',    1,  50, 90),
  ('daily-risk-snapshot',     '1 day',     1,  50, 90)
ON CONFLICT (jobname) DO UPDATE
SET expected_interval = EXCLUDED.expected_interval,
    min_expected_runs = EXCLUDED.min_expected_runs,
    red_if_success_rate_below = EXCLUDED.red_if_success_rate_below,
    yellow_if_success_rate_below = EXCLUDED.yellow_if_success_rate_below,
    updated_at = now();

-- ============================================================
-- C) Updated check_cron_health() with per-job config
-- ============================================================

CREATE OR REPLACE FUNCTION public.check_cron_health()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  v_now timestamptz := now();
  v_window interval := interval '65 minutes';
  v_window_start timestamptz := v_now - v_window;

  v_alert_title text;
  v_alert_body  text;
  v_idem_key    text;

  v_missing_jobs text[];
  v_issue_jobs_low_run text[];
  v_issue_jobs_failed text[];

  v_any_red boolean := false;
  v_any_yellow boolean := false;

  v_job_stats jsonb := '[]'::jsonb;
BEGIN
  WITH cfg AS (
    SELECT * FROM public.cron_health_config WHERE enabled = true
  ),
  stats AS (
    SELECT
      c.jobname,
      c.expected_interval,
      c.min_expected_runs,
      c.red_if_success_rate_below,
      c.yellow_if_success_rate_below,
      COUNT(r.*) FILTER (WHERE r.ran_at >= v_window_start) AS total_runs,
      COUNT(r.*) FILTER (WHERE r.ran_at >= v_window_start AND r.http_status = 200) AS success_runs,
      COUNT(r.*) FILTER (WHERE r.ran_at >= v_window_start AND r.http_status IS DISTINCT FROM 200) AS failed_runs,
      MAX(r.ran_at) FILTER (WHERE r.http_status = 200) AS last_success,
      MAX(r.ran_at) FILTER (WHERE r.ran_at >= v_window_start) AS last_seen
    FROM cfg c
    LEFT JOIN public.cron_http_runs r ON r.jobname = c.jobname
    GROUP BY 1,2,3,4,5
  ),
  scored AS (
    SELECT
      s.*,
      CASE WHEN s.total_runs > 0
        THEN round((s.success_runs::numeric / s.total_runs::numeric) * 100, 1)
        ELSE 0
      END AS success_rate,
      (s.total_runs = 0) AS is_missing,
      (s.total_runs > 0 AND s.total_runs < s.min_expected_runs) AS is_low_run
    FROM stats s
  )
  SELECT
    array_agg(jobname) FILTER (WHERE is_missing),
    array_agg(jobname) FILTER (WHERE is_low_run),
    array_agg(jobname) FILTER (WHERE failed_runs > 0),
    jsonb_agg(jsonb_build_object(
      'jobname', jobname,
      'total_runs', total_runs,
      'success_runs', success_runs,
      'failed_runs', failed_runs,
      'success_rate', success_rate,
      'min_expected_runs', min_expected_runs,
      'expected_interval', expected_interval,
      'last_success', last_success,
      'last_seen', last_seen,
      'is_missing', is_missing,
      'is_low_run', is_low_run
    ) ORDER BY jobname)
  INTO v_missing_jobs, v_issue_jobs_low_run, v_issue_jobs_failed, v_job_stats
  FROM scored;

  IF v_job_stats IS NULL OR jsonb_array_length(v_job_stats) = 0 THEN
    RETURN;
  END IF;

  WITH js AS (
    SELECT
      (elem->>'jobname')::text AS jobname,
      COALESCE((elem->>'success_rate')::numeric, 0) AS success_rate,
      COALESCE((elem->>'is_missing')::boolean, false) AS is_missing,
      COALESCE((elem->>'is_low_run')::boolean, false) AS is_low_run,
      COALESCE((elem->>'failed_runs')::int, 0) AS failed_runs,
      (SELECT red_if_success_rate_below FROM public.cron_health_config c WHERE c.jobname = (elem->>'jobname')) AS red_thr,
      (SELECT yellow_if_success_rate_below FROM public.cron_health_config c WHERE c.jobname = (elem->>'jobname')) AS yellow_thr
    FROM jsonb_array_elements(v_job_stats) elem
  )
  SELECT
    bool_or(is_missing OR success_rate < COALESCE(red_thr, 50)),
    bool_or(is_low_run OR failed_runs > 0 OR success_rate < COALESCE(yellow_thr, 90))
  INTO v_any_red, v_any_yellow
  FROM js;

  IF NOT v_any_red AND NOT v_any_yellow THEN
    RETURN;
  END IF;

  v_idem_key := 'cron_health:' || to_char(v_now, 'YYYY-MM-DD-HH24');

  IF v_any_red THEN
    v_alert_title := '🔴 Cron health: action required';
  ELSE
    v_alert_title := '🟡 Cron health: degraded';
  END IF;

  v_alert_body :=
    'Window (UTC): ' || to_char(v_window_start, 'YYYY-MM-DD HH24:MI') ||
    ' → ' || to_char(v_now, 'YYYY-MM-DD HH24:MI') ||
    E'\nMissing: ' || COALESCE(array_to_string(v_missing_jobs, ', '), 'none') ||
    E'\nLow runs: ' || COALESCE(array_to_string(v_issue_jobs_low_run, ', '), 'none') ||
    E'\nFailures: ' || COALESCE(array_to_string(v_issue_jobs_failed, ', '), 'none');

  INSERT INTO public.staff_notifications (notification_type, title, body, data, idempotency_key)
  VALUES (
    'cron_health_alert',
    v_alert_title,
    v_alert_body,
    jsonb_build_object(
      'checked_at', v_now,
      'window_start', v_window_start,
      'window_minutes', 65,
      'missing_jobs', v_missing_jobs,
      'low_run_jobs', v_issue_jobs_low_run,
      'failed_jobs', v_issue_jobs_failed,
      'job_stats', v_job_stats
    ),
    v_idem_key
  )
  ON CONFLICT (idempotency_key) DO NOTHING;
END;
$$;
