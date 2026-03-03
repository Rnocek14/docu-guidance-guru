
-- Drop old signature (different arg order)
DROP FUNCTION IF EXISTS public.confirm_payout_payment(uuid, text, text, text, jsonb, timestamptz);

-- Recreate with hardened COALESCE + FOR SHARE on breaker
CREATE OR REPLACE FUNCTION public.confirm_payout_payment(
  _payout_id uuid,
  _provider text,
  _provider_payment_id text,
  _provider_event_id text,
  _confirmed_at timestamptz,
  _raw_webhook jsonb DEFAULT NULL
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
  _is_clean boolean;
  _clean_reason text;
  _active_flag_count integer;
  _breaker_level text;
BEGIN
  -- Check for existing event_id (idempotency)
  SELECT * INTO _existing_payment
  FROM payout_payments
  WHERE provider = _provider AND provider_event_id = _provider_event_id;

  IF FOUND THEN
    IF _existing_payment.payout_id != _payout_id THEN
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
        _audit_id, 'status_changed', _idem_key, _prev_hash, _row_hash,
        jsonb_build_object(
          'event', 'event_id_conflict', 'severity', 'critical',
          'provider', _provider, 'provider_event_id', _provider_event_id,
          'claimed_payout_id', _payout_id, 'actual_payout_id', _existing_payment.payout_id,
          'existing_status', _existing_payment.status
        ),
        'Webhook event_id reused for different payout - possible replay attack or parser bug'
      )
      ON CONFLICT (idempotency_key) DO NOTHING;
      
      RETURN jsonb_build_object(
        'success', false, 'error', 'event_id_conflict',
        'message', 'This provider event ID is already associated with a different payout',
        'existing_payout_id', _existing_payment.payout_id
      );
    END IF;
    
    RETURN jsonb_build_object(
      'success', true, 'duplicate', true,
      'payment_id', _existing_payment.id, 'status', _existing_payment.status
    );
  END IF;

  -- Lock payout row
  SELECT * INTO _payout FROM payouts WHERE id = _payout_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'payout_not_found');
  END IF;

  IF _payout.status = 'paid_confirmed' THEN
    RETURN jsonb_build_object('success', true, 'duplicate', true, 'status', _payout.status);
  END IF;

  IF _payout.status NOT IN ('payment_initiated', 'approved') THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_status', 'current_status', _payout.status);
  END IF;

  -- =============================================
  -- CLEAN PAYOUT EVALUATION (at paid time)
  -- =============================================
  _is_clean := true;
  _clean_reason := null;

  -- Check 1: Active flags on account at confirmation time
  SELECT count(*) INTO _active_flag_count
  FROM flags
  WHERE account_id = _payout.account_id
    AND status IN ('pending', 'escalated');

  IF _active_flag_count > 0 THEN
    _is_clean := false;
    _clean_reason := 'ACTIVE_FLAG';
  END IF;

  -- Check 2: Breaker L2 (Freeze) — HARDENED with COALESCE + FOR SHARE
  IF _is_clean THEN
    SELECT COALESCE(breaker_level, 'normal') INTO _breaker_level
    FROM econ_breaker_state
    WHERE id = '00000000-0000-0000-0000-000000000001'
    FOR SHARE;

    IF _breaker_level = 'freeze' THEN
      _is_clean := false;
      _clean_reason := 'BREAKER_L2';
    END IF;
  END IF;

  -- Check existing initiated payment to update
  SELECT * INTO _existing_payment
  FROM payout_payments
  WHERE payout_id = _payout_id AND status = 'initiated'
  FOR UPDATE;

  IF FOUND THEN
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
    INSERT INTO payout_payments (
      payout_id, provider, provider_payment_id, provider_event_id,
      status, amount, currency, initiated_by, initiated_at, confirmed_at, raw_webhook
    ) VALUES (
      _payout_id, _provider, _provider_payment_id, _provider_event_id,
      'confirmed', _payout.amount, 'USD', _payout.approved_by, now(), _confirmed_at, _raw_webhook
    ) RETURNING id INTO _payment_id;
  END IF;

  -- Update payout to paid_confirmed with clean evaluation
  UPDATE payouts SET
    status = 'paid_confirmed',
    paid_at = _confirmed_at,
    is_clean_payout = _is_clean,
    clean_payout_reason = _clean_reason,
    clean_evaluated_at = now(),
    updated_at = now()
  WHERE id = _payout_id;

  -- Audit trail
  _idem_key := 'audit.payout_confirmed:' || _payout_id::text || ':' || _provider_event_id;
  
  SELECT COALESCE(
    (SELECT row_hash FROM audit_logs ORDER BY created_at DESC, id DESC LIMIT 1),
    'GENESIS'
  ) INTO _prev_hash;
  
  _audit_id := gen_random_uuid();
  _row_hash := encode(
    sha256(convert_to(
      _audit_id::text || _idem_key || _prev_hash || 'payout_confirmed',
      'UTF8'
    )),
    'hex'
  );
  
  INSERT INTO audit_logs (id, action, account_id, idempotency_key, prev_hash, row_hash, details, reason)
  VALUES (
    _audit_id, 'status_changed', _payout.account_id, _idem_key, _prev_hash, _row_hash,
    jsonb_build_object(
      'event', 'payout_confirmed', 'payout_id', _payout_id,
      'payment_id', _payment_id, 'provider', _provider,
      'provider_payment_id', _provider_payment_id,
      'provider_event_id', _provider_event_id,
      'amount', _payout.amount,
      'is_clean_payout', _is_clean, 'clean_payout_reason', _clean_reason,
      'active_flag_count', _active_flag_count, 'breaker_level', _breaker_level
    ),
    'Payment confirmed via provider webhook'
  )
  ON CONFLICT (idempotency_key) DO NOTHING;

  RETURN jsonb_build_object(
    'success', true, 'payment_id', _payment_id,
    'status', 'paid_confirmed',
    'is_clean_payout', _is_clean, 'clean_payout_reason', _clean_reason
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.confirm_payout_payment(uuid, text, text, text, timestamptz, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.confirm_payout_payment(uuid, text, text, text, timestamptz, jsonb) TO service_role;
