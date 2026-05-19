
-- ============================================================
-- Phase A blocker fixes (#2, #5)
-- ============================================================

-- ── #2: Void affiliate attributions when a purchase is refunded ──
CREATE OR REPLACE FUNCTION public.void_affiliate_attribution_by_source(
  p_source text,
  p_source_id uuid,
  p_reason text DEFAULT 'refund'
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_row public.affiliate_attributions;
BEGIN
  IF p_source NOT IN ('checkout','reset') THEN
    RAISE EXCEPTION 'BAD_SOURCE';
  END IF;

  UPDATE public.affiliate_attributions
     SET status = 'reversed',
         notes  = COALESCE(notes,'') ||
                  CASE WHEN notes IS NULL OR notes = '' THEN '' ELSE E'\n' END ||
                  format('Reversed by %s at %s', p_reason, now())
   WHERE source = p_source
     AND source_id = p_source_id
     AND status IN ('pending','approved')
   RETURNING * INTO v_row;

  IF v_row.id IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'voided', false);
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'voided', true,
    'attribution_id', v_row.id,
    'affiliate_id', v_row.affiliate_id,
    'commission_cents', v_row.commission_cents
  );
END;
$$;

REVOKE ALL ON FUNCTION public.void_affiliate_attribution_by_source(text, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.void_affiliate_attribution_by_source(text, uuid, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.void_affiliate_attribution_by_source(text, uuid, text) TO service_role;

-- Extend handle_charge_refunded to void affiliate attributions linked to the
-- refunded checkout (via fulfillment queue row id) AND any reset purchases
-- linked to the same payment intent.
CREATE OR REPLACE FUNCTION public.handle_charge_refunded(
  p_charge_id text,
  p_payment_intent_id text,
  p_refund_amount_cents integer,
  p_currency text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
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
  v_queue_id uuid;
  v_already_terminal boolean;
  v_cancelled jsonb := '[]'::jsonb;
  v_in_transit jsonb := '[]'::jsonb;
  v_cancelled_count integer := 0;
  v_in_transit_count integer := 0;
  v_payout record;
  v_attrib_voided jsonb := '[]'::jsonb;
  v_void_result jsonb;
BEGIN
  SELECT id, user_id, status, metadata
    INTO v_txn_id, v_txn_user_id, v_txn_status, v_txn_metadata
  FROM payment_transactions
  WHERE provider = 'stripe'
    AND provider_payment_id = p_payment_intent_id
    AND purpose = 'evaluation_purchase'
  ORDER BY created_at ASC LIMIT 1 FOR UPDATE;

  IF v_txn_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_transaction', 'payment_intent_id', p_payment_intent_id);
  END IF;

  IF v_txn_status = 'refunded' THEN
    RETURN jsonb_build_object('ok', true, 'already_processed', true, 'transaction_id', v_txn_id);
  END IF;

  v_account_id := (v_txn_metadata ->> 'account_id')::uuid;
  v_session_id := v_txn_metadata ->> 'stripe_session_id';

  IF v_account_id IS NULL THEN
    UPDATE payment_transactions SET status = 'refunded', updated_at = now() WHERE id = v_txn_id;
    RETURN jsonb_build_object('ok', true, 'reason', 'no_account_id_in_metadata', 'transaction_id', v_txn_id);
  END IF;

  SELECT user_id INTO v_account_user_id FROM accounts WHERE id = v_account_id;
  IF v_account_user_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'account_not_found', 'transaction_id', v_txn_id);
  END IF;

  FOR v_payout IN
    SELECT id, status, amount FROM payouts
     WHERE account_id = v_account_id
       AND status IN ('pending', 'under_review', 'approved', 'payment_initiated')
     ORDER BY id FOR UPDATE
  LOOP
    IF v_payout.status = 'payment_initiated' THEN
      v_in_transit := v_in_transit || jsonb_build_object('id', v_payout.id, 'amount', v_payout.amount);
      v_in_transit_count := v_in_transit_count + 1;
    ELSE
      UPDATE payouts
         SET status = 'rejected',
             review_notes = format('Auto-rejected: payment refunded (charge %s)', p_charge_id),
             reviewed_at = now(), updated_at = now()
       WHERE id = v_payout.id AND status IN ('pending', 'under_review', 'approved');

      v_cancelled := v_cancelled || jsonb_build_object('id', v_payout.id, 'previous_status', v_payout.status, 'amount', v_payout.amount);
      v_cancelled_count := v_cancelled_count + 1;

      INSERT INTO audit_logs (account_id, user_id, action, idempotency_key, details, reason)
      VALUES (v_account_id, v_account_user_id, 'status_changed',
              format('audit.refund_payout_cancel:%s:%s', p_charge_id, v_payout.id),
              jsonb_build_object('type','refund_cancelled_payout','payout_id',v_payout.id,
                                 'previous_payout_status',v_payout.status,'payout_amount',v_payout.amount,
                                 'charge_id',p_charge_id),
              format('Payout auto-rejected due to payment refund on charge %s', p_charge_id))
      ON CONFLICT (idempotency_key) DO NOTHING;
    END IF;
  END LOOP;

  SELECT status, account_number INTO v_account_status, v_account_number
  FROM accounts WHERE id = v_account_id FOR UPDATE;

  v_already_terminal := v_account_status IN ('failed_confirmed', 'closed');

  IF NOT v_already_terminal THEN
    UPDATE accounts SET status='failed_confirmed', failed_at=now(), updated_at=now() WHERE id=v_account_id;
  END IF;

  UPDATE payment_transactions SET status='refunded', updated_at=now() WHERE id=v_txn_id;

  -- Void affiliate attribution tied to this checkout (queue row id is source_id).
  IF v_session_id IS NOT NULL THEN
    SELECT id INTO v_queue_id FROM checkout_fulfillment_queue
      WHERE stripe_session_id = v_session_id LIMIT 1;

    IF v_queue_id IS NOT NULL THEN
      v_void_result := public.void_affiliate_attribution_by_source('checkout', v_queue_id, 'refund');
      IF (v_void_result->>'voided')::boolean THEN
        v_attrib_voided := v_attrib_voided || v_void_result;
      END IF;
    END IF;
  END IF;

  -- Void any reset attributions on this same payment intent (best-effort).
  FOR v_queue_id IN
    SELECT id FROM reset_purchases WHERE payment_intent = p_payment_intent_id
  LOOP
    v_void_result := public.void_affiliate_attribution_by_source('reset', v_queue_id, 'refund');
    IF (v_void_result->>'voided')::boolean THEN
      v_attrib_voided := v_attrib_voided || v_void_result;
    END IF;
  END LOOP;

  INSERT INTO audit_logs (account_id, user_id, action, idempotency_key, details, reason)
  VALUES (v_account_id, v_account_user_id, 'failure_confirmed',
          format('audit.refund_invalidated:%s:%s', p_charge_id, v_account_id),
          jsonb_build_object('type','refund_invalidated','charge_id',p_charge_id,
                             'payment_intent_id',p_payment_intent_id,'previous_status',v_account_status,
                             'new_status', CASE WHEN v_already_terminal THEN v_account_status ELSE 'failed_confirmed' END,
                             'already_terminal',v_already_terminal,'refund_amount',p_refund_amount_cents,
                             'currency',p_currency,'cancelled_payouts_count',v_cancelled_count,
                             'in_transit_payouts_count',v_in_transit_count,
                             'affiliate_attributions_voided', v_attrib_voided),
          format('Account invalidated due to Stripe refund on charge %s', p_charge_id))
  ON CONFLICT (idempotency_key) DO NOTHING;

  INSERT INTO account_events (account_id, event_type, idempotency_key, event_data)
  VALUES (v_account_id, 'failure_confirmed',
          format('acctevt.refund_invalidated:%s:%s', p_charge_id, v_account_id),
          jsonb_build_object('trigger','payment_refund','previous_status',v_account_status,
                             'explanation','Your account has been invalidated because the payment was refunded.',
                             'next_step','If you believe this is an error, please contact support.'))
  ON CONFLICT (idempotency_key) DO NOTHING;

  IF v_session_id IS NOT NULL THEN
    UPDATE checkout_fulfillment_queue
       SET status='refunded', processing_started_at=NULL, updated_at=now()
     WHERE stripe_session_id = v_session_id;
  END IF;

  RETURN jsonb_build_object(
    'ok', true, 'already_processed', false, 'transaction_id', v_txn_id,
    'account_id', v_account_id, 'account_number', v_account_number,
    'account_user_id', v_account_user_id, 'previous_status', v_account_status,
    'already_terminal', v_already_terminal, 'cancelled_payouts', v_cancelled,
    'cancelled_payouts_count', v_cancelled_count, 'in_transit_payouts', v_in_transit,
    'in_transit_payouts_count', v_in_transit_count, 'session_id', v_session_id,
    'affiliate_attributions_voided', v_attrib_voided
  );
END;
$$;

REVOKE ALL ON FUNCTION public.handle_charge_refunded(text, text, integer, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.handle_charge_refunded(text, text, integer, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.handle_charge_refunded(text, text, integer, text) TO service_role;

-- ── #5: Validate / sanitize payout_shares.display_name ──
CREATE OR REPLACE FUNCTION public.tg_validate_payout_share_display_name()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_name text;
  v_lower text;
  v_blocked text[] := ARRAY[
    'admin','administrator','meridian','support','staff','official','moderator',
    'fuck','shit','bitch','cunt','nigger','faggot','retard','rape'
  ];
  v_term text;
BEGIN
  IF NEW.display_name IS NULL THEN RETURN NEW; END IF;

  v_name := btrim(NEW.display_name);

  -- Collapse whitespace
  v_name := regexp_replace(v_name, '\s+', ' ', 'g');

  IF v_name = '' THEN
    NEW.display_name := NULL;
    RETURN NEW;
  END IF;

  IF length(v_name) > 40 THEN
    RAISE EXCEPTION 'DISPLAY_NAME_TOO_LONG' USING HINT = 'Max 40 characters';
  END IF;

  -- Allow letters, numbers, spaces, ._-
  IF v_name !~ '^[A-Za-z0-9 ._\-]+$' THEN
    RAISE EXCEPTION 'DISPLAY_NAME_INVALID_CHARS' USING HINT = 'Letters, numbers, spaces, . _ - only';
  END IF;

  v_lower := lower(v_name);
  FOREACH v_term IN ARRAY v_blocked LOOP
    IF position(v_term IN v_lower) > 0 THEN
      RAISE EXCEPTION 'DISPLAY_NAME_BLOCKED' USING HINT = 'Display name contains blocked term';
    END IF;
  END LOOP;

  NEW.display_name := v_name;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS payout_shares_validate_display_name ON public.payout_shares;
CREATE TRIGGER payout_shares_validate_display_name
BEFORE INSERT OR UPDATE OF display_name ON public.payout_shares
FOR EACH ROW EXECUTE FUNCTION public.tg_validate_payout_share_display_name();

-- Round paid_at to the hour and validate display_name on read in public RPCs.
CREATE OR REPLACE FUNCTION public.get_public_payout_share(_short_id TEXT)
RETURNS TABLE (short_id TEXT, display_name TEXT, amount NUMERIC, tier_name TEXT, paid_at TIMESTAMPTZ)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT ps.short_id,
         COALESCE(NULLIF(ps.display_name,''),'Anonymous Trader'),
         p.amount,
         c.name,
         date_trunc('hour', p.paid_at)
  FROM public.payout_shares ps
  JOIN public.payouts p ON p.id=ps.payout_id
  JOIN public.accounts a ON a.id=p.account_id
  JOIN public.cohorts c ON c.id=a.cohort_id
  WHERE ps.short_id=_short_id AND ps.is_public=true AND p.status IN ('paid','paid_confirmed')
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.get_recent_public_payouts(_limit INT DEFAULT 20)
RETURNS TABLE (short_id TEXT, display_name TEXT, amount NUMERIC, tier_name TEXT, paid_at TIMESTAMPTZ)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT ps.short_id,
         COALESCE(NULLIF(ps.display_name,''),'Anonymous Trader'),
         p.amount,
         c.name,
         date_trunc('hour', p.paid_at)
  FROM public.payout_shares ps
  JOIN public.payouts p ON p.id=ps.payout_id
  JOIN public.accounts a ON a.id=p.account_id
  JOIN public.cohorts c ON c.id=a.cohort_id
  WHERE ps.is_public=true AND p.status IN ('paid','paid_confirmed')
  ORDER BY p.paid_at DESC NULLS LAST
  LIMIT LEAST(GREATEST(_limit,1),100);
$$;
