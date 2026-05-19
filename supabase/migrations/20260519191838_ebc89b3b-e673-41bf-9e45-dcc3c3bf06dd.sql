DO $$
DECLARE
  v_secret text;
  v_status int;
  v_content text;
  v_url text;
  v_jobs text[] := ARRAY['evaluate-risk-throttle','compute-cpc','payout-sla-check','system-governor'];
  v_job text;
BEGIN
  SELECT value INTO v_secret FROM public.internal_secrets WHERE key = 'CRON_SECRET';

  FOREACH v_job IN ARRAY v_jobs LOOP
    v_url := 'https://sfxmgwkrjwuerfkqxokq.supabase.co/functions/v1/' || v_job;

    SELECT status::int, content::text INTO v_status, v_content
    FROM http((
      'POST', v_url,
      ARRAY[
        http_header('Content-Type', 'application/json'),
        http_header('X-Cron-Secret', v_secret)
      ],
      'application/json', '{}'
    )::http_request);

    INSERT INTO public.cron_http_runs (jobname, http_status, http_content)
    VALUES (v_job || '-smoke2', v_status, COALESCE(v_content, ''));
  END LOOP;
END $$;