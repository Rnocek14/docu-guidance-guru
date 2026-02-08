
-- ============================================================
-- Checkout Fulfillment Queue
-- Prevents "customer paid but no account" support hell.
-- Webhook always inserts a queue row first (idempotent by session_id).
-- If breaker blocks, row stays 'queued'. Staff/cron can retry later.
-- ============================================================

CREATE TABLE public.checkout_fulfillment_queue (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  stripe_session_id text NOT NULL,
  user_id uuid NOT NULL,
  tier_id text NOT NULL,
  payment_intent text,
  amount_cents integer,
  currency text DEFAULT 'usd',
  status text NOT NULL DEFAULT 'queued',
  last_error text,
  attempts integer NOT NULL DEFAULT 0,
  fulfilled_account_id uuid REFERENCES public.accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT checkout_fulfillment_queue_session_unique UNIQUE (stripe_session_id),
  CONSTRAINT checkout_fulfillment_queue_status_check CHECK (status IN ('queued', 'fulfilled', 'failed', 'refunded'))
);

-- RLS: service-role only writes, staff can read
ALTER TABLE public.checkout_fulfillment_queue ENABLE ROW LEVEL SECURITY;

CREATE POLICY "No client inserts on fulfillment queue"
  ON public.checkout_fulfillment_queue FOR INSERT
  WITH CHECK (false);

CREATE POLICY "No client updates on fulfillment queue"
  ON public.checkout_fulfillment_queue FOR UPDATE
  USING (false);

CREATE POLICY "No client deletes on fulfillment queue"
  ON public.checkout_fulfillment_queue FOR DELETE
  USING (false);

CREATE POLICY "Staff can view fulfillment queue"
  ON public.checkout_fulfillment_queue FOR SELECT
  USING (has_any_role(auth.uid(), ARRAY['risk_officer'::app_role, 'support'::app_role, 'admin'::app_role]));

-- Index for retry queries (find queued items)
CREATE INDEX idx_fulfillment_queue_status ON public.checkout_fulfillment_queue (status) WHERE status = 'queued';
