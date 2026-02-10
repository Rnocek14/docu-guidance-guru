
-- Add indexes for efficient querying and dedup
CREATE INDEX IF NOT EXISTS broker_payload_samples_created_at_idx
  ON public.broker_payload_samples (created_at DESC);

CREATE INDEX IF NOT EXISTS broker_payload_samples_broker_created_at_idx
  ON public.broker_payload_samples (broker, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS broker_payload_samples_raw_hash_unique
  ON public.broker_payload_samples (raw_hash);

-- Belt + suspenders: explicitly revoke table privileges
REVOKE ALL ON TABLE public.broker_payload_samples FROM PUBLIC;
REVOKE ALL ON TABLE public.broker_payload_samples FROM anon;
REVOKE ALL ON TABLE public.broker_payload_samples FROM authenticated;
GRANT ALL ON TABLE public.broker_payload_samples TO service_role;

-- Seed the capture gate setting (disabled by default)
INSERT INTO public.system_settings (key, value, updated_at)
VALUES ('tradovate_payload_capture_enabled', 'false'::jsonb, now())
ON CONFLICT (key) DO NOTHING;

-- Replace cleanup function with plpgsql version for robustness
CREATE OR REPLACE FUNCTION public.cleanup_broker_payload_samples()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.broker_payload_samples
  WHERE created_at < now() - interval '7 days';
END;
$$;

REVOKE ALL ON FUNCTION public.cleanup_broker_payload_samples() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cleanup_broker_payload_samples() FROM anon;
GRANT EXECUTE ON FUNCTION public.cleanup_broker_payload_samples() TO service_role;
