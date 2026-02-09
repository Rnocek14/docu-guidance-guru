
-- ── P0-1: Rotate cron secret + reschedule with runtime lookup + HTTP logging ──

-- Step 1: Unschedule old job that has plaintext secret
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'retry-fulfillment-queue';

-- Step 2: Reschedule with runtime secret lookup from internal_secrets + HTTP response logging
SELECT cron.schedule(
  'retry-fulfillment-queue',
  '*/5 * * * *',
  $$
  WITH r AS (
    SELECT status::int AS http_status, content::text AS http_content
    FROM http((
      'POST',
      'https://sfxmgwkrjwuerfkqxokq.supabase.co/functions/v1/retry-fulfillment-queue',
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
  SELECT 'retry-fulfillment-queue', http_status, http_content FROM r;
  $$
);
