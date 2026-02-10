
-- Server-side atomic payout request RPC
-- Replaces client-side insert + status update with a single transactional path
CREATE OR REPLACE FUNCTION public.submit_payout_request(
  _account_id uuid,
  _requested_amount numeric
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _account record;
  _eligibility record;
  _payout_id uuid;
  _result jsonb;
BEGIN
  -- 1. Lock the account row
  SELECT id, user_id, status
    INTO _account
    FROM accounts
   WHERE id = _account_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Account not found');
  END IF;

  -- 2. Verify ownership
  IF _account.user_id != auth.uid() THEN
    RETURN jsonb_build_object('success', false, 'error', 'Unauthorized');
  END IF;

  -- 3. Validate via existing RPC (inline call)
  SELECT * INTO _eligibility
    FROM calculate_payout_eligibility(_account_id);

  IF NOT (_eligibility.eligible) THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', COALESCE(_eligibility.reason, 'Not eligible'),
      'reason_code', _eligibility.reason_code
    );
  END IF;

  -- 4. Amount validation
  IF _requested_amount < 50 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Minimum payout amount is $50');
  END IF;

  IF _requested_amount > _eligibility.max_eligible_amount THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', format('Maximum eligible amount is $%s', _eligibility.max_eligible_amount::numeric(12,2))
    );
  END IF;

  -- 5. Insert payout row
  INSERT INTO payouts (
    account_id, amount, status, submitted_amount, calculated_eligible_amount
  ) VALUES (
    _account_id, _requested_amount, 'pending', _requested_amount, _eligibility.max_eligible_amount
  )
  RETURNING id INTO _payout_id;

  -- 6. Transition account status atomically
  UPDATE accounts
     SET status = 'payout_requested',
         updated_at = now()
   WHERE id = _account_id
     AND status IN ('active', 'passed');

  RETURN jsonb_build_object(
    'success', true,
    'payout_id', _payout_id
  );
END;
$$;

-- Restrict access: only authenticated users can call this
REVOKE EXECUTE ON FUNCTION public.submit_payout_request(uuid, numeric) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.submit_payout_request(uuid, numeric) FROM anon;
GRANT EXECUTE ON FUNCTION public.submit_payout_request(uuid, numeric) TO authenticated;
