
-- Add rules acknowledgement fields to checkout_fulfillment_queue
ALTER TABLE public.checkout_fulfillment_queue
  ADD COLUMN rules_acknowledged boolean NOT NULL DEFAULT false,
  ADD COLUMN rules_acknowledged_at timestamp with time zone,
  ADD COLUMN rules_version text NOT NULL DEFAULT 'v1.0';
