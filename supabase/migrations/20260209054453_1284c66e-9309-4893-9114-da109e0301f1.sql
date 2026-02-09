
-- Cron health monitor: checks every hour if any cron jobs had non-200 results
-- or if expected jobs haven't run at all. Fires a staff_notification on failure.

CREATE OR REPLACE FUNCTION public.check_cron_health()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_failed_count integer;
  v_missing_jobs text[];
  v_alert_title text;
  v_alert_body text;
  v_idem_key text;
  v_now timestamptz := now();
  v_window_start timestamptz := v_now - interval '65 minutes'; -- slight overlap to avoid gaps
BEGIN
  -- 1. Check for non-200 cron runs in the last hour
  SELECT count(*)
  INTO v_failed_count
  FROM cron_http_runs
  WHERE ran_at >= v_window_start
    AND http_status IS DISTINCT FROM 200;

  -- 2. Check for expected jobs that haven't run at all in the window
  -- retry-fulfillment-queue runs every 5 min, so we expect at least 1 run
  SELECT array_agg(expected.jobname)
  INTO v_missing_jobs
  FROM (VALUES ('retry-fulfillment-queue')) AS expected(jobname)
  WHERE NOT EXISTS (
    SELECT 1 FROM cron_http_runs r
    WHERE r.jobname = expected.jobname
      AND r.ran_at >= v_window_start
  );

  -- 3. If everything is healthy, exit early
  IF v_failed_count = 0 AND (v_missing_jobs IS NULL OR array_length(v_missing_jobs, 1) IS NULL) THEN
    RETURN;
  END IF;

  -- 4. Build alert
  v_idem_key := 'cron_health:' || to_char(v_now, 'YYYY-MM-DD-HH24');

  IF v_failed_count > 0 AND v_missing_jobs IS NOT NULL THEN
    v_alert_title := '🔴 Cron health: ' || v_failed_count || ' failed + ' || array_length(v_missing_jobs, 1) || ' missing job(s)';
  ELSIF v_failed_count > 0 THEN
    v_alert_title := '🟡 Cron health: ' || v_failed_count || ' non-200 response(s) in last hour';
  ELSE
    v_alert_title := '🔴 Cron health: missing job(s) — ' || array_to_string(v_missing_jobs, ', ');
  END IF;

  v_alert_body := 'Failed runs: ' || v_failed_count;
  IF v_missing_jobs IS NOT NULL THEN
    v_alert_body := v_alert_body || '. Missing jobs: ' || array_to_string(v_missing_jobs, ', ');
  END IF;
  v_alert_body := v_alert_body || '. Window: ' || to_char(v_window_start, 'HH24:MI') || '–' || to_char(v_now, 'HH24:MI UTC');

  -- 5. Insert notification (deduplicated hourly)
  INSERT INTO staff_notifications (notification_type, title, body, data, idempotency_key)
  VALUES (
    'cron_health_alert',
    v_alert_title,
    v_alert_body,
    jsonb_build_object(
      'failed_count', v_failed_count,
      'missing_jobs', v_missing_jobs,
      'checked_at', v_now
    ),
    v_idem_key
  )
  ON CONFLICT (idempotency_key) DO NOTHING;
END;
$$;

-- Schedule hourly health check (offset by 2 min to avoid colliding with :00 cron runs)
SELECT cron.schedule(
  'cron-health-monitor',
  '2 * * * *',
  $$SELECT public.check_cron_health()$$
);
