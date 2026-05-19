
-- ── Account-level reset credit bank ──────────────────────────
ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS reset_credits_remaining integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_reset_at timestamptz;

-- ── Purchase lineage ──────────────────────────────────────────
ALTER TABLE public.reset_purchases
  ADD COLUMN IF NOT EXISTS applied_at timestamptz,
  ADD COLUMN IF NOT EXISTS restored_account boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS provider_event_id text;

CREATE UNIQUE INDEX IF NOT EXISTS reset_purchases_provider_event_uniq
  ON public.reset_purchases (provider, provider_event_id)
  WHERE provider_event_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS reset_purchases_account_status_idx
  ON public.reset_purchases (account_id, status);

-- ── Apply-reset RPC ───────────────────────────────────────────
-- Marks the purchase as paid; if the account is currently breached,
-- consumes 1 reset credit and restores it to starting balance.
-- Remaining credits stay banked on accounts.reset_credits_remaining.
-- Fully idempotent: a second call with the same purchase is a no-op.
CREATE OR REPLACE FUNCTION public.apply_reset_from_purchase(
  p_purchase_id uuid,
  p_provider_event_id text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_purchase reset_purchases%ROWTYPE;
  v_account  accounts%ROWTYPE;
  v_restored boolean := false;
  v_credits_added integer;
  v_starting numeric;
BEGIN
  -- Lock the purchase row
  SELECT * INTO v_purchase
  FROM reset_purchases
  WHERE id = p_purchase_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'PURCHASE_NOT_FOUND';
  END IF;

  -- Idempotency: already applied → no-op
  IF v_purchase.status = 'paid' AND v_purchase.applied_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'idempotent', true, 'purchase_id', p_purchase_id);
  END IF;

  -- Lock the target account
  SELECT * INTO v_account
  FROM accounts
  WHERE id = v_purchase.account_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ACCOUNT_NOT_FOUND';
  END IF;

  v_starting := v_account.starting_balance;
  v_credits_added := v_purchase.resets_total;

  -- If the account is currently breached, consume 1 credit to restore it now.
  IF v_account.status = 'breached_detected' AND v_credits_added > 0 THEN
    UPDATE accounts
    SET
      status = 'active',
      current_balance = v_starting,
      highest_balance = v_starting,
      daily_pnl = 0,
      daily_pnl_start_balance = v_starting,
      payout_cycle_start_balance = v_starting,
      payout_cycle_started_at = now(),
      failed_at = NULL,
      last_reset_at = now(),
      reset_credits_remaining = reset_credits_remaining + (v_credits_added - 1),
      updated_at = now()
    WHERE id = v_account.id;
    v_restored := true;
  ELSE
    -- Just bank all credits
    UPDATE accounts
    SET
      reset_credits_remaining = reset_credits_remaining + v_credits_added,
      updated_at = now()
    WHERE id = v_account.id;
  END IF;

  -- Mark purchase paid & applied
  UPDATE reset_purchases
  SET
    status = 'paid',
    paid_at = COALESCE(paid_at, now()),
    applied_at = now(),
    restored_account = v_restored,
    provider_event_id = COALESCE(provider_event_id, p_provider_event_id),
    updated_at = now()
  WHERE id = p_purchase_id;

  -- Audit log entry (chain trigger sets row_hash/prev_hash)
  INSERT INTO audit_logs (
    action, account_id, user_id, idempotency_key, details, reason
  ) VALUES (
    'status_changed',
    v_account.id,
    v_purchase.user_id,
    'reset_applied:' || p_purchase_id::text,
    jsonb_build_object(
      'event', 'reset_applied',
      'purchase_id', p_purchase_id,
      'bundle_id', v_purchase.bundle_id,
      'credits_added', v_credits_added,
      'restored_account', v_restored,
      'amount_paid_cents', v_purchase.amount_paid_cents,
      'provider', v_purchase.provider,
      'provider_session_id', v_purchase.provider_session_id,
      'provider_event_id', p_provider_event_id
    ),
    CASE WHEN v_restored
         THEN 'Reset bundle paid; account restored to starting balance'
         ELSE 'Reset bundle paid; credits banked' END
  )
  ON CONFLICT (idempotency_key) DO NOTHING;

  -- Account event for trader-visible timeline
  INSERT INTO account_events (
    account_id, event_type, idempotency_key, event_data
  ) VALUES (
    v_account.id,
    'daily_reset',  -- closest existing enum; details disambiguate
    'reset_applied_evt:' || p_purchase_id::text,
    jsonb_build_object(
      'event', 'reset_applied',
      'purchase_id', p_purchase_id,
      'bundle_id', v_purchase.bundle_id,
      'credits_added', v_credits_added,
      'restored_account', v_restored
    )
  )
  ON CONFLICT (idempotency_key) DO NOTHING;

  RETURN jsonb_build_object(
    'ok', true,
    'restored_account', v_restored,
    'credits_added', v_credits_added,
    'purchase_id', p_purchase_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.apply_reset_from_purchase(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_reset_from_purchase(uuid, text) TO service_role;

-- ── Future helper: consume a banked credit when a fresh breach happens ────
CREATE OR REPLACE FUNCTION public.consume_reset_credit_if_breached(p_account_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account accounts%ROWTYPE;
BEGIN
  SELECT * INTO v_account FROM accounts WHERE id = p_account_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF v_account.status <> 'breached_detected' OR v_account.reset_credits_remaining < 1 THEN
    RETURN false;
  END IF;

  UPDATE accounts
  SET
    status = 'active',
    current_balance = starting_balance,
    highest_balance = starting_balance,
    daily_pnl = 0,
    daily_pnl_start_balance = starting_balance,
    payout_cycle_start_balance = starting_balance,
    payout_cycle_started_at = now(),
    failed_at = NULL,
    last_reset_at = now(),
    reset_credits_remaining = reset_credits_remaining - 1,
    updated_at = now()
  WHERE id = p_account_id;

  INSERT INTO audit_logs (action, account_id, user_id, idempotency_key, details, reason)
  VALUES (
    'status_changed', p_account_id, v_account.user_id,
    'reset_credit_consumed:' || p_account_id::text || ':' || extract(epoch from now())::text,
    jsonb_build_object('event','reset_credit_consumed','remaining', v_account.reset_credits_remaining - 1),
    'Banked reset credit consumed to restore breached account'
  )
  ON CONFLICT (idempotency_key) DO NOTHING;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.consume_reset_credit_if_breached(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_reset_credit_if_breached(uuid) TO service_role;
