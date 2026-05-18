-- ============================================================
-- P0-2: Atomic refund handler
-- Replaces the sequence of non-atomic Supabase client calls in
-- supabase/functions/stripe-webhook/refund-handler.ts with a single
-- transactional RPC. Race-safe under concurrent webhook delivery.
-- ============================================================

CREATE OR REPLACE FUNCTION public.handle_charge_refunded(
  p_charge_id text,
  p_payment_intent_id text,
  p_refund_amount_cents integer,
  p_currency text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_txn_id uuid;
  v_txn_user_id uuid;
  v_txn_status text;
  v_txn_metadata jsonb;
  v_account_id uuid;
  v_account_user_id uuid;
  v_account_status text;
  v_account_number text;
  v_session_id text;
  v_already_terminal boolean;
  v_cancelled jsonb := '[]'::jsonb;
  v_in_transit jsonb := '[]'::jsonb;
  v_cancelled_count integer := 0;
  v_in_transit_count integer := 0;
  v_payout record;
BEGIN
  -- ── Step 1: Lock the payment transaction row ───────────────
  -- FOR UPDATE serialises concurrent refund webhooks for the same charge.
  SELECT id, user_id, status, metadata
    INTO v_txn_id, v_txn_user_id, v_txn_status, v_txn_metadata
  FROM payment_transactions
  WHERE provider = 'stripe'
    AND provider_payment_id = p_payment_intent_id
    AND purpose = 'evaluation_purchase'
  ORDER BY created_at ASC
  LIMIT 1
  FOR UPDATE;

  IF v_txn_id IS NULL THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'no_transaction',
      'payment_intent_id', p_payment_intent_id
    );
  END IF;

  -- ── Step 2: Idempotency guard ──────────────────────────────
  IF v_txn_status = 'refunded' THEN
    RETURN jsonb_build_object(
      'ok', true,
      'already_processed', true,
      'transaction_id', v_txn_id
    );
  END IF;

  v_account_id := (v_txn_metadata ->> 'account_id')::uuid;
  v_session_id := v_txn_metadata ->> 'stripe_session_id';

  IF v_account_id IS NULL THEN
    -- Still mark the txn as refunded so we don't loop forever, but no account work.
    UPDATE payment_transactions
       SET status = 'refunded', updated_at = now()
     WHERE id = v_txn_id;
    RETURN jsonb_build_object(
      'ok', true,
      'reason', 'no_account_id_in_metadata',
      'transaction_id', v_txn_id
    );
  END IF;

  -- ── Step 3: Lock the account row ───────────────────────────
  SELECT id, user_id, status, account_number
    INTO v_account_id, v_account_user_id, v_account_status, v_account_number
  FROM accounts
  WHERE id = v_account_id
  FOR UPDATE;

  IF v_account_id IS NULL THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'account_not_found',
      'transaction_id', v_txn_id
    );
  END IF;

  v_already_terminal := v_account_status IN ('failed_confirmed', 'closed');

  -- ── Step 4: Auto-reject cancellable payouts (funds NOT sent) ──
  -- Lock with FOR UPDATE to serialise against payout-actions.
  FOR v_payout IN
    SELECT id, status, amount
      FROM payouts
     WHERE account_id = v_account_id
       AND status IN ('pending', 'under_review', 'approved')
     FOR UPDATE
  LOOP
    UPDATE payouts
       SET status = 'rejected',
           review_notes = format('Auto-rejected: payment refunded (charge %s)', p_charge_id),
           reviewed_at = now(),
           updated_at = now()
     WHERE id = v_payout.id
       AND status IN ('pending', 'under_review', 'approved');

    v_cancelled := v_cancelled || jsonb_build_object(
      'id', v_payout.id,
      'previous_status', v_payout.status,
      'amount', v_payout.amount
    );
    v_cancelled_count := v_cancelled_count + 1;

    -- Per-payout audit (atomic with the cancel)
    INSERT INTO audit_logs (
      account_id, user_id, action,
      idempotency_key, details, reason
    ) VALUES (
      v_account_id,
      v_account_user_id,
      'status_changed',
      format('audit.refund_payout_cancel:%s:%s', p_charge_id, v_payout.id),
      jsonb_build_object(
        'type', 'refund_cancelled_payout',
        'payout_id', v_payout.id,
        'previous_payout_status', v_payout.status,
        'payout_amount', v_payout.amount,
        'charge_id', p_charge_id
      ),
      format('Payout auto-rejected due to payment refund on charge %s', p_charge_id)
    )
    ON CONFLICT (idempotency_key) DO NOTHING;
  END LOOP;

  -- ── Step 5: Count in-transit payouts (DO NOT cancel) ──────
  -- These funds may already have been released. Caller fires the
  -- human-action notification OUTSIDE this RPC.
  FOR v_payout IN
    SELECT id, amount
      FROM payouts
     WHERE account_id = v_account_id
       AND status = 'payment_initiated'
  LOOP
    v_in_transit := v_in_transit || jsonb_build_object(
      'id', v_payout.id,
      'amount', v_payout.amount
    );
    v_in_transit_count := v_in_transit_count + 1;
  END LOOP;

  -- ── Step 6: Invalidate account (if not already terminal) ──
  IF NOT v_already_terminal THEN
    UPDATE accounts
       SET status = 'failed_confirmed',
           failed_at = now(),
           updated_at = now()
     WHERE id = v_account_id;
  END IF;

  -- ── Step 7: Mark payment_transactions refunded ────────────
  UPDATE payment_transactions
     SET status = 'refunded', updated_at = now()
   WHERE id = v_txn_id;

  -- ── Step 8: Hash-chain audit log (trigger computes prev_hash/row_hash) ─
  INSERT INTO audit_logs (
    account_id, user_id, action,
    idempotency_key, details, reason
  ) VALUES (
    v_account_id,
    v_account_user_id,
    'failure_confirmed',
    format('audit.refund_invalidated:%s:%s', p_charge_id, v_account_id),
    jsonb_build_object(
      'type', 'refund_invalidated',
      'charge_id', p_charge_id,
      'payment_intent_id', p_payment_intent_id,
      'previous_status', v_account_status,
      'new_status', CASE WHEN v_already_terminal THEN v_account_status ELSE 'failed_confirmed' END,
      'already_terminal', v_already_terminal,
      'refund_amount', p_refund_amount_cents,
      'currency', p_currency,
      'cancelled_payouts_count', v_cancelled_count,
      'in_transit_payouts_count', v_in_transit_count
    ),
    format('Account invalidated due to Stripe refund on charge %s', p_charge_id)
  )
  ON CONFLICT (idempotency_key) DO NOTHING;

  -- ── Step 9: Trader-visible account event ──────────────────
  INSERT INTO account_events (
    account_id, event_type,
    idempotency_key, event_data
  ) VALUES (
    v_account_id,
    'failure_confirmed',
    format('acctevt.refund_invalidated:%s:%s', p_charge_id, v_account_id),
    jsonb_build_object(
      'trigger', 'payment_refund',
      'previous_status', v_account_status,
      'explanation', 'Your account has been invalidated because the payment was refunded.',
      'next_step', 'If you believe this is an error, please contact support.'
    )
  )
  ON CONFLICT (idempotency_key) DO NOTHING;

  -- ── Step 10: Mark fulfillment queue refunded ──────────────
  IF v_session_id IS NOT NULL THEN
    UPDATE checkout_fulfillment_queue
       SET status = 'refunded',
           processing_started_at = NULL,
           updated_at = now()
     WHERE stripe_session_id = v_session_id;
  END IF;

  -- ── Step 11: Return summary for the edge-function wrapper ──
  RETURN jsonb_build_object(
    'ok', true,
    'already_processed', false,
    'transaction_id', v_txn_id,
    'account_id', v_account_id,
    'account_number', v_account_number,
    'account_user_id', v_account_user_id,
    'previous_status', v_account_status,
    'already_terminal', v_already_terminal,
    'cancelled_payouts', v_cancelled,
    'cancelled_payouts_count', v_cancelled_count,
    'in_transit_payouts', v_in_transit,
    'in_transit_payouts_count', v_in_transit_count,
    'session_id', v_session_id
  );
END;
$$;

-- Lock the function down: only the service role (used by the Stripe webhook
-- edge function) can invoke it. Regular users — even authenticated — cannot.
REVOKE ALL ON FUNCTION public.handle_charge_refunded(text, text, integer, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.handle_charge_refunded(text, text, integer, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.handle_charge_refunded(text, text, integer, text) TO service_role;

COMMENT ON FUNCTION public.handle_charge_refunded(text, text, integer, text) IS
  'P0-2: atomic charge.refunded handler. Locks payment_transactions FOR UPDATE, auto-rejects cancellable payouts, counts in-transit payouts (caller notifies), invalidates account, marks txn refunded, writes audit + event + queue updates. Idempotent via payment_transactions.status + ON CONFLICT idempotency_key.';