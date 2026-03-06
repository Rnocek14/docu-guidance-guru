INSERT INTO cron_health_config (jobname, expected_interval, min_expected_runs, enabled)
VALUES
  ('payout-sla-check', '1 hour', 1, true),
  ('system-governor', '1 hour', 1, true),
  ('compute-cpc', '6 hours', 1, true)
ON CONFLICT (jobname) DO NOTHING;