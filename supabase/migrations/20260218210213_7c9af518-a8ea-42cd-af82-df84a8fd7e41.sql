
-- Fix cron-health-monitor: return HTTP 200 for all alert levels.
-- 500 is reserved for actual runtime failures, not detected red states.
-- Also return structured JSON instead of plain text for consistency.

CREATE OR REPLACE FUNCTION public.check_cron_health()
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_now timestamptz := now();
  v_job_stats jsonb;
  v_any_red boolean := false;
  v_any_yellow boolean := false;
  v_alert_title text;
  v_alert_body text;
  v_idem_key text;
  v_self_status int;
  v_self_content text;
BEGIN
  -- Build per-job stats from config + cron_http_runs
  -- NOTE: we exclude 'cron-health-monitor' from evaluation here
  -- because the current run hasn't been logged yet (circular dep).
  -- We still log it at the end so NEXT run can see it.
  WITH cfg AS (
    SELECT * FROM public.cron_health_config
    WHERE enabled = true
      AND jobname != 'cron-health-monitor'
  ),
  stats AS (
    SELECT
      c.jobname,
      c.expected_interval,
      c.min_expected_runs,
      c.red_if_success_rate_below,
      c.yellow_if_success_rate_below,
      COUNT(r.ran_at) AS total_runs,
      COUNT(r.ran_at) FILTER (WHERE r.http_status BETWEEN 200 AND 299) AS success_runs,
      MAX(r.ran_at) AS last_run_at
    FROM cfg c
    LEFT JOIN public.cron_http_runs r
      ON r.jobname = c.jobname
      AND r.ran_at >= v_now - (c.expected_interval * c.min_expected_runs * 2)
    GROUP BY c.jobname, c.expected_interval, c.min_expected_runs,
             c.red_if_success_rate_below, c.yellow_if_success_rate_below
  )
  SELECT jsonb_agg(jsonb_build_object(
    'jobname', s.jobname,
    'total_runs', s.total_runs,
    'success_runs', s.success_runs,
    'success_rate', CASE WHEN s.total_runs > 0
                    THEN ROUND((s.success_runs::numeric / s.total_runs) * 100, 1)
                    ELSE 0 END,
    'last_run_at', s.last_run_at,
    'is_stale', (s.last_run_at IS NULL OR s.last_run_at < v_now - (s.expected_interval * 4)),
    'is_low_run', (s.total_runs < s.min_expected_runs),
    'failed_runs', (s.total_runs - s.success_runs)
  ))
  INTO v_job_stats
  FROM stats s;

  IF v_job_stats IS NULL OR jsonb_array_length(v_job_stats) = 0 THEN
    INSERT INTO public.cron_http_runs (jobname, http_status, http_content)
    VALUES ('cron-health-monitor', 200, '{"success":true,"alert":"green","reasons":["no jobs to evaluate"],"computedAt":"' || v_now::text || '"}');
    RETURN;
  END IF;

  -- Evaluate red/yellow per job
  SELECT
    bool_or(
      COALESCE((elem->>'is_stale')::boolean, false)
      OR COALESCE((elem->>'is_low_run')::boolean, false)
      OR (COALESCE((elem->>'success_rate')::numeric, 0) < COALESCE(
        (SELECT red_if_success_rate_below FROM public.cron_health_config c WHERE c.jobname = (elem->>'jobname')), 50))
    ),
    bool_or(
      NOT (
        COALESCE((elem->>'is_stale')::boolean, false)
        OR COALESCE((elem->>'is_low_run')::boolean, false)
        OR (COALESCE((elem->>'success_rate')::numeric, 0) < COALESCE(
          (SELECT red_if_success_rate_below FROM public.cron_health_config c WHERE c.jobname = (elem->>'jobname')), 50))
      )
      AND (COALESCE((elem->>'success_rate')::numeric, 0) < COALESCE(
        (SELECT yellow_if_success_rate_below FROM public.cron_health_config c WHERE c.jobname = (elem->>'jobname')), 90))
    )
  INTO v_any_red, v_any_yellow
  FROM jsonb_array_elements(v_job_stats) elem;

  IF NOT v_any_red AND NOT v_any_yellow THEN
    INSERT INTO public.cron_http_runs (jobname, http_status, http_content)
    VALUES ('cron-health-monitor', 200, '{"success":true,"alert":"green","reasons":["all jobs healthy"],"jobs":' || v_job_stats::text || ',"computedAt":"' || v_now::text || '"}');
    RETURN;
  END IF;

  v_idem_key := 'cron_health:' || to_char(v_now, 'YYYY-MM-DD-HH24');

  IF v_any_red THEN
    v_alert_title := '🔴 Cron health: action required';
    -- FIX: Always return 200 for successful evaluation. 500 = runtime failure only.
    v_self_status := 200;
    v_self_content := '{"success":true,"alert":"red","jobs":' || v_job_stats::text || ',"computedAt":"' || v_now::text || '"}';
  ELSE
    v_alert_title := '🟡 Cron health: degraded';
    v_self_status := 200;
    v_self_content := '{"success":true,"alert":"yellow","jobs":' || v_job_stats::text || ',"computedAt":"' || v_now::text || '"}';
  END IF;

  v_alert_body := 'Job stats: ' || v_job_stats::text;

  -- Deduplicated staff notification (hourly)
  INSERT INTO public.staff_notifications (notification_type, title, body, data, idempotency_key)
  VALUES (
    'cron_health_alert',
    v_alert_title,
    v_alert_body,
    jsonb_build_object('job_stats', v_job_stats, 'evaluated_at', v_now),
    v_idem_key
  )
  ON CONFLICT (idempotency_key) DO NOTHING;

  -- Self-log: record this run so next invocation can see it
  INSERT INTO public.cron_http_runs (jobname, http_status, http_content)
  VALUES ('cron-health-monitor', v_self_status, v_self_content);
END;
$$;
