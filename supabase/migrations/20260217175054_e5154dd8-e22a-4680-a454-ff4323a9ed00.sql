
-- ============================================================
-- Provider-agnostic claim + fulfill RPCs (v2)
-- Keys off (provider, provider_session_id) instead of stripe_session_id.
-- Old RPCs remain for backward compat but are no longer the primary path.
-- ============================================================

-- Make (provider, provider_session_id) a full unique constraint for upsert support
-- Drop partial index first if it exists, then create full constraint
DROP INDEX IF EXISTS idx_cfq_provider_session;
ALTER TABLE public.checkout_fulfillment_queue
  ADD CONSTRAINT uq_cfq_provider_session UNIQUE (provider, provider_session_id);

-- Enforce NOT NULL on provider and provider_session_id for new rows
-- (existing rows already backfilled; this prevents future nulls)
ALTER TABLE public.checkout_fulfillment_queue
  ALTER COLUMN provider SET DEFAULT 'stripe',
  ALTER COLUMN provider_session_id SET NOT NULL;

-- v2 claim: provider-agnostic
CREATE OR REPLACE FUNCTION public.claim_checkout_fulfillment_v2(
  p_provider text,
  p_provider_session_id text
)
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
    attempts = COALESCE(cfq.attempts, 0) + 1,
    last_error = NULL,
    updated_at = now()
  WHERE cfq.provider = p_provider
    AND cfq.provider_session_id = p_provider_session_id
    AND cfq.fulfilled_account_id IS NULL
    AND cfq.status NOT IN ('fulfilled', 'failed', 'refunded')
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

REVOKE EXECUTE ON FUNCTION public.claim_checkout_fulfillment_v2(text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.claim_checkout_fulfillment_v2(text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.claim_checkout_fulfillment_v2(text, text) TO service_role;

-- v2 fulfill: provider-agnostic params
CREATE OR REPLACE FUNCTION public.fulfill_checkout_session_v2(
  p_queue_id uuid,
  p_user_id uuid,
  p_provider text,
  p_provider_session_id text,
  p_provider_payment_id text,
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
  v_q_provider text;
  v_q_provider_session text;
  v_q_user uuid;
  v_q_tier text;
  v_q_status text;
BEGIN
  -- 0. Lock queue row and validate params match
  SELECT provider, provider_session_id, user_id, tier_id, status, fulfilled_account_id
  INTO v_q_provider, v_q_provider_session, v_q_user, v_q_tier, v_q_status, v_existing_account_id
  FROM checkout_fulfillment_queue
  WHERE id = p_queue_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'QUEUE_ROW_MISSING: queue_id=% not found', p_queue_id;
  END IF;

  -- Param mismatch guard
  IF v_q_provider IS DISTINCT FROM p_provider
     OR v_q_provider_session IS DISTINCT FROM p_provider_session_id
     OR v_q_user IS DISTINCT FROM p_user_id
     OR v_q_tier IS DISTINCT FROM p_tier_id THEN
    RAISE EXCEPTION 'QUEUE_PARAM_MISMATCH: queue_id=% provider=%/% session=%/% user=%/% tier=%/%',
      p_queue_id, v_q_provider, p_provider, v_q_provider_session, p_provider_session_id,
      v_q_user, p_user_id, v_q_tier, p_tier_id;
  END IF;

  -- Already fulfilled → return existing
  IF v_existing_account_id IS NOT NULL THEN
    RETURN v_existing_account_id;
  END IF;

  -- Must be processing (claimed)
  IF v_q_status <> 'processing' THEN
    RAISE EXCEPTION 'QUEUE_NOT_PROCESSING: status=% queue_id=%', v_q_status, p_queue_id;
  END IF;

  -- Belt+suspenders: account already exists for this provider session
  SELECT id INTO v_existing_account_id
  FROM accounts
  WHERE stripe_session_id = p_provider_session_id;

  IF v_existing_account_id IS NOT NULL THEN
    UPDATE checkout_fulfillment_queue
    SET status = 'fulfilled',
        fulfilled_account_id = v_existing_account_id,
        processing_started_at = NULL,
        last_error = NULL,
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

  -- 3. Build rule snapshot (provider-agnostic)
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
    'provider', p_provider,
    'provider_session_id', p_provider_session_id,
    'provider_payment_id', p_provider_payment_id,
    'disclaimer_version', p_disclaimer_version,
    'product_description', p_product_description,
    'purchased_at', now()
  );

  -- 4. Create account
  BEGIN
    INSERT INTO accounts (
      user_id, cohort_id, account_number,
      starting_balance, current_balance, highest_balance,
      payout_cycle_start_balance, rule_snapshot, status,
      stripe_session_id
    ) VALUES (
      p_user_id, v_cohort.id, p_account_number,
      p_account_size, p_account_size, p_account_size,
      p_account_size, v_rule_snapshot, 'active',
      p_provider_session_id  -- Legacy column, stores provider session id
    )
    RETURNING id INTO v_account_id;
  EXCEPTION WHEN unique_violation THEN
    SELECT id INTO v_account_id
    FROM accounts
    WHERE stripe_session_id = p_provider_session_id;

    IF v_account_id IS NULL THEN
      RAISE;
    END IF;
  END;

  -- 5. Payment transaction (idempotent via ON CONFLICT)
  INSERT INTO payment_transactions (
    user_id, amount, currency, direction, purpose,
    provider, provider_payment_id, status, idempotency_key, metadata
  ) VALUES (
    p_user_id,
    p_amount_cents / 100.0,
    p_currency,
    'inbound',
    'evaluation_purchase',
    p_provider,
    p_provider_payment_id,
    'completed',
    p_provider || ':checkout:' || p_provider_session_id,
    jsonb_build_object(
      'tier_id', p_tier_id,
      'account_id', v_account_id,
      'account_number', p_account_number,
      'provider', p_provider,
      'provider_session_id', p_provider_session_id
    )
  )
  ON CONFLICT (idempotency_key) DO NOTHING;

  -- 6. Mark queue fulfilled
  UPDATE checkout_fulfillment_queue
  SET status = 'fulfilled',
      fulfilled_account_id = v_account_id,
      processing_started_at = NULL,
      last_error = NULL,
      updated_at = now()
  WHERE id = p_queue_id;

  RETURN v_account_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fulfill_checkout_session_v2(uuid, uuid, text, text, text, integer, text, text, text, text, numeric, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fulfill_checkout_session_v2(uuid, uuid, text, text, text, integer, text, text, text, text, numeric, text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.fulfill_checkout_session_v2(uuid, uuid, text, text, text, integer, text, text, text, text, numeric, text, text) TO service_role;
