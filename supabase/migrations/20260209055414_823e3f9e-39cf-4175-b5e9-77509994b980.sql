
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
  v_min_expected_runs integer := 10;
  v_failed_count integer := 0;
  v_total_runs integer := 0;
  v_success_count integer := 0;
  v_missing_jobs text[];
  v_low_run_jobs text[];
  v_last_success timestamptz;
  v_sample_failure jsonb;
  v_last_3_statuses jsonb;
  v_success_rate numeric;
  v_idem_key text;
  v_alert_title text;
  v_alert_body text;
  v_issues text[] := ARRAY[]::text[];
BEGIN
  SELECT COUNT(*), COUNT(*) FILTER (WHERE http_status = 200)
  INTO v_total_runs, v_success_count
  FROM cron_http_runs
  WHERE ran_at >= v_window_start AND jobname = ANY(v_expected_jobs);

  v_failed_count := v_total_runs - v_success_count;
  v_success_rate := CASE WHEN v_total_runs > 0
    THEN round((v_success_count::numeric / v_total_runs) * 100, 1) ELSE 0 END;

  SELECT array_agg(j) INTO v_missing_jobs
  FROM unnest(v_expected_jobs) AS j
  WHERE NOT EXISTS (
    SELECT 1 FROM cron_http_runs r WHERE r.jobname = j AND r.ran_at >= v_window_start
  );

  SELECT array_agg(j) INTO v_low_run_jobs
  FROM unnest(v_expected_jobs) AS j
  WHERE j != ALL(COALESCE(v_missing_jobs, ARRAY[]::text[]))
    AND (SELECT COUNT(*) FROM cron_http_runs r
         WHERE r.jobname = j AND r.ran_at >= v_window_start) < v_min_expected_runs;

  SELECT MAX(ran_at) INTO v_last_success
  FROM cron_http_runs WHERE jobname = ANY(v_expected_jobs) AND http_status = 200;

  SELECT jsonb_agg(s ORDER BY s->>'ran_at' DESC) INTO v_last_3_statuses
  FROM (
    SELECT jsonb_build_object('jobname', jobname, 'ran_at', ran_at, 'http_status', http_status) AS s
    FROM cron_http_runs WHERE jobname = ANY(v_expected_jobs) ORDER BY ran_at DESC LIMIT 3
  ) sub;

  SELECT jsonb_build_object(
    'jobname', jobname, 'ran_at', ran_at, 'http_status', http_status,
    'http_content', left(coalesce(http_content, ''), 500)
  ) INTO v_sample_failure
  FROM cron_http_runs
  WHERE ran_at >= v_window_start AND jobname = ANY(v_expected_jobs) AND http_status IS DISTINCT FROM 200
  ORDER BY ran_at DESC LIMIT 1;

  IF v_failed_count = 0
     AND COALESCE(array_length(v_missing_jobs, 1), 0) = 0
     AND COALESCE(array_length(v_low_run_jobs, 1), 0) = 0
  THEN RETURN; END IF;

  IF COALESCE(array_length(v_missing_jobs, 1), 0) > 0 THEN
    v_issues := array_append(v_issues, 'missing jobs');
  END IF;
  IF v_failed_count > 0 THEN
    v_issues := array_append(v_issues, v_failed_count || ' failures');
  END IF;
  IF COALESCE(array_length(v_low_run_jobs, 1), 0) > 0 THEN
    v_issues := array_append(v_issues, 'low run count');
  END IF;

  IF COALESCE(array_length(v_missing_jobs, 1), 0) > 0 OR v_success_rate < 50 THEN
    v_alert_title := '🔴 Cron health: ' || array_to_string(v_issues, ' + ');
  ELSE
    v_alert_title := '🟡 Cron health: ' || array_to_string(v_issues, ' + ');
  END IF;

  v_idem_key := 'cron_health:' || to_char(v_now, 'YYYY-MM-DD-HH24');

  v_alert_body :=
    'Window (UTC): ' || to_char(v_window_start, 'YYYY-MM-DD HH24:MI') ||
    ' → ' || to_char(v_now, 'YYYY-MM-DD HH24:MI') ||
    E'\nTotal runs: ' || v_total_runs || ' (expected ≥' || v_min_expected_runs || ')' ||
    E'\nSuccess rate: ' || v_success_rate || '%' ||
    E'\nFailed (non-200): ' || v_failed_count ||
    E'\nMissing jobs: ' || coalesce(array_to_string(v_missing_jobs, ', '), 'none') ||
    E'\nLow run count: ' || coalesce(array_to_string(v_low_run_jobs, ', '), 'none') ||
    E'\nLast success: ' || coalesce(to_char(v_last_success, 'YYYY-MM-DD HH24:MI TZ'), 'never');

  INSERT INTO staff_notifications (notification_type, title, body, data, idempotency_key)
  VALUES (
    'cron_health_alert', v_alert_title, v_alert_body,
    jsonb_build_object(
      'checked_at', v_now, 'window_start', v_window_start,
      'total_runs', v_total_runs, 'success_count', v_success_count,
      'failed_count', v_failed_count, 'success_rate', v_success_rate,
      'min_expected_runs', v_min_expected_runs, 'missing_jobs', v_missing_jobs,
      'low_run_jobs', v_low_run_jobs, 'last_success', v_last_success,
      'last_3_statuses', v_last_3_statuses, 'sample_failure', v_sample_failure
    ), v_idem_key
  ) ON CONFLICT (idempotency_key) DO NOTHING;
END;
$$;
