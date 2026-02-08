
-- ============================================================
-- ATOMIC CHECKOUT FULFILLMENT
-- P0-1: claim_checkout_fulfillment RPC (FOR UPDATE + processing)
-- P0-2: accounts.stripe_session_id unique constraint
-- P0-3: fulfill_checkout_session atomic RPC
-- P0-4: Add 'processing' to fulfillment queue status check
-- ============================================================

-- 1. Add stripe_session_id to accounts (hard uniqueness)
ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS stripe_session_id text;

CREATE UNIQUE INDEX IF NOT EXISTS ux_accounts_stripe_session_id
  ON public.accounts (stripe_session_id)
  WHERE stripe_session_id IS NOT NULL;

-- 2. Expand fulfillment queue status to include 'processing'
ALTER TABLE public.checkout_fulfillment_queue
  DROP CONSTRAINT IF EXISTS checkout_fulfillment_queue_status_check;

ALTER TABLE public.checkout_fulfillment_queue
  ADD CONSTRAINT checkout_fulfillment_queue_status_check
  CHECK (status IN ('queued', 'processing', 'fulfilled', 'failed', 'refunded'));

-- 3. Claim RPC: atomically lock + flip to 'processing'
CREATE OR REPLACE FUNCTION public.claim_checkout_fulfillment(p_session_id text)
RETURNS TABLE (
  id uuid,
  status text,
  user_id uuid,
  tier_id text,
  fulfilled_account_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  UPDATE checkout_fulfillment_queue
  SET
    status = 'processing',
    attempts = attempts + 1,
    updated_at = now()
  WHERE stripe_session_id = p_session_id
    AND status IN ('queued', 'processing')
    AND fulfilled_account_id IS NULL
  RETURNING
    checkout_fulfillment_queue.id,
    checkout_fulfillment_queue.status,
    checkout_fulfillment_queue.user_id,
    checkout_fulfillment_queue.tier_id,
    checkout_fulfillment_queue.fulfilled_account_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.claim_checkout_fulfillment(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_checkout_fulfillment(text) TO service_role;

-- 4. Atomic fulfillment RPC: breaker check + account + txn + queue update
--    in a single transaction. Returns account_id or raises exception.
CREATE OR REPLACE FUNCTION public.fulfill_checkout_session(
  p_queue_id uuid,
  p_user_id uuid,
  p_stripe_session_id text,
  p_payment_intent text,
  p_amount_cents integer,
  p_currency text,
  p_tier_id text,
  p_cohort_id uuid,
  p_account_number text,
  p_account_size numeric,
  p_rule_snapshot jsonb,
  p_disclaimer_version text DEFAULT 'v1',
  p_product_description text DEFAULT 'Simulated trading evaluation access'
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_frozen boolean;
  v_account_id uuid;
BEGIN
  -- Breaker gate (fail-closed)
  SELECT evaluations_frozen INTO v_frozen
  FROM econ_breaker_state
  WHERE id = '00000000-0000-0000-0000-000000000001'
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'BREAKER_STATE_MISSING: fail-closed';
  END IF;

  IF v_frozen THEN
    RAISE EXCEPTION 'EVALUATIONS_FROZEN: intake blocked by circuit breaker';
  END IF;

  -- Create account (stripe_session_id unique prevents duplicates)
  INSERT INTO accounts (
    user_id, cohort_id, account_number,
    starting_balance, current_balance, highest_balance,
    payout_cycle_start_balance, rule_snapshot, status,
    stripe_session_id
  ) VALUES (
    p_user_id, p_cohort_id, p_account_number,
    p_account_size, p_account_size, p_account_size,
    p_account_size, p_rule_snapshot, 'active',
    p_stripe_session_id
  )
  RETURNING id INTO v_account_id;

  -- Payment transaction (audit trail)
  INSERT INTO payment_transactions (
    user_id, amount, currency, direction, purpose,
    provider, provider_payment_id, status, idempotency_key, metadata
  ) VALUES (
    p_user_id,
    p_amount_cents / 100.0,
    p_currency,
    'inbound',
    'evaluation_purchase',
    'stripe',
    p_payment_intent,
    'completed',
    'stripe:checkout:' || p_stripe_session_id,
    jsonb_build_object(
      'tier_id', p_tier_id,
      'account_id', v_account_id,
      'account_number', p_account_number,
      'stripe_session_id', p_stripe_session_id
    )
  );

  -- Mark queue fulfilled
  UPDATE checkout_fulfillment_queue
  SET status = 'fulfilled',
      fulfilled_account_id = v_account_id,
      updated_at = now()
  WHERE id = p_queue_id;

  RETURN v_account_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fulfill_checkout_session(uuid, uuid, text, text, integer, text, text, uuid, text, numeric, jsonb, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fulfill_checkout_session(uuid, uuid, text, text, integer, text, text, uuid, text, numeric, jsonb, text, text) TO service_role;
