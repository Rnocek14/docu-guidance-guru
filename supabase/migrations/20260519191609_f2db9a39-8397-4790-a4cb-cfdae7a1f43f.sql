-- Manual smoke run for each fixed/new job; results logged to cron_http_runs.
DO $$
DECLARE
  v_secret text;
  v_status int;
  v_content text;
  v_url text;
  v_jobs text[] := ARRAY['evaluate-risk-throttle','compute-cpc','payout-sla-check','system-governor'];
  v_job text;
  v_header_name text;
  v_header_value text;
BEGIN
  SELECT value INTO v_secret FROM public.internal_secrets WHERE key = 'CRON_SECRET';
  IF v_secret IS NULL OR length(v_secret) < 8 THEN
    RAISE EXCEPTION 'CRON_SECRET missing/short in internal_secrets';
  END IF;

  FOREACH v_job IN ARRAY v_jobs LOOP
    v_url := 'https://sfxmgwkrjwuerfkqxokq.supabase.co/functions/v1/' || v_job;
    IF v_job = 'evaluate-risk-throttle' THEN
      v_header_name := 'X-Cron-Secret';
      v_header_value := v_secret;
    ELSE
      v_header_name := 'Authorization';
      v_header_value := 'Bearer ' || v_secret;
    END IF;

    SELECT status::int, content::text INTO v_status, v_content
    FROM http((
      'POST',
      v_url,
      ARRAY[
        http_header('Content-Type', 'application/json'),
        http_header(v_header_name, v_header_value)
      ],
      'application/json',
      '{}'
    )::http_request);

    INSERT INTO public.cron_http_runs (jobname, http_status, http_content)
    VALUES (v_job, v_status, COALESCE(v_content, ''));
  END LOOP;
END $$;