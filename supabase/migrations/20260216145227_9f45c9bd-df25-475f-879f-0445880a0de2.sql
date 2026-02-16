-- 1) Unique index on stripe_session_id (prevents duplicate queue rows)
CREATE UNIQUE INDEX IF NOT EXISTS checkout_queue_stripe_session_unique
ON public.checkout_fulfillment_queue (stripe_session_id);

-- 2) Unique partial index on payment_intent (prevents duplicate fulfillments)
CREATE UNIQUE INDEX IF NOT EXISTS checkout_queue_payment_intent_unique
ON public.checkout_fulfillment_queue (payment_intent)
WHERE payment_intent IS NOT NULL;