-- Fix mark_payout_paid: idempotency, account status update, full return payload
CREATE OR REPLACE FUNCTION public.mark_payout_paid(
  _payout_id uuid,
  _payment_reference text,
  _reviewed_by uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _payout record;
  _account_id uuid;
  _current_balance numeric;
  _payout_amount numeric;
  _paid_at timestamptz;
BEGIN
  -- Get payout with lock
  SELECT * INTO _payout
  FROM payouts
  WHERE id = _payout_id
  FOR UPDATE;
  
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Payout not found');
  END IF;
  
  -- IDEMPOTENCY: If already paid, return success with existing data
  IF _payout.status = 'paid' THEN
    RETURN jsonb_build_object(
      'success', true,
      'idempotent', true,
      'payout', jsonb_build_object(
        'id', _payout.id,
        'account_id', _payout.account_id,
        'amount', _payout.amount,
        'status', _payout.status,
        'paid_at', _payout.paid_at,
        'payment_reference', _payout.payment_reference
      )
    );
  END IF;
  
  -- Validate: must be approved to mark paid
  IF _payout.status != 'approved' THEN
    RETURN jsonb_build_object(
      'success', false, 
      'error', 'Payout must be approved before marking paid',
      'current_status', _payout.status
    );
  END IF;
  
  _account_id := _payout.account_id;
  _payout_amount := _payout.amount;
  _paid_at := now();
  
  -- Update payout to paid (atomically)
  UPDATE payouts
  SET
    status = 'paid',
    paid_at = _paid_at,
    payment_reference = _payment_reference,
    reviewed_by = COALESCE(_reviewed_by, reviewed_by),
    reviewed_at = _paid_at
  WHERE id = _payout_id;
  
  -- Reset payout cycle (atomically in same transaction)
  SELECT current_balance INTO _current_balance
  FROM accounts
  WHERE id = _account_id;
  
  UPDATE accounts
  SET
    payout_cycle_start_balance = _current_balance,
    payout_cycle_started_at = _paid_at,
    highest_balance = _current_balance,
    status = 'passed'  -- Return to passed state after payout
  WHERE id = _account_id;
  
  RETURN jsonb_build_object(
    'success', true,
    'idempotent', false,
    'payout', jsonb_build_object(
      'id', _payout_id,
      'account_id', _account_id,
      'amount', _payout_amount,
      'status', 'paid',
      'paid_at', _paid_at,
      'payment_reference', _payment_reference
    ),
    'cycle_reset', jsonb_build_object(
      'new_baseline', _current_balance,
      'reset_at', _paid_at
    )
  );
END;
$$;