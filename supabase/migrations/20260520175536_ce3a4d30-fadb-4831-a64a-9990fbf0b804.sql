
-- Ensure extensions
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Weekly full snapshot — Mondays 09:00 UTC
SELECT cron.schedule(
  'competitor-intel-weekly',
  '0 9 * * 1',
  $$
  SELECT net.http_post(
    url := 'https://sfxmgwkrjwuerfkqxokq.supabase.co/functions/v1/scrape-competitor-intel',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'X-Cron-Secret', (SELECT value FROM public.internal_secrets WHERE key = 'CRON_SECRET')
    ),
    body := jsonb_build_object('kind', 'weekly')
  );
  $$
);

-- Daily promo snapshot — every day 13:00 UTC
SELECT cron.schedule(
  'competitor-intel-promo-daily',
  '0 13 * * *',
  $$
  SELECT net.http_post(
    url := 'https://sfxmgwkrjwuerfkqxokq.supabase.co/functions/v1/scrape-competitor-intel',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'X-Cron-Secret', (SELECT value FROM public.internal_secrets WHERE key = 'CRON_SECRET')
    ),
    body := jsonb_build_object('kind', 'promo_daily')
  );
  $$
);
