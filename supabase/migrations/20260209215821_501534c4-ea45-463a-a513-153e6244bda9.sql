-- =============================================================================
-- BLOCKER FIX 1: Security — revoke PUBLIC execute on get_liability_snapshot
-- Only authenticated (staff via internal check) + service_role should execute
-- =============================================================================
REVOKE EXECUTE ON FUNCTION public.get_liability_snapshot(integer, numeric, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_liability_snapshot(integer, numeric, numeric) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_liability_snapshot(integer, numeric, numeric) TO service_role;

-- =============================================================================
-- BLOCKER FIX 2: Cron health monitor uses fixed 65-min window, causing daily
-- jobs to appear "missing" most of the time → false RED alerts.
-- Fix: use each job's expected_interval (+ 25% buffer) as the evaluation window.
-- =============================================================================
CREATE OR REPLACE FUNCTION public.check_cron_health()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now timestamptz := now();
  v_alert_title text;
  v_alert_body  text;
  v_idem_key    text;

  v_missing_jobs text[];
  v_issue_jobs_low_run text[];
  v_issue_jobs_failed text[];

  v_any_red boolean := false;
  v_any_yellow boolean := false;

  v_job_stats jsonb := '[]'::jsonb;
  v_self_status int := 200;
  v_self_content text := 'ok';
BEGIN
  -- Build per-job stats using each job's own expected_interval as the window
  -- (with 25% buffer). This fixes daily jobs being falsely flagged as missing
  -- when using a global 65-minute window.
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
      -- Use per-job window: expected_interval * 1.25 (but at least 65 minutes)
      GREATEST(c.expected_interval * 1.25, interval '65 minutes') AS eval_window,
      COUNT(r.*) FILTER (WHERE r.ran_at >= v_now - GREATEST(c.expected_interval * 1.25, interval '65 minutes')) AS total_runs,
      COUNT(r.*) FILTER (WHERE r.ran_at >= v_now - GREATEST(c.expected_interval * 1.25, interval '65 minutes') AND r.http_status = 200) AS success_runs,
      COUNT(r.*) FILTER (WHERE r.ran_at >= v_now - GREATEST(c.expected_interval * 1.25, interval '65 minutes') AND r.http_status IS DISTINCT FROM 200) AS failed_runs,
      MAX(r.ran_at) FILTER (WHERE r.http_status = 200) AS last_success,
      MAX(r.ran_at) FILTER (WHERE r.ran_at >= v_now - GREATEST(c.expected_interval * 1.25, interval '65 minutes')) AS last_seen
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
      'eval_window', eval_window,
      'last_success', last_success,
      'last_seen', last_seen,
      'is_missing', is_missing,
      'is_low_run', is_low_run
    ) ORDER BY jobname)
  INTO v_missing_jobs, v_issue_jobs_low_run, v_issue_jobs_failed, v_job_stats
  FROM scored;

  -- If no enabled jobs configured (excluding self), just log success and return
  IF v_job_stats IS NULL OR jsonb_array_length(v_job_stats) = 0 THEN
    INSERT INTO public.cron_http_runs (jobname, http_status, http_content)
    VALUES ('cron-health-monitor', 200, 'ok: no jobs to evaluate');
    RETURN;
  END IF;

  -- Determine severity
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

  -- All clear — log success and return
  IF NOT v_any_red AND NOT v_any_yellow THEN
    INSERT INTO public.cron_http_runs (jobname, http_status, http_content)
    VALUES ('cron-health-monitor', 200, 'ok: all jobs healthy');
    RETURN;
  END IF;

  v_idem_key := 'cron_health:' || to_char(v_now, 'YYYY-MM-DD-HH24');

  IF v_any_red THEN
    v_alert_title := '🔴 Cron health: action required';
    v_self_status := 500;
    v_self_content := 'alert: red';
  ELSE
    v_alert_title := '🟡 Cron health: degraded';
    v_self_status := 200;
    v_self_content := 'alert: yellow';
  END IF;

  v_alert_body :=
    COALESCE('Missing jobs: ' || array_to_string(v_missing_jobs, ', ') || E'\n', '')
    || COALESCE('Low-run jobs: ' || array_to_string(v_issue_jobs_low_run, ', ') || E'\n', '')
    || COALESCE('Failed jobs: ' || array_to_string(v_issue_jobs_failed, ', ') || E'\n', '');

  -- Idempotent notification (1 per hour per severity)
  INSERT INTO public.staff_notifications (
    notification_type, title, body, data, idempotency_key
  )
  VALUES (
    'cron_health',
    v_alert_title,
    v_alert_body,
    jsonb_build_object('job_stats', v_job_stats, 'severity', CASE WHEN v_any_red THEN 'red' ELSE 'yellow' END),
    v_idem_key
  )
  ON CONFLICT (idempotency_key) DO NOTHING;

  -- Self-log
  INSERT INTO public.cron_http_runs (jobname, http_status, http_content)
  VALUES ('cron-health-monitor', v_self_status, v_self_content);
END;
$$;

-- Keep permissions locked down
REVOKE EXECUTE ON FUNCTION public.check_cron_health() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.check_cron_health() TO service_role;

-- =============================================================================
-- BLOCKER FIX 3: Cohort activation guardrail — prevent activating cohorts
-- without lifetime caps or first payout caps (profitability kill-switch)
-- =============================================================================
CREATE OR REPLACE FUNCTION public.validate_cohort_activation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  -- Only check when activating a cohort (not when deactivating)
  IF NEW.is_active = true AND (OLD.is_active = false OR OLD IS NULL) THEN
    -- Performance/funded-sim cohorts MUST have lifetime caps
    IF NEW.cohort_phase IN ('performance', 'funded_sim') THEN
      IF NEW.lifetime_cap_multiple IS NULL OR NEW.lifetime_cap_multiple <= 0 THEN
        RAISE EXCEPTION 'Cannot activate % cohort "%": lifetime_cap_multiple must be > 0 (got %)',
          NEW.cohort_phase, NEW.name, NEW.lifetime_cap_multiple;
      END IF;
      IF NEW.first_payout_cap_amount IS NULL OR NEW.first_payout_cap_amount <= 0 THEN
        RAISE EXCEPTION 'Cannot activate % cohort "%": first_payout_cap_amount must be > 0 (got %)',
          NEW.cohort_phase, NEW.name, NEW.first_payout_cap_amount;
      END IF;
    END IF;
    -- ALL active cohorts must have sane payout split
    IF NEW.payout_split_percent > 90 THEN
      RAISE EXCEPTION 'Cannot activate cohort "%": payout_split_percent must be <= 90 (got %)',
        NEW.name, NEW.payout_split_percent;
    END IF;
    -- Profit target sanity (evaluation/verification must have > 0)
    IF NEW.cohort_phase IN ('evaluation', 'verification') AND (NEW.profit_target_percent IS NULL OR NEW.profit_target_percent <= 0) THEN
      RAISE EXCEPTION 'Cannot activate % cohort "%": profit_target_percent must be > 0',
        NEW.cohort_phase, NEW.name;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- Drop if exists to be safe, then create
DROP TRIGGER IF EXISTS trg_validate_cohort_activation ON public.cohorts;
CREATE TRIGGER trg_validate_cohort_activation
  BEFORE INSERT OR UPDATE ON public.cohorts
  FOR EACH ROW
  EXECUTE FUNCTION public.validate_cohort_activation();