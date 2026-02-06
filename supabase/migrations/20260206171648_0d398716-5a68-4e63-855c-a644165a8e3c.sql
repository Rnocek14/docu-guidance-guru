
-- ============================================================
-- Add event_id_conflict audit logging to confirm/fail RPCs
-- ============================================================

-- Replace confirm_payout_payment to emit audit on event_id_conflict
CREATE OR REPLACE FUNCTION public.confirm_payout_payment(
  _payout_id uuid,
  _provider text,
  _provider_payment_id text,
  _provider_event_id text,
  _raw_webhook jsonb DEFAULT '{}'::jsonb,
  _confirmed_at timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _payout payouts%ROWTYPE;
  _existing_payment payout_payments%ROWTYPE;
  _payment_id uuid;
  _prev_hash text;
  _audit_id uuid;
  _idem_key text;
  _row_hash text;
BEGIN
  -- Check for existing event_id (idempotency)
  SELECT * INTO _existing_payment
  FROM payout_payments
  WHERE provider = _provider AND provider_event_id = _provider_event_id;

  IF FOUND THEN
    -- CRITICAL: Validate payout_id matches
    IF _existing_payment.payout_id != _payout_id THEN
      -- Emit audit log for event_id_conflict (possible replay attack or parser bug)
      _idem_key := 'audit.event_id_conflict:' || _provider || ':' || _provider_event_id || ':' || _payout_id::text;
      
      SELECT COALESCE(
        (SELECT row_hash FROM audit_logs ORDER BY created_at DESC, id DESC LIMIT 1),
        'GENESIS'
      ) INTO _prev_hash;
      
      _audit_id := gen_random_uuid();
      _row_hash := encode(
        sha256(convert_to(
          _audit_id::text || _idem_key || _prev_hash || 'event_id_conflict',
          'UTF8'
        )),
        'hex'
      );
      
      INSERT INTO audit_logs (id, action, idempotency_key, prev_hash, row_hash, details, reason)
      VALUES (
        _audit_id,
        'status_changed',
        _idem_key,
        _prev_hash,
        _row_hash,
        jsonb_build_object(
          'event', 'event_id_conflict',
          'severity', 'critical',
          'provider', _provider,
          'provider_event_id', _provider_event_id,
          'claimed_payout_id', _payout_id,
          'actual_payout_id', _existing_payment.payout_id,
          'existing_status', _existing_payment.status
        ),
        'Webhook event_id reused for different payout - possible replay attack or parser bug'
      )
      ON CONFLICT (idempotency_key) DO NOTHING;
      
      RETURN jsonb_build_object(
        'success', false,
        'error', 'event_id_conflict',
        'message', 'This provider event ID is already associated with a different payout',
        'existing_payout_id', _existing_payment.payout_id
      );
    END IF;
    
    -- Same payout, idempotent success
    RETURN jsonb_build_object(
      'success', true,
      'duplicate', true,
      'payment_id', _existing_payment.id,
      'status', _existing_payment.status
    );
  END IF;

  -- Lock payout row
  SELECT * INTO _payout FROM payouts WHERE id = _payout_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'payout_not_found');
  END IF;

  -- Already confirmed? Idempotent success
  IF _payout.status = 'paid_confirmed' THEN
    RETURN jsonb_build_object(
      'success', true,
      'duplicate', true,
      'status', _payout.status
    );
  END IF;

  -- Must be payment_initiated or approved (out-of-order)
  IF _payout.status NOT IN ('payment_initiated', 'approved') THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'invalid_status',
      'current_status', _payout.status
    );
  END IF;

  -- Check if there's an existing initiated payment to update
  SELECT * INTO _existing_payment
  FROM payout_payments
  WHERE payout_id = _payout_id AND status = 'initiated'
  FOR UPDATE;

  IF FOUND THEN
    -- Update existing payment record
    UPDATE payout_payments SET
      status = 'confirmed',
      provider_payment_id = _provider_payment_id,
      provider_event_id = _provider_event_id,
      confirmed_at = _confirmed_at,
      raw_webhook = _raw_webhook,
      updated_at = now()
    WHERE id = _existing_payment.id;
    _payment_id := _existing_payment.id;
  ELSE
    -- Out-of-order: insert confirmed payment (system actor)
    INSERT INTO payout_payments (
      payout_id, provider, provider_payment_id, provider_event_id,
      status, amount, currency, initiated_by,
      initiated_at, confirmed_at, raw_webhook
    ) VALUES (
      _payout_id, _provider, _provider_payment_id, _provider_event_id,
      'confirmed', _payout.amount, 'USD',
      '00000000-0000-0000-0000-000000000000'::uuid,
      _confirmed_at, _confirmed_at, _raw_webhook
    )
    RETURNING id INTO _payment_id;
  END IF;

  -- Update payout status
  UPDATE payouts SET
    status = 'paid_confirmed',
    paid_at = _confirmed_at,
    paid_by = COALESCE(
      (SELECT initiated_by FROM payout_payments WHERE payout_id = _payout_id AND status = 'confirmed' AND initiated_by != '00000000-0000-0000-0000-000000000000'::uuid LIMIT 1),
      '00000000-0000-0000-0000-000000000000'::uuid
    ),
    payment_reference = _provider || ':' || _provider_payment_id,
    updated_at = now()
  WHERE id = _payout_id;

  -- Update ledgers
  -- Lock account
  PERFORM 1 FROM accounts WHERE id = _payout.account_id FOR UPDATE;
  
  -- Lock user_cohort_payouts
  UPDATE user_cohort_payouts SET
    lifetime_paid_total = lifetime_paid_total + _payout.amount,
    updated_at = now()
  WHERE user_id = (SELECT user_id FROM accounts WHERE id = _payout.account_id)
    AND cohort_id = (SELECT cohort_id FROM accounts WHERE id = _payout.account_id);

  -- Update profile mirror
  UPDATE profiles SET
    lifetime_paid_total = lifetime_paid_total + _payout.amount,
    updated_at = now()
  WHERE user_id = (SELECT user_id FROM accounts WHERE id = _payout.account_id);

  -- Reset payout cycle
  PERFORM reset_payout_cycle(_payout.account_id);

  RETURN jsonb_build_object(
    'success', true,
    'payment_id', _payment_id,
    'amount', _payout.amount,
    'status', 'paid_confirmed'
  );
END;
$$;

-- Replace fail_payout_payment with event_id_conflict audit logging
CREATE OR REPLACE FUNCTION public.fail_payout_payment(
  _payout_id uuid,
  _provider text,
  _provider_payment_id text,
  _provider_event_id text,
  _failure_code text DEFAULT NULL,
  _failure_reason text DEFAULT NULL,
  _raw_webhook jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _payout payouts%ROWTYPE;
  _existing_payment payout_payments%ROWTYPE;
  _payment_id uuid;
  _prev_hash text;
  _audit_id uuid;
  _idem_key text;
  _row_hash text;
BEGIN
  -- Check for existing event_id (idempotency)
  SELECT * INTO _existing_payment
  FROM payout_payments
  WHERE provider = _provider AND provider_event_id = _provider_event_id;

  IF FOUND THEN
    -- CRITICAL: Validate payout_id matches
    IF _existing_payment.payout_id != _payout_id THEN
      -- Emit audit log for event_id_conflict
      _idem_key := 'audit.event_id_conflict:' || _provider || ':' || _provider_event_id || ':' || _payout_id::text;
      
      SELECT COALESCE(
        (SELECT row_hash FROM audit_logs ORDER BY created_at DESC, id DESC LIMIT 1),
        'GENESIS'
      ) INTO _prev_hash;
      
      _audit_id := gen_random_uuid();
      _row_hash := encode(
        sha256(convert_to(
          _audit_id::text || _idem_key || _prev_hash || 'event_id_conflict',
          'UTF8'
        )),
        'hex'
      );
      
      INSERT INTO audit_logs (id, action, idempotency_key, prev_hash, row_hash, details, reason)
      VALUES (
        _audit_id,
        'status_changed',
        _idem_key,
        _prev_hash,
        _row_hash,
        jsonb_build_object(
          'event', 'event_id_conflict',
          'severity', 'critical',
          'provider', _provider,
          'provider_event_id', _provider_event_id,
          'claimed_payout_id', _payout_id,
          'actual_payout_id', _existing_payment.payout_id,
          'existing_status', _existing_payment.status
        ),
        'Webhook event_id reused for different payout (fail path) - possible replay attack or parser bug'
      )
      ON CONFLICT (idempotency_key) DO NOTHING;
      
      RETURN jsonb_build_object(
        'success', false,
        'error', 'event_id_conflict',
        'message', 'This provider event ID is already associated with a different payout',
        'existing_payout_id', _existing_payment.payout_id
      );
    END IF;
    
    -- Same payout, idempotent
    RETURN jsonb_build_object(
      'success', true,
      'duplicate', true,
      'payment_id', _existing_payment.id,
      'status', _existing_payment.status
    );
  END IF;

  -- Lock payout
  SELECT * INTO _payout FROM payouts WHERE id = _payout_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'payout_not_found');
  END IF;

  -- Already failed or confirmed? Idempotent
  IF _payout.status IN ('payment_failed', 'paid_confirmed') THEN
    RETURN jsonb_build_object(
      'success', true,
      'duplicate', true,
      'status', _payout.status
    );
  END IF;

  IF _payout.status NOT IN ('payment_initiated', 'approved') THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'invalid_status',
      'current_status', _payout.status
    );
  END IF;

  -- Update or insert payment record
  SELECT * INTO _existing_payment
  FROM payout_payments
  WHERE payout_id = _payout_id AND status = 'initiated'
  FOR UPDATE;

  IF FOUND THEN
    UPDATE payout_payments SET
      status = 'failed',
      provider_payment_id = _provider_payment_id,
      provider_event_id = _provider_event_id,
      failure_code = _failure_code,
      failure_reason = _failure_reason,
      failed_at = now(),
      raw_webhook = _raw_webhook,
      updated_at = now()
    WHERE id = _existing_payment.id;
    _payment_id := _existing_payment.id;
  ELSE
    INSERT INTO payout_payments (
      payout_id, provider, provider_payment_id, provider_event_id,
      status, amount, currency, initiated_by,
      initiated_at, failed_at, failure_code, failure_reason, raw_webhook
    ) VALUES (
      _payout_id, _provider, _provider_payment_id, _provider_event_id,
      'failed', _payout.amount, 'USD',
      '00000000-0000-0000-0000-000000000000'::uuid,
      now(), now(), _failure_code, _failure_reason, _raw_webhook
    )
    RETURNING id INTO _payment_id;
  END IF;

  -- Revert payout to approved for retry
  UPDATE payouts SET
    status = 'approved',
    updated_at = now()
  WHERE id = _payout_id;

  RETURN jsonb_build_object(
    'success', true,
    'payment_id', _payment_id,
    'failure_code', _failure_code,
    'failure_reason', _failure_reason,
    'status', 'payment_failed',
    'payout_reverted_to', 'approved'
  );
END;
$$;

-- Ensure permissions are correct
REVOKE ALL ON FUNCTION public.confirm_payout_payment FROM PUBLIC;
REVOKE ALL ON FUNCTION public.confirm_payout_payment FROM authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_payout_payment TO service_role;

REVOKE ALL ON FUNCTION public.fail_payout_payment FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fail_payout_payment FROM authenticated;
GRANT EXECUTE ON FUNCTION public.fail_payout_payment TO service_role;
