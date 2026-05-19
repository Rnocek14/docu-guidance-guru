-- Trigger compute-cpc and payout-sla-check immediately to log fresh runs post-secret-rotation
WITH r AS (
  SELECT status::int AS http_status, content::text AS http_content
  FROM http((
    'POST',
    'https://sfxmgwkrjwuerfkqxokq.supabase.co/functions/v1/compute-cpc',
    ARRAY[
      http_header('Content-Type','application/json'),
      http_header('Authorization','Bearer '||(SELECT value FROM public.internal_secrets WHERE key='CRON_SECRET'))
    ],
    'application/json',
    '{}'
  )::http_request)
)
INSERT INTO public.cron_http_runs (jobname, http_status, http_content)
SELECT 'compute-cpc', http_status, http_content FROM r;

WITH r AS (
  SELECT status::int AS http_status, content::text AS http_content
  FROM http((
    'POST',
    'https://sfxmgwkrjwuerfkqxokq.supabase.co/functions/v1/payout-sla-check',
    ARRAY[
      http_header('Content-Type','application/json'),
      http_header('Authorization','Bearer '||(SELECT value FROM public.internal_secrets WHERE key='CRON_SECRET'))
    ],
    'application/json',
    '{}'
  )::http_request)
)
INSERT INTO public.cron_http_runs (jobname, http_status, http_content)
SELECT 'payout-sla-check', http_status, http_content FROM r;
