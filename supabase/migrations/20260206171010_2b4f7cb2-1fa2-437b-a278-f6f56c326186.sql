
-- 1) Update confirm_payout_payment: validate payout_id match on dedup + system actor for out-of-order
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
  -- System webhook actor: no human initiated this
  _system_actor uuid := '00000000-0000-0000-0000-000000000000';
BEGIN
  -- Idempotency: check if this webhook event was already processed
  SELECT * INTO _existing_event FROM payout_payments
  WHERE provider = _provider AND provider_event_id = _provider_event_id;

  IF FOUND THEN
    -- Validate payout_id matches (detect replay/correlation bugs)
    IF _existing_event.payout_id != _payout_id THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'event_id_conflict',
        'message', 'provider_event_id already processed for a different payout',
        'existing_payout_id', _existing_event.payout_id,
        'requested_payout_id', _payout_id
      );
    END IF;
    IF _existing_event.status = 'confirmed' THEN
      RETURN jsonb_build_object('success', true, 'idempotent', true, 'payout_id', _payout_id);
    END IF;
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

  -- Update existing initiated payment or insert (out-of-order)
  SELECT * INTO _payment FROM payout_payments
  WHERE payout_id = _payout_id AND provider = _provider AND status = 'initiated' FOR UPDATE;

  IF FOUND THEN
    UPDATE payout_payments SET
      status = 'confirmed', provider_payment_id = _provider_payment_id,
      provider_event_id = _provider_event_id, confirmed_at = _confirmed_at,
      raw_webhook = _raw_webhook, updated_at = now()
    WHERE id = _payment.id;
  ELSE
    -- Out-of-order: use system actor, not a human
    INSERT INTO payout_payments (
      payout_id, provider, provider_payment_id, provider_event_id,
      status, amount, currency, initiated_by, initiated_at, confirmed_at, raw_webhook
    ) VALUES (
      _payout_id, _provider, _provider_payment_id, _provider_event_id,
      'confirmed', _payout.amount, 'USD', _system_actor, now(), _confirmed_at, _raw_webhook
    );
  END IF;

  UPDATE payouts SET
    status = 'paid_confirmed', paid_at = _confirmed_at,
    paid_by = COALESCE(_payout.paid_by, _system_actor),
    payment_reference = _provider_payment_id, updated_at = now()
  WHERE id = _payout_id;

  -- Update ledgers
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

-- 2) Update fail_payout_payment: same payout_id validation + system actor
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
  _system_actor uuid := '00000000-0000-0000-0000-000000000000';
BEGIN
  SELECT * INTO _existing_event FROM payout_payments
  WHERE provider = _provider AND provider_event_id = _provider_event_id;

  IF FOUND THEN
    IF _existing_event.payout_id != _payout_id THEN
      RETURN jsonb_build_object(
        'success', false, 'error', 'event_id_conflict',
        'message', 'provider_event_id already processed for a different payout',
        'existing_payout_id', _existing_event.payout_id,
        'requested_payout_id', _payout_id
      );
    END IF;
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
    -- Out-of-order: system actor
    INSERT INTO payout_payments (
      payout_id, provider, provider_payment_id, provider_event_id,
      status, amount, currency, initiated_by,
      failure_code, failure_reason, failed_at, raw_webhook
    ) VALUES (
      _payout_id, _provider, _provider_payment_id, _provider_event_id,
      'failed', _payout.amount, 'USD', _system_actor,
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
