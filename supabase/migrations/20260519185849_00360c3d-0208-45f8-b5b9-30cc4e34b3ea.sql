DO $$
DECLARE
  v_scrubbed_count integer := 0;
  v_offenders jsonb;
BEGIN
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'share_id', id,
    'original_display_name', display_name,
    'reason', CASE
      WHEN length(display_name) > 40 THEN 'too_long'
      WHEN display_name !~ '^[A-Za-z0-9 ._\-]+$' THEN 'invalid_charset'
      WHEN lower(display_name) ~ '(admin|meridian|support|staff|official|moderator|system|fuck|shit|bitch|cunt|nigger|faggot)' THEN 'blocklist'
      ELSE 'other'
    END
  )), '[]'::jsonb)
  INTO v_offenders
  FROM public.payout_shares
  WHERE display_name IS NOT NULL
    AND display_name <> ''
    AND (
      length(display_name) > 40
      OR display_name !~ '^[A-Za-z0-9 ._\-]+$'
      OR lower(display_name) ~ '(admin|meridian|support|staff|official|moderator|system|fuck|shit|bitch|cunt|nigger|faggot)'
    );

  ALTER TABLE public.payout_shares DISABLE TRIGGER payout_shares_validate_display_name;

  UPDATE public.payout_shares
  SET display_name = NULL
  WHERE display_name IS NOT NULL
    AND display_name <> ''
    AND (
      length(display_name) > 40
      OR display_name !~ '^[A-Za-z0-9 ._\-]+$'
      OR lower(display_name) ~ '(admin|meridian|support|staff|official|moderator|system|fuck|shit|bitch|cunt|nigger|faggot)'
    );

  GET DIAGNOSTICS v_scrubbed_count = ROW_COUNT;

  ALTER TABLE public.payout_shares ENABLE TRIGGER payout_shares_validate_display_name;

  BEGIN
    INSERT INTO public.audit_logs (action, details, reason, idempotency_key, prev_hash, row_hash)
    VALUES (
      'system_config_change',
      jsonb_build_object(
        'event', 'payout_shares_display_name_backfill',
        'scrubbed_count', v_scrubbed_count,
        'offenders', v_offenders
      ),
      'One-shot backfill to enforce display_name validator',
      'payout_shares_display_name_backfill_' || extract(epoch from now())::text,
      'BACKFILL',
      encode(sha256(('payout_shares_display_name_backfill_' || v_scrubbed_count::text)::bytea), 'hex')
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'Audit log insert skipped: %', SQLERRM;
  END;

  RAISE NOTICE 'Scrubbed % invalid payout_shares.display_name values', v_scrubbed_count;
END $$;