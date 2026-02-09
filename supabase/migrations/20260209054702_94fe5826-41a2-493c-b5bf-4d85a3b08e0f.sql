
-- Replace with improved cron health monitor (adds last_success, sample_failure, better formatting)
CREATE OR REPLACE FUNCTION public.check_cron_health()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  v_now timestamptz := now();
  v_window_start timestamptz := v_now - interval '65 minutes';
  v_expected_jobs text[] := ARRAY['retry-fulfillment-queue'];
  v_failed_count integer := 0;
  v_missing_jobs text[];
  v_last_success timestamptz;
  v_sample_failure jsonb;
  v_idem_key text;
  v_alert_title text;
  v_alert_body text;
BEGIN
  SELECT COUNT(*) INTO v_failed_count
  FROM cron_http_runs
  WHERE ran_at >= v_window_start
    AND jobname = ANY(v_expected_jobs)
    AND http_status IS DISTINCT FROM 200;

  SELECT array_agg(j) INTO v_missing_jobs
  FROM unnest(v_expected_jobs) AS j
  WHERE NOT EXISTS (
    SELECT 1 FROM cron_http_runs r
    WHERE r.jobname = j AND r.ran_at >= v_window_start
  );

  SELECT MAX(ran_at) INTO v_last_success
  FROM cron_http_runs
  WHERE jobname = ANY(v_expected_jobs) AND http_status = 200;

  SELECT jsonb_build_object(
    'jobname', jobname,
    'ran_at', ran_at,
    'http_status', http_status,
    'http_content', left(coalesce(http_content, ''), 500)
  ) INTO v_sample_failure
  FROM cron_http_runs
  WHERE ran_at >= v_window_start
    AND jobname = ANY(v_expected_jobs)
    AND http_status IS DISTINCT FROM 200
  ORDER BY ran_at DESC
  LIMIT 1;

  IF v_failed_count = 0 AND (v_missing_jobs IS NULL OR array_length(v_missing_jobs, 1) IS NULL) THEN
    RETURN;
  END IF;

  v_idem_key := 'cron_health:' || to_char(v_now, 'YYYY-MM-DD-HH24');

  IF v_failed_count > 0 AND v_missing_jobs IS NOT NULL THEN
    v_alert_title := '🔴 Cron health: failures + missing jobs';
  ELSIF v_failed_count > 0 THEN
    v_alert_title := '🟡 Cron health: non-200 responses detected';
  ELSE
    v_alert_title := '🔴 Cron health: missing job runs detected';
  END IF;

  v_alert_body :=
    'Window (UTC): ' || to_char(v_window_start, 'YYYY-MM-DD HH24:MI') ||
    ' → ' || to_char(v_now, 'YYYY-MM-DD HH24:MI') ||
    E'\nFailed runs (non-200): ' || v_failed_count ||
    E'\nMissing jobs: ' || coalesce(array_to_string(v_missing_jobs, ', '), 'none') ||
    E'\nLast success: ' || coalesce(to_char(v_last_success, 'YYYY-MM-DD HH24:MI TZ'), 'never');

  INSERT INTO staff_notifications (notification_type, title, body, data, idempotency_key)
  VALUES (
    'cron_health_alert',
    v_alert_title,
    v_alert_body,
    jsonb_build_object(
      'checked_at', v_now,
      'window_start', v_window_start,
      'failed_count', v_failed_count,
      'missing_jobs', v_missing_jobs,
      'last_success', v_last_success,
      'sample_failure', v_sample_failure
    ),
    v_idem_key
  )
  ON CONFLICT (idempotency_key) DO NOTHING;
END;
$$;
