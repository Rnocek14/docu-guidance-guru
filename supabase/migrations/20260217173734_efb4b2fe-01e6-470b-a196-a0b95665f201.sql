
-- ============================================================
-- Provider-agnostic checkout fulfillment queue columns
-- Removes Stripe-specific coupling from the queue table
-- ============================================================

-- Add canonical provider fields
ALTER TABLE public.checkout_fulfillment_queue
  ADD COLUMN IF NOT EXISTS provider text,
  ADD COLUMN IF NOT EXISTS provider_session_id text,
  ADD COLUMN IF NOT EXISTS provider_event_id text,
  ADD COLUMN IF NOT EXISTS provider_payment_id text,
  ADD COLUMN IF NOT EXISTS rail_key text;

-- Backfill existing rows: all current data is Stripe
UPDATE public.checkout_fulfillment_queue
SET
  provider = 'stripe',
  provider_session_id = stripe_session_id,
  provider_payment_id = payment_intent
WHERE provider IS NULL;

-- Unique indexes for cross-provider idempotency
CREATE UNIQUE INDEX IF NOT EXISTS idx_cfq_provider_session
  ON public.checkout_fulfillment_queue (provider, provider_session_id)
  WHERE provider_session_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_cfq_provider_event
  ON public.checkout_fulfillment_queue (provider, provider_event_id)
  WHERE provider_event_id IS NOT NULL;

-- Add approved_at to payouts for accurate SLA measurement
ALTER TABLE public.payouts
  ADD COLUMN IF NOT EXISTS approved_at timestamptz;

-- Backfill approved_at from reviewed_at where status is approved or later
UPDATE public.payouts
SET approved_at = reviewed_at
WHERE approved_at IS NULL
  AND reviewed_at IS NOT NULL
  AND status IN ('approved', 'payment_initiated', 'paid', 'paid_confirmed');
