
CREATE OR REPLACE FUNCTION public.check_cron_health()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now timestamptz := now();
  v_job_stats jsonb;
  v_reasons jsonb := '[]'::jsonb;
  v_any_red boolean := false;
  v_any_yellow boolean := false;
  v_alert_title text;
  v_alert_body text;
  v_idem_key text;
  v_self_status int;
  v_self_content text;
  v_elem jsonb;
  v_job_name text;
  v_red_thresh numeric;
  v_yellow_thresh numeric;
  v_is_stale boolean;
  v_is_low_run boolean;
  v_success_rate numeric;
  v_is_red boolean;
  v_is_yellow boolean;
BEGIN
  -- Build per-job stats; exclude self to avoid circular dependency
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
    VALUES ('cron-health-monitor', 200,
      jsonb_build_object(
        'success', true, 'alert', 'green',
        'reasons', jsonb_build_array('no jobs to evaluate'),
        'jobs', '[]'::jsonb, 'computedAt', v_now
      )::text);
    RETURN;
  END IF;

  -- Evaluate each job → build reasons[]
  FOR v_elem IN SELECT * FROM jsonb_array_elements(v_job_stats)
  LOOP
    v_job_name    := v_elem->>'jobname';
    v_is_stale    := COALESCE((v_elem->>'is_stale')::boolean, false);
    v_is_low_run  := COALESCE((v_elem->>'is_low_run')::boolean, false);
    v_success_rate:= COALESCE((v_elem->>'success_rate')::numeric, 0);

    SELECT red_if_success_rate_below, yellow_if_success_rate_below
      INTO v_red_thresh, v_yellow_thresh
      FROM public.cron_health_config c WHERE c.jobname = v_job_name;

    v_is_red := v_is_stale OR v_is_low_run OR (v_success_rate < COALESCE(v_red_thresh, 50));

    IF v_is_red THEN
      v_any_red := true;
      IF v_is_stale THEN
        v_reasons := v_reasons || to_jsonb(v_job_name || ' is stale (no recent runs)');
      END IF;
      IF v_is_low_run THEN
        v_reasons := v_reasons || to_jsonb(v_job_name || ' has too few runs');
      END IF;
      IF v_success_rate < COALESCE(v_red_thresh, 50) THEN
        v_reasons := v_reasons || to_jsonb(v_job_name || ' success rate ' || v_success_rate || '% < ' || COALESCE(v_red_thresh, 50) || '% threshold');
      END IF;
    ELSE
      v_is_yellow := (v_success_rate < COALESCE(v_yellow_thresh, 90));
      IF v_is_yellow THEN
        v_any_yellow := true;
        v_reasons := v_reasons || to_jsonb(v_job_name || ' success rate ' || v_success_rate || '% < ' || COALESCE(v_yellow_thresh, 90) || '% yellow threshold');
      END IF;
    END IF;
  END LOOP;

  -- Green path
  IF NOT v_any_red AND NOT v_any_yellow THEN
    INSERT INTO public.cron_http_runs (jobname, http_status, http_content)
    VALUES ('cron-health-monitor', 200,
      jsonb_build_object(
        'success', true, 'alert', 'green',
        'reasons', jsonb_build_array('all jobs healthy'),
        'jobs', v_job_stats, 'computedAt', v_now
      )::text);
    RETURN;
  END IF;

  -- Red or yellow path — always HTTP 200
  v_idem_key := 'cron_health:' || to_char(v_now, 'YYYY-MM-DD-HH24');

  IF v_any_red THEN
    v_alert_title := '🔴 Cron health: action required';
  ELSE
    v_alert_title := '🟡 Cron health: degraded';
  END IF;

  v_self_content := jsonb_build_object(
    'success', true,
    'alert', CASE WHEN v_any_red THEN 'red' ELSE 'yellow' END,
    'reasons', v_reasons,
    'jobs', v_job_stats,
    'computedAt', v_now
  )::text;

  v_alert_body := 'Reasons: ' || v_reasons::text;

  -- Deduplicated staff notification (hourly)
  INSERT INTO public.staff_notifications (notification_type, title, body, data, idempotency_key)
  VALUES (
    'cron_health_alert',
    v_alert_title,
    v_alert_body,
    jsonb_build_object('job_stats', v_job_stats, 'reasons', v_reasons, 'evaluated_at', v_now),
    v_idem_key
  )
  ON CONFLICT (idempotency_key) DO NOTHING;

  -- Self-log
  INSERT INTO public.cron_http_runs (jobname, http_status, http_content)
  VALUES ('cron-health-monitor', 200, v_self_content);
END;
$$;
