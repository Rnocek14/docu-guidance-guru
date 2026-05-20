-- A-1 fix: add payouts_frozen gate to initiate_payout_payment
-- Previously the freeze was checked at approve and at mark_paid, but not at the
-- approve -> initiate -> confirm path. A chargeback firing after approval and
-- before initiation would still let Wise/Stripe transfer fire.

CREATE OR REPLACE FUNCTION public.initiate_payout_payment(
  _payout_id uuid,
  _provider text,
  _amount numeric,
  _initiated_by uuid DEFAULT NULL,
  _currency text DEFAULT 'USD'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _payout record;
  _payment_id uuid;
  _frozen boolean;
BEGIN
  SELECT * INTO _payout FROM payouts WHERE id = _payout_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'payout_not_found');
  END IF;

  IF _payout.status != 'approved' THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_status',
      'current_status', _payout.status);
  END IF;

  -- Freeze gate: lock the profile row alongside the payout so a concurrent
  -- chargeback handler cannot flip payouts_frozen between this check and the
  -- payment_initiated write.
  SELECT payouts_frozen INTO _frozen
  FROM profiles
  WHERE user_id = _payout.user_id
  FOR UPDATE;

  IF COALESCE(_frozen, false) THEN
    INSERT INTO audit_logs (action, account_id, reason, details, idempotency_key)
    VALUES (
      'status_changed',
      _payout.account_id,
      'initiate_blocked_payouts_frozen',
      jsonb_build_object(
        'payout_id', _payout_id,
        'user_id', _payout.user_id,
        'event', 'initiate_payout_payment_blocked_frozen'
      ),
      'initiate_blocked_frozen:' || _payout_id::text
    )
    ON CONFLICT (idempotency_key) DO NOTHING;

    RETURN jsonb_build_object('success', false, 'error', 'payouts_frozen',
      'message', 'Payouts are frozen for this user; cannot initiate payment.');
  END IF;

  -- Separation of duties: initiator != approver
  IF _initiated_by IS NOT NULL AND _payout.approved_by IS NOT NULL
     AND _initiated_by = _payout.approved_by THEN
    RETURN jsonb_build_object('success', false, 'error', 'separation_of_duties',
      'message', 'Payment initiator cannot be the same person who approved the payout');
  END IF;

  IF _amount != _payout.amount THEN
    RETURN jsonb_build_object('success', false, 'error', 'amount_mismatch',
      'approved_amount', _payout.amount, 'requested_amount', _amount);
  END IF;

  PERFORM 1 FROM payout_payments WHERE payout_id = _payout_id AND status = 'initiated';
  IF FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'active_attempt_exists');
  END IF;

  INSERT INTO payout_payments (payout_id, provider, amount, currency, initiated_by, status)
  VALUES (_payout_id, _provider, _amount, _currency, COALESCE(_initiated_by, auth.uid()), 'initiated')
  RETURNING id INTO _payment_id;

  UPDATE payouts SET
    status = 'payment_initiated',
    paid_by = COALESCE(_initiated_by, auth.uid()),
    updated_at = now()
  WHERE id = _payout_id;

  RETURN jsonb_build_object('success', true, 'payment_id', _payment_id,
    'payout_id', _payout_id, 'provider', _provider,
    'amount', _amount, 'currency', _currency, 'status', 'initiated');
END;
$$;

REVOKE EXECUTE ON FUNCTION public.initiate_payout_payment FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.initiate_payout_payment TO service_role;
GRANT EXECUTE ON FUNCTION public.initiate_payout_payment TO authenticated;