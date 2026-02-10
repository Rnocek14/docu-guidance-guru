
-- Temporary table for capturing raw broker payloads during schema discovery
-- Should be cleaned up once Zod schemas are locked
CREATE TABLE public.broker_payload_samples (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  broker text NOT NULL,
  request_id uuid NOT NULL,
  raw_body text NOT NULL,
  raw_hash text NOT NULL,
  headers_subset jsonb NOT NULL DEFAULT '{}'::jsonb,
  notes text
);

ALTER TABLE public.broker_payload_samples ENABLE ROW LEVEL SECURITY;

-- No client access at all
CREATE POLICY "deny_all_client_access" ON public.broker_payload_samples
  AS RESTRICTIVE FOR ALL USING (false) WITH CHECK (false);

-- Auto-cleanup: delete samples older than 7 days
CREATE OR REPLACE FUNCTION public.cleanup_old_payload_samples()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  DELETE FROM public.broker_payload_samples
  WHERE created_at < now() - interval '7 days';
$$;

REVOKE EXECUTE ON FUNCTION public.cleanup_old_payload_samples() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.cleanup_old_payload_samples() FROM anon;
GRANT EXECUTE ON FUNCTION public.cleanup_old_payload_samples() TO service_role;
