
-- C5 FIX: Atomic payout approval that updates BOTH payout and account in one transaction
-- Prevents state desync where payout is approved but account status fails to update

CREATE OR REPLACE FUNCTION public.approve_payout_atomic(
  _payout_id UUID,
  _approved_by UUID,
  _review_notes TEXT DEFAULT NULL,
  _calculated_eligible_amount NUMERIC DEFAULT NULL,
  _submitted_amount NUMERIC DEFAULT NULL,
  _fraud_review_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_payout RECORD;
  v_account_id UUID;
  v_previous_payout_status TEXT;
BEGIN
  -- 1. Lock payout row FOR UPDATE (prevents concurrent approval)
  SELECT id, status, account_id, amount
  INTO v_payout
  FROM payouts
  WHERE id = _payout_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'payout_not_found');
  END IF;

  v_previous_payout_status := v_payout.status;
  v_account_id := v_payout.account_id;

  -- 2. Validate state transition (only pending/under_review → approved)
  IF v_payout.status NOT IN ('pending', 'under_review') THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'invalid_state_transition',
      'current_status', v_payout.status,
      'allowed_from', ARRAY['pending', 'under_review']
    );
  END IF;

  -- 3. Lock account row FOR UPDATE (strict lock ordering: payouts → accounts)
  PERFORM id FROM accounts WHERE id = v_account_id FOR UPDATE;

  -- 4. Atomically update BOTH payout and account
  UPDATE payouts
  SET status = 'approved',
      approved_by = _approved_by,
      reviewed_by = _approved_by,
      reviewed_at = now(),
      review_notes = COALESCE(_review_notes, review_notes),
      calculated_eligible_amount = COALESCE(_calculated_eligible_amount, calculated_eligible_amount),
      submitted_amount = COALESCE(_submitted_amount, submitted_amount),
      fraud_review_id = COALESCE(_fraud_review_id, fraud_review_id),
      updated_at = now()
  WHERE id = _payout_id;

  UPDATE accounts
  SET status = 'payout_approved',
      updated_at = now()
  WHERE id = v_account_id;

  RETURN jsonb_build_object(
    'success', true,
    'payout_id', _payout_id,
    'account_id', v_account_id,
    'previous_payout_status', v_previous_payout_status,
    'new_payout_status', 'approved',
    'new_account_status', 'payout_approved'
  );
END;
$$;

-- Restrict access: only service_role can call this
REVOKE EXECUTE ON FUNCTION public.approve_payout_atomic FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.approve_payout_atomic FROM anon;
REVOKE EXECUTE ON FUNCTION public.approve_payout_atomic FROM authenticated;
GRANT EXECUTE ON FUNCTION public.approve_payout_atomic TO service_role;

-- Also create atomic reject + request_more_info for consistency
CREATE OR REPLACE FUNCTION public.reject_payout_atomic(
  _payout_id UUID,
  _rejected_by UUID,
  _reason TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_payout RECORD;
BEGIN
  SELECT id, status, account_id
  INTO v_payout
  FROM payouts
  WHERE id = _payout_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'payout_not_found');
  END IF;

  IF v_payout.status NOT IN ('pending', 'under_review') THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'invalid_state_transition',
      'current_status', v_payout.status
    );
  END IF;

  -- Lock account
  PERFORM id FROM accounts WHERE id = v_payout.account_id FOR UPDATE;

  UPDATE payouts
  SET status = 'rejected',
      reviewed_by = _rejected_by,
      reviewed_at = now(),
      review_notes = _reason,
      updated_at = now()
  WHERE id = _payout_id;

  -- Return account to active on rejection
  UPDATE accounts
  SET status = 'active',
      updated_at = now()
  WHERE id = v_payout.account_id
    AND status = 'payout_requested';

  RETURN jsonb_build_object(
    'success', true,
    'payout_id', _payout_id,
    'account_id', v_payout.account_id,
    'new_payout_status', 'rejected'
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.reject_payout_atomic FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.reject_payout_atomic FROM anon;
REVOKE EXECUTE ON FUNCTION public.reject_payout_atomic FROM authenticated;
GRANT EXECUTE ON FUNCTION public.reject_payout_atomic TO service_role;
