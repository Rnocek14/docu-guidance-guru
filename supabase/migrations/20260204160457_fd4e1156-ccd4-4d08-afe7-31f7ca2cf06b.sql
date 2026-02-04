-- 1. Add CHECK constraint: paid_at required when status='paid'
ALTER TABLE payouts
  ADD CONSTRAINT payouts_paid_requires_paid_at
  CHECK (status != 'paid' OR paid_at IS NOT NULL);

-- 2. Backfill legacy accounts with null cycle columns
UPDATE accounts
SET
  payout_cycle_start_balance = COALESCE(payout_cycle_start_balance, starting_balance),
  payout_cycle_started_at = COALESCE(payout_cycle_started_at, created_at)
WHERE payout_cycle_start_balance IS NULL
   OR payout_cycle_started_at IS NULL;

-- 3. Add recommended indexes for payouts
CREATE INDEX IF NOT EXISTS idx_payouts_account_status
ON payouts (account_id, status);

CREATE INDEX IF NOT EXISTS idx_payouts_account_paid_at
ON payouts (account_id, paid_at DESC) WHERE status = 'paid';

-- 4. Atomic mark_paid RPC (validates + updates payout + resets cycle in one transaction)
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
BEGIN
  -- Get payout with lock
  SELECT * INTO _payout
  FROM payouts
  WHERE id = _payout_id
  FOR UPDATE;
  
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Payout not found');
  END IF;
  
  IF _payout.status != 'approved' THEN
    RETURN jsonb_build_object(
      'success', false, 
      'error', 'Payout must be approved before marking paid',
      'current_status', _payout.status
    );
  END IF;
  
  _account_id := _payout.account_id;
  
  -- Update payout to paid (atomically)
  UPDATE payouts
  SET
    status = 'paid',
    paid_at = now(),
    payment_reference = _payment_reference,
    reviewed_by = COALESCE(_reviewed_by, reviewed_by),
    reviewed_at = now()
  WHERE id = _payout_id;
  
  -- Reset payout cycle (atomically in same transaction)
  SELECT current_balance INTO _current_balance
  FROM accounts
  WHERE id = _account_id;
  
  UPDATE accounts
  SET
    payout_cycle_start_balance = _current_balance,
    payout_cycle_started_at = now(),
    highest_balance = _current_balance
  WHERE id = _account_id;
  
  RETURN jsonb_build_object(
    'success', true,
    'payout_id', _payout_id,
    'account_id', _account_id,
    'new_cycle_baseline', _current_balance,
    'paid_at', now()
  );
END;
$$;