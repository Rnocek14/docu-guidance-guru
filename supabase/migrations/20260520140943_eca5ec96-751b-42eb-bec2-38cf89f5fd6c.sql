-- B-1: Surface breaker jobs in cron_health_config so MissionControl alerts on stalls.
-- breaker_evaluator runs every 5 minutes; breaker_staleness_check runs every 5 minutes.
-- Both are pg_cron jobs that call SQL functions (no HTTP edge function), but
-- check_cron_health() / pg_cron logs still report run success, and the MissionControl
-- action-items panel filters cron_health_config WHERE enabled = true.

INSERT INTO public.cron_health_config (jobname, expected_interval, min_expected_runs, yellow_if_success_rate_below, red_if_success_rate_below, enabled)
VALUES
  ('breaker_evaluator',         interval '5 minutes',  10, 95, 80, true),
  ('breaker_staleness_check',   interval '5 minutes',  10, 95, 80, true)
ON CONFLICT (jobname) DO UPDATE SET
  expected_interval = EXCLUDED.expected_interval,
  min_expected_runs = EXCLUDED.min_expected_runs,
  yellow_if_success_rate_below = EXCLUDED.yellow_if_success_rate_below,
  red_if_success_rate_below = EXCLUDED.red_if_success_rate_below,
  enabled = true,
  updated_at = now();