-- Fix evaluate-risk-throttle cron to use X-Cron-Secret header (matching all other crons)
SELECT cron.unschedule('evaluate-risk-throttle');

SELECT cron.schedule(
  'evaluate-risk-throttle',
  '*/10 * * * *',
  $$
  WITH r AS (
    SELECT status::int AS http_status, content::text AS http_content
    FROM http((
      'POST',
      'https://sfxmgwkrjwuerfkqxokq.supabase.co/functions/v1/evaluate-risk-throttle',
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
  SELECT 'evaluate-risk-throttle', http_status, http_content FROM r;
  $$
);