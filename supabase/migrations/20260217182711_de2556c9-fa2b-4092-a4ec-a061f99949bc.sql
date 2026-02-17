
-- Harden checkout_fulfillment_queue: provider NOT NULL + CHECK + partial event_id dedupe

-- Backfill any nulls
UPDATE public.checkout_fulfillment_queue
SET provider = 'stripe'
WHERE provider IS NULL;

-- Enforce NOT NULL
ALTER TABLE public.checkout_fulfillment_queue
  ALTER COLUMN provider SET NOT NULL,
  ALTER COLUMN provider SET DEFAULT 'stripe';

-- CHECK constraints to prevent empty strings
ALTER TABLE public.checkout_fulfillment_queue
  ADD CONSTRAINT chk_cfq_provider_not_empty CHECK (provider <> ''),
  ADD CONSTRAINT chk_cfq_provider_session_id_not_empty CHECK (provider_session_id <> '');

-- Partial unique on (provider, provider_event_id) — helper dedupe only
CREATE UNIQUE INDEX IF NOT EXISTS idx_cfq_provider_event_id
  ON public.checkout_fulfillment_queue (provider, provider_event_id)
  WHERE provider_event_id IS NOT NULL;
