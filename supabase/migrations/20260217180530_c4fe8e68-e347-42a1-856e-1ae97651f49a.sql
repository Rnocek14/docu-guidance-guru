
-- ============================================================
-- Add provider-native columns to accounts table
-- Stop depending on stripe_session_id for provider-agnostic flows
-- ============================================================

-- Add provider columns (nullable for legacy rows)
ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS provider text,
  ADD COLUMN IF NOT EXISTS provider_session_id text,
  ADD COLUMN IF NOT EXISTS provider_payment_id text;

-- Backfill existing Stripe rows
UPDATE public.accounts
SET provider = 'stripe',
    provider_session_id = stripe_session_id,
    provider_payment_id = NULL
WHERE stripe_session_id IS NOT NULL
  AND provider IS NULL;

-- Unique constraint for provider-agnostic dedupe
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_provider_session
  ON public.accounts (provider, provider_session_id)
  WHERE provider IS NOT NULL AND provider_session_id IS NOT NULL;

-- ============================================================
-- Update fulfill_checkout_session_v2 to use provider columns
-- ============================================================
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
  v_cohort_id uuid;
  v_account_id uuid;
  v_existing_account_id uuid;
BEGIN
  -- Belt-and-suspenders: check if already fulfilled via provider columns
  SELECT id INTO v_existing_account_id
  FROM accounts
  WHERE provider = p_provider
    AND provider_session_id = p_provider_session_id;

  IF v_existing_account_id IS NOT NULL THEN
    -- Mark queue as fulfilled (idempotent)
    UPDATE checkout_fulfillment_queue
    SET status = 'fulfilled',
        fulfilled_account_id = v_existing_account_id,
        updated_at = now()
    WHERE id = p_queue_id;
    RETURN v_existing_account_id;
  END IF;

  -- Resolve cohort
  SELECT id INTO v_cohort_id
  FROM cohorts
  WHERE name = p_cohort_name
    AND is_active = true
  ORDER BY version DESC
  LIMIT 1;

  IF v_cohort_id IS NULL THEN
    RAISE EXCEPTION 'No active cohort found for name: %', p_cohort_name;
  END IF;

  -- Create account with provider-native columns
  INSERT INTO accounts (
    user_id, cohort_id, account_number,
    starting_balance, current_balance, highest_balance,
    status,
    provider, provider_session_id, provider_payment_id,
    stripe_session_id
  ) VALUES (
    p_user_id, v_cohort_id, p_account_number,
    p_account_size, p_account_size, p_account_size,
    'active',
    p_provider, p_provider_session_id, p_provider_payment_id,
    CASE WHEN p_provider = 'stripe' THEN p_provider_session_id ELSE NULL END
  )
  RETURNING id INTO v_account_id;

  -- Record payment transaction
  INSERT INTO payment_transactions (
    user_id, provider, provider_payment_id,
    amount, currency, direction, purpose, status,
    idempotency_key, rail_key,
    metadata
  ) VALUES (
    p_user_id, p_provider, p_provider_payment_id,
    p_amount_cents / 100.0, p_currency, 'inbound', 'evaluation_purchase', 'completed',
    'fulfill:' || p_provider || ':' || p_provider_session_id,
    p_provider || '_card',
    jsonb_build_object(
      'queue_id', p_queue_id,
      'tier_id', p_tier_id,
      'account_id', v_account_id,
      'disclaimer_version', p_disclaimer_version,
      'product_description', p_product_description
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
