
-- Drop the existing function with its exact signature
DROP FUNCTION IF EXISTS public.initiate_payout_payment(uuid, text, numeric, text, uuid);

-- 1) Partial unique index
CREATE UNIQUE INDEX IF NOT EXISTS payout_payments_one_active_attempt
ON public.payout_payments (payout_id)
WHERE status IN ('initiated');

-- 2) CHECK: terminal states require provider_event_id
ALTER TABLE public.payout_payments
ADD CONSTRAINT payout_payments_event_required_for_terminal
CHECK (status NOT IN ('confirmed', 'failed') OR provider_event_id IS NOT NULL);

-- 3) CHECK: terminal states require provider_payment_id
ALTER TABLE public.payout_payments
ADD CONSTRAINT payout_payments_payment_id_required_for_terminal
CHECK (status NOT IN ('confirmed', 'failed') OR provider_payment_id IS NOT NULL);

-- 4) RLS deny policies
CREATE POLICY "No client inserts on payout_payments"
ON public.payout_payments FOR INSERT WITH CHECK (false);

CREATE POLICY "No client updates on payout_payments"
ON public.payout_payments FOR UPDATE USING (false);

CREATE POLICY "No client deletes on payout_payments"
ON public.payout_payments FOR DELETE USING (false);

-- 5) Recreate initiate_payout_payment with separation-of-duties
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
BEGIN
  SELECT * INTO _payout FROM payouts WHERE id = _payout_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'payout_not_found');
  END IF;

  IF _payout.status != 'approved' THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_status',
      'current_status', _payout.status);
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

-- 6) Update confirm_payout_payment for out-of-order webhook safety
CREATE OR REPLACE FUNCTION public.confirm_payout_payment(
  _payout_id uuid,
  _provider text,
  _provider_payment_id text,
  _provider_event_id text,
  _raw_webhook jsonb DEFAULT NULL,
  _confirmed_at timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _payout record; _account record; _cohort record;
  _ucp record; _profile record; _payment record; _existing_event record;
BEGIN
  SELECT * INTO _existing_event FROM payout_payments
  WHERE provider = _provider AND provider_event_id = _provider_event_id;
  IF FOUND AND _existing_event.status = 'confirmed' THEN
    RETURN jsonb_build_object('success', true, 'idempotent', true, 'payout_id', _payout_id);
  END IF;

  SELECT * INTO _payout FROM payouts WHERE id = _payout_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'payout_not_found'); END IF;

  IF _payout.status = 'paid_confirmed' THEN
    RETURN jsonb_build_object('success', true, 'idempotent', true, 'payout_id', _payout_id);
  END IF;

  IF _payout.status NOT IN ('payment_initiated', 'approved') THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_status', 'current_status', _payout.status);
  END IF;

  -- LOCK ORDER: payouts -> accounts -> user_cohort_payouts -> profiles
  SELECT * INTO _account FROM accounts WHERE id = _payout.account_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'account_not_found'); END IF;

  SELECT * INTO _cohort FROM cohorts WHERE id = _account.cohort_id;
  SELECT * INTO _ucp FROM user_cohort_payouts
  WHERE user_id = _account.user_id AND cohort_id = _account.cohort_id FOR UPDATE;
  SELECT * INTO _profile FROM profiles WHERE user_id = _account.user_id FOR UPDATE;

  SELECT * INTO _payment FROM payout_payments
  WHERE payout_id = _payout_id AND provider = _provider AND status = 'initiated' FOR UPDATE;

  IF FOUND THEN
    UPDATE payout_payments SET
      status = 'confirmed', provider_payment_id = _provider_payment_id,
      provider_event_id = _provider_event_id, confirmed_at = _confirmed_at,
      raw_webhook = _raw_webhook, updated_at = now()
    WHERE id = _payment.id;
  ELSE
    INSERT INTO payout_payments (
      payout_id, provider, provider_payment_id, provider_event_id,
      status, amount, currency, initiated_by, initiated_at, confirmed_at, raw_webhook
    ) VALUES (
      _payout_id, _provider, _provider_payment_id, _provider_event_id,
      'confirmed', _payout.amount, 'USD',
      COALESCE(_payout.paid_by, _payout.approved_by), now(), _confirmed_at, _raw_webhook
    );
  END IF;

  UPDATE payouts SET
    status = 'paid_confirmed', paid_at = _confirmed_at,
    paid_by = COALESCE(_payout.paid_by, _payout.approved_by),
    payment_reference = _provider_payment_id, updated_at = now()
  WHERE id = _payout_id;

  IF _ucp IS NOT NULL THEN
    UPDATE user_cohort_payouts SET lifetime_paid_total = lifetime_paid_total + _payout.amount, updated_at = now()
    WHERE id = _ucp.id;
  ELSE
    INSERT INTO user_cohort_payouts (user_id, cohort_id, lifetime_paid_total)
    VALUES (_account.user_id, _account.cohort_id, _payout.amount);
  END IF;

  IF _profile IS NOT NULL THEN
    UPDATE profiles SET lifetime_paid_total = lifetime_paid_total + _payout.amount, updated_at = now()
    WHERE user_id = _account.user_id;
  END IF;

  UPDATE accounts SET
    payout_cycle_start_balance = current_balance, payout_cycle_started_at = now(),
    status = 'passed', updated_at = now()
  WHERE id = _account.id;

  RETURN jsonb_build_object('success', true, 'idempotent', false, 'payout_id', _payout_id,
    'amount', _payout.amount, 'confirmed_at', _confirmed_at,
    'provider', _provider, 'provider_payment_id', _provider_payment_id);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.confirm_payout_payment FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.confirm_payout_payment FROM authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_payout_payment TO service_role;

-- 7) Update fail_payout_payment with provider IDs and out-of-order safety
CREATE OR REPLACE FUNCTION public.fail_payout_payment(
  _payout_id uuid,
  _provider text,
  _provider_payment_id text,
  _provider_event_id text,
  _failure_code text DEFAULT NULL,
  _failure_reason text DEFAULT NULL,
  _raw_webhook jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _payout record; _payment record; _existing_event record;
BEGIN
  SELECT * INTO _existing_event FROM payout_payments
  WHERE provider = _provider AND provider_event_id = _provider_event_id;
  IF FOUND THEN
    RETURN jsonb_build_object('success', true, 'idempotent', true, 'payout_id', _payout_id);
  END IF;

  SELECT * INTO _payout FROM payouts WHERE id = _payout_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'payout_not_found'); END IF;

  IF _payout.status = 'paid_confirmed' THEN
    RETURN jsonb_build_object('success', false, 'error', 'already_confirmed');
  END IF;

  IF _payout.status NOT IN ('payment_initiated', 'approved') THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_status', 'current_status', _payout.status);
  END IF;

  SELECT * INTO _payment FROM payout_payments
  WHERE payout_id = _payout_id AND provider = _provider AND status = 'initiated' FOR UPDATE;

  IF FOUND THEN
    UPDATE payout_payments SET
      status = 'failed', provider_payment_id = _provider_payment_id,
      provider_event_id = _provider_event_id,
      failure_code = _failure_code, failure_reason = _failure_reason,
      failed_at = now(), raw_webhook = _raw_webhook, updated_at = now()
    WHERE id = _payment.id;
  ELSE
    INSERT INTO payout_payments (
      payout_id, provider, provider_payment_id, provider_event_id,
      status, amount, currency, initiated_by,
      failure_code, failure_reason, failed_at, raw_webhook
    ) VALUES (
      _payout_id, _provider, _provider_payment_id, _provider_event_id,
      'failed', _payout.amount, 'USD', COALESCE(_payout.paid_by, _payout.approved_by),
      _failure_code, _failure_reason, now(), _raw_webhook
    );
  END IF;

  UPDATE payouts SET status = 'approved', updated_at = now() WHERE id = _payout_id;

  RETURN jsonb_build_object('success', true, 'idempotent', false, 'payout_id', _payout_id,
    'reverted_to', 'approved', 'failure_code', _failure_code, 'failure_reason', _failure_reason);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fail_payout_payment FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fail_payout_payment FROM authenticated;
GRANT EXECUTE ON FUNCTION public.fail_payout_payment TO service_role;
