-- Revert B-1 partial: breaker_evaluator and breaker_staleness_check are
-- pg_cron jobs that run SQL functions directly (no net.http_post). They never
-- write to cron_http_runs, so the HTTP-based cron_health_config alerting
-- always marked them stale. MissionControl now reads
-- econ_breaker_state.last_evaluated_at directly for breaker freshness.
DELETE FROM public.cron_health_config
WHERE jobname IN ('breaker_evaluator', 'breaker_staleness_check');