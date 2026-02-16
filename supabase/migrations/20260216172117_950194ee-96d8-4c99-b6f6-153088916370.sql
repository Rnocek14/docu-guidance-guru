
-- 1) Add provider lifecycle columns to accounts (nullable for backward compat)
ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS external_provider text,
  ADD COLUMN IF NOT EXISTS external_account_id text,
  ADD COLUMN IF NOT EXISTS external_user_id text,
  ADD COLUMN IF NOT EXISTS external_status text,
  ADD COLUMN IF NOT EXISTS provisioned_at timestamptz,
  ADD COLUMN IF NOT EXISTS disabled_at timestamptz,
  ADD COLUMN IF NOT EXISTS provider_metadata jsonb DEFAULT '{}'::jsonb;

-- 2) Index for fast lookup by provider + external account
CREATE INDEX IF NOT EXISTS idx_accounts_external_provider_account
  ON public.accounts (external_provider, external_account_id)
  WHERE external_provider IS NOT NULL;

-- 3) Provider webhook events table — truth log for all provider interactions
CREATE TABLE IF NOT EXISTS public.provider_webhook_events (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  provider text NOT NULL,
  event_id text,
  event_type text NOT NULL DEFAULT 'unknown',
  external_account_id text,
  raw_body text NOT NULL,
  raw_hash text NOT NULL,
  headers_subset jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'received',
  error text,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Unique on raw_hash to prevent duplicate processing
CREATE UNIQUE INDEX IF NOT EXISTS provider_webhook_events_raw_hash_unique
  ON public.provider_webhook_events (raw_hash);

-- Index for querying by provider + event_id
CREATE INDEX IF NOT EXISTS idx_provider_webhook_events_provider_event
  ON public.provider_webhook_events (provider, event_id)
  WHERE event_id IS NOT NULL;

-- 4) RLS on provider_webhook_events — service role only
ALTER TABLE public.provider_webhook_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "deny_all_client_access" ON public.provider_webhook_events
  AS RESTRICTIVE FOR ALL
  USING (false)
  WITH CHECK (false);

-- 5) Provider API call log — tracks provision/disable/status calls
CREATE TABLE IF NOT EXISTS public.provider_api_calls (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  provider text NOT NULL,
  action text NOT NULL,
  account_id uuid REFERENCES public.accounts(id),
  external_account_id text,
  request_payload jsonb DEFAULT '{}'::jsonb,
  response_payload jsonb DEFAULT '{}'::jsonb,
  http_status integer,
  success boolean NOT NULL DEFAULT false,
  error text,
  latency_ms integer,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_provider_api_calls_account
  ON public.provider_api_calls (account_id);

-- RLS — service role only
ALTER TABLE public.provider_api_calls ENABLE ROW LEVEL SECURITY;

CREATE POLICY "deny_all_client_access" ON public.provider_api_calls
  AS RESTRICTIVE FOR ALL
  USING (false)
  WITH CHECK (false);
