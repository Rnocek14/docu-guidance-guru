
-- ============================================================
-- HARDEN: claim + fulfill idempotency & race safety
-- 1. claim: only 'queued', or stale 'processing' (>10 min)
-- 2. fulfill: idempotent — return existing account if already fulfilled
-- ============================================================

-- 1. Add processing_started_at for staleness detection
ALTER TABLE public.checkout_fulfillment_queue
  ADD COLUMN IF NOT EXISTS processing_started_at timestamptz;

-- 2. Hardened claim: only queued, or stale processing
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
  UPDATE checkout_fulfillment_queue cfq
  SET
    status = 'processing',
    processing_started_at = now(),
    attempts = cfq.attempts + 1,
    updated_at = now()
  WHERE cfq.stripe_session_id = p_session_id
    AND cfq.fulfilled_account_id IS NULL
    AND (
      cfq.status = 'queued'
      OR (cfq.status = 'processing' AND cfq.processing_started_at < now() - interval '10 minutes')
    )
  RETURNING
    cfq.id,
    cfq.status,
    cfq.user_id,
    cfq.tier_id,
    cfq.fulfilled_account_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.claim_checkout_fulfillment(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_checkout_fulfillment(text) TO service_role;

-- 3. Hardened fulfill: idempotent (return existing account if already fulfilled)
CREATE OR REPLACE FUNCTION public.fulfill_checkout_session(
  p_queue_id uuid,
  p_user_id uuid,
  p_stripe_session_id text,
  p_payment_intent text,
  p_amount_cents integer,
  p_currency text,
  p_tier_id text,
  p_cohort_name text,
  p_account_number text,
  p_account_size numeric,
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
  v_cohort record;
  v_rule_snapshot jsonb;
  v_existing_account_id uuid;
BEGIN
  -- 0. Idempotency: if queue row already fulfilled, return existing account
  SELECT fulfilled_account_id INTO v_existing_account_id
  FROM checkout_fulfillment_queue
  WHERE id = p_queue_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'QUEUE_ROW_MISSING: queue_id=% not found', p_queue_id;
  END IF;

  IF v_existing_account_id IS NOT NULL THEN
    RETURN v_existing_account_id;
  END IF;

  -- Also check if an account already exists for this session (belt + suspenders)
  SELECT id INTO v_existing_account_id
  FROM accounts
  WHERE stripe_session_id = p_stripe_session_id;

  IF v_existing_account_id IS NOT NULL THEN
    -- Heal the queue row
    UPDATE checkout_fulfillment_queue
    SET status = 'fulfilled',
        fulfilled_account_id = v_existing_account_id,
        updated_at = now()
    WHERE id = p_queue_id;
    RETURN v_existing_account_id;
  END IF;

  -- 1. Breaker gate (fail-closed)
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

  -- 2. Resolve cohort (DB-authoritative)
  SELECT * INTO v_cohort
  FROM cohorts
  WHERE name = p_cohort_name
    AND is_active = true
    AND intake_active = true
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'COHORT_NOT_FOUND: name=% not active/intake', p_cohort_name;
  END IF;

  -- 3. Build rule snapshot
  v_rule_snapshot := jsonb_build_object(
    'cohort_id', v_cohort.id,
    'cohort_name', v_cohort.name,
    'cohort_version', v_cohort.version,
    'max_daily_loss_percent', v_cohort.max_daily_loss_percent,
    'max_total_drawdown_percent', v_cohort.max_total_drawdown_percent,
    'profit_target_percent', v_cohort.profit_target_percent,
    'min_trading_days', v_cohort.min_trading_days,
    'max_position_size_percent', v_cohort.max_position_size_percent,
    'payout_split_percent', v_cohort.payout_split_percent,
    'max_payout_percent', v_cohort.max_payout_percent,
    'max_payout_absolute', v_cohort.max_payout_absolute,
    'payout_cooldown_days', v_cohort.payout_cooldown_days,
    'min_trading_days_between_payouts', v_cohort.min_trading_days_between_payouts,
    'payout_eligibility_delay_days', v_cohort.payout_eligibility_delay_days,
    'first_payout_cap_amount', v_cohort.first_payout_cap_amount,
    'lifetime_cap_multiple', v_cohort.lifetime_cap_multiple,
    'entry_fee', v_cohort.entry_fee,
    'stripe_session_id', p_stripe_session_id,
    'stripe_payment_intent', p_payment_intent,
    'disclaimer_version', p_disclaimer_version,
    'product_description', p_product_description,
    'purchased_at', now()
  );

  -- 4. Create account
  INSERT INTO accounts (
    user_id, cohort_id, account_number,
    starting_balance, current_balance, highest_balance,
    payout_cycle_start_balance, rule_snapshot, status,
    stripe_session_id
  ) VALUES (
    p_user_id, v_cohort.id, p_account_number,
    p_account_size, p_account_size, p_account_size,
    p_account_size, v_rule_snapshot, 'active',
    p_stripe_session_id
  )
  RETURNING id INTO v_account_id;

  -- 5. Payment transaction
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

  -- 6. Mark queue fulfilled
  UPDATE checkout_fulfillment_queue
  SET status = 'fulfilled',
      fulfilled_account_id = v_account_id,
      updated_at = now()
  WHERE id = p_queue_id;

  RETURN v_account_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fulfill_checkout_session(uuid, uuid, text, text, integer, text, text, text, text, numeric, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fulfill_checkout_session(uuid, uuid, text, text, integer, text, text, text, text, numeric, text, text) TO service_role;
