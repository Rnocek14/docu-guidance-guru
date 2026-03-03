
-- 1. Rename column clean_disqualify_reason → clean_payout_reason
ALTER TABLE public.payouts RENAME COLUMN clean_disqualify_reason TO clean_payout_reason;

-- 2. Add partial index for clean payout count queries (lineage-based)
CREATE INDEX IF NOT EXISTS idx_payouts_clean_count
  ON public.payouts (account_id)
  WHERE is_clean_payout = true AND status IN ('paid', 'paid_confirmed');

-- 3. Modify confirm_payout_payment to set is_clean_payout atomically
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
    -- CRITICAL: Validate payout_id matches
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

  -- Check 2: Breaker L2 (Freeze) active at confirmation time
  IF _is_clean THEN
    SELECT breaker_level INTO _breaker_level
    FROM econ_breaker_state
    WHERE id = '00000000-0000-0000-0000-000000000001'
    LIMIT 1;

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

  -- Update payout status WITH clean classification
  UPDATE payouts SET
    status = 'paid_confirmed',
    paid_at = _confirmed_at,
    paid_by = COALESCE(
      (SELECT initiated_by FROM payout_payments WHERE payout_id = _payout_id AND status = 'confirmed' AND initiated_by != '00000000-0000-0000-0000-000000000000'::uuid LIMIT 1),
      '00000000-0000-0000-0000-000000000000'::uuid
    ),
    payment_reference = _provider || ':' || _provider_payment_id,
    is_clean_payout = _is_clean,
    clean_payout_reason = _clean_reason,
    updated_at = now()
  WHERE id = _payout_id;

  -- Update ledgers
  PERFORM 1 FROM accounts WHERE id = _payout.account_id FOR UPDATE;
  
  UPDATE user_cohort_payouts SET
    lifetime_paid_total = lifetime_paid_total + _payout.amount,
    updated_at = now()
  WHERE user_id = (SELECT user_id FROM accounts WHERE id = _payout.account_id)
    AND cohort_id = (SELECT cohort_id FROM accounts WHERE id = _payout.account_id);

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
    'status', 'paid_confirmed',
    'is_clean_payout', _is_clean,
    'clean_payout_reason', _clean_reason
  );
END;
$$;

-- 4. Backfill historical paid payouts
-- Conservative: mark all historical paid payouts as clean since we can't 
-- reconstruct flag/breaker state at original paid time.
-- Clean tracking is strictly accurate from this migration forward.
UPDATE payouts
SET is_clean_payout = true,
    clean_payout_reason = null
WHERE status IN ('paid', 'paid_confirmed')
  AND is_clean_payout IS NULL;
