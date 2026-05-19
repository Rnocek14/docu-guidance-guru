-- Unschedule existing broken / missing jobs (safe if not present)
DO $$
DECLARE
  j record;
BEGIN
  FOR j IN SELECT jobid, jobname FROM cron.job
           WHERE jobname IN ('evaluate-risk-throttle','compute-cpc','payout-sla-check','system-governor')
  LOOP
    PERFORM cron.unschedule(j.jobid);
  END LOOP;
END $$;

-- 1) evaluate-risk-throttle — every 10 min, X-Cron-Secret header
SELECT cron.schedule(
  'evaluate-risk-throttle',
  '*/10 * * * *',
  $cmd$
  WITH r AS (
    SELECT status::int AS http_status, content::text AS http_content
    FROM http((
      'POST',
      'https://sfxmgwkrjwuerfkqxokq.supabase.co/functions/v1/evaluate-risk-throttle',
      ARRAY[
        http_header('Content-Type', 'application/json'),
        http_header('X-Cron-Secret', (SELECT value FROM public.internal_secrets WHERE key = 'CRON_SECRET'))
      ],
      'application/json',
      '{}'
    )::http_request)
  )
  INSERT INTO public.cron_http_runs (jobname, http_status, http_content)
  SELECT 'evaluate-risk-throttle', http_status, http_content FROM r;
  $cmd$
);

-- 2) compute-cpc — every 6h. Function accepts Authorization: Bearer <CRON_SECRET>.
SELECT cron.schedule(
  'compute-cpc',
  '0 */6 * * *',
  $cmd$
  WITH r AS (
    SELECT status::int AS http_status, content::text AS http_content
    FROM http((
      'POST',
      'https://sfxmgwkrjwuerfkqxokq.supabase.co/functions/v1/compute-cpc',
      ARRAY[
        http_header('Content-Type', 'application/json'),
        http_header('Authorization', 'Bearer ' || (SELECT value FROM public.internal_secrets WHERE key = 'CRON_SECRET'))
      ],
      'application/json',
      '{}'
    )::http_request)
  )
  INSERT INTO public.cron_http_runs (jobname, http_status, http_content)
  SELECT 'compute-cpc', http_status, http_content FROM r;
  $cmd$
);

-- 3) payout-sla-check — hourly at :07
SELECT cron.schedule(
  'payout-sla-check',
  '7 * * * *',
  $cmd$
  WITH r AS (
    SELECT status::int AS http_status, content::text AS http_content
    FROM http((
      'POST',
      'https://sfxmgwkrjwuerfkqxokq.supabase.co/functions/v1/payout-sla-check',
      ARRAY[
        http_header('Content-Type', 'application/json'),
        http_header('Authorization', 'Bearer ' || (SELECT value FROM public.internal_secrets WHERE key = 'CRON_SECRET'))
      ],
      'application/json',
      '{}'
    )::http_request)
  )
  INSERT INTO public.cron_http_runs (jobname, http_status, http_content)
  SELECT 'payout-sla-check', http_status, http_content FROM r;
  $cmd$
);

-- 4) system-governor — every 5 min
SELECT cron.schedule(
  'system-governor',
  '*/5 * * * *',
  $cmd$
  WITH r AS (
    SELECT status::int AS http_status, content::text AS http_content
    FROM http((
      'POST',
      'https://sfxmgwkrjwuerfkqxokq.supabase.co/functions/v1/system-governor',
      ARRAY[
        http_header('Content-Type', 'application/json'),
        http_header('Authorization', 'Bearer ' || (SELECT value FROM public.internal_secrets WHERE key = 'CRON_SECRET'))
      ],
      'application/json',
      '{}'
    )::http_request)
  )
  INSERT INTO public.cron_http_runs (jobname, http_status, http_content)
  SELECT 'system-governor', http_status, http_content FROM r;
  $cmd$
);
