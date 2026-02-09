
-- Schedule hourly dispute rate check (minute 12)
SELECT cron.schedule(
  'check-dispute-rate',
  '12 * * * *',
  $$
  WITH r AS (
    SELECT status::int AS http_status, content::text AS http_content
    FROM http((
      'POST',
      'https://sfxmgwkrjwuerfkqxokq.supabase.co/functions/v1/check-dispute-rate',
      ARRAY[
        http_header('Content-Type', 'application/json'),
        http_header(
          'X-Cron-Secret',
          (SELECT value FROM public.internal_secrets WHERE key = 'CRON_SECRET')
        )
      ],
      'application/json',
      '{}'
    )::http_request)
  )
  INSERT INTO public.cron_http_runs (jobname, http_status, http_content)
  SELECT 'check-dispute-rate', http_status, http_content FROM r;
  $$
);

-- Add cron health monitoring for this job
INSERT INTO public.cron_health_config (
  jobname,
  expected_interval,
  min_expected_runs,
  enabled,
  yellow_if_success_rate_below,
  red_if_success_rate_below,
  created_at,
  updated_at
)
VALUES (
  'check-dispute-rate',
  '1 hour'::interval,
  1,
  true,
  90,
  50,
  now(),
  now()
)
ON CONFLICT (jobname) DO UPDATE SET
  expected_interval = EXCLUDED.expected_interval,
  min_expected_runs = EXCLUDED.min_expected_runs,
  enabled = EXCLUDED.enabled,
  updated_at = now();
