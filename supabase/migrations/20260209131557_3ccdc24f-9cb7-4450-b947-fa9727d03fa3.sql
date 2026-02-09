
-- Schedule daily-risk-snapshot at 06:00 UTC using the HTTP+INSERT pattern
-- so it logs to cron_http_runs for health monitoring
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'daily-risk-snapshot') THEN
    PERFORM cron.schedule(
      'daily-risk-snapshot',
      '0 6 * * *',
      $inner$
      WITH r AS (
        SELECT status::int AS http_status, content::text AS http_content
        FROM http((
          'POST',
          'https://sfxmgwkrjwuerfkqxokq.supabase.co/functions/v1/daily-risk-snapshot',
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
      SELECT 'daily-risk-snapshot', http_status, http_content FROM r;
      $inner$
    );
  END IF;
END $$;
