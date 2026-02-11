CREATE OR REPLACE FUNCTION public.seed_submit_payout_request(
  _seed_secret text,
  _account_id uuid,
  _user_id uuid,
  _requested_amount numeric
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _stored_secret text;
  _account record;
  _eligibility jsonb;
  _payout_id uuid;
BEGIN
  -- 0. Validate seed secret
  SELECT value INTO _stored_secret
    FROM internal_secrets
   WHERE key = 'seed_secret';

  IF _stored_secret IS NULL OR _seed_secret != _stored_secret THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_seed_secret');
  END IF;

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
  IF _account.user_id != _user_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'User does not own this account');
  END IF;

  -- 3. Validate via existing eligibility RPC (returns jsonb)
  SELECT calculate_payout_eligibility(_account_id) INTO _eligibility;

  IF NOT ((_eligibility->>'eligible')::boolean) THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', COALESCE(_eligibility->>'reason', 'Not eligible'),
      'reason_code', _eligibility->>'reason_code'
    );
  END IF;

  -- 4. Amount validation
  IF _requested_amount < 50 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Minimum payout amount is $50');
  END IF;

  IF _requested_amount > (_eligibility->>'max_eligible_amount')::numeric THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', format('Maximum eligible amount is $%s', (_eligibility->>'max_eligible_amount')::numeric(12,2))
    );
  END IF;

  -- 5. Insert payout row
  INSERT INTO payouts (
    account_id, amount, status, submitted_amount, calculated_eligible_amount
  ) VALUES (
    _account_id, _requested_amount, 'pending', _requested_amount, (_eligibility->>'max_eligible_amount')::numeric
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

-- Maintain privilege model
REVOKE ALL ON FUNCTION public.seed_submit_payout_request(text, uuid, uuid, numeric) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.seed_submit_payout_request(text, uuid, uuid, numeric) FROM anon;
GRANT EXECUTE ON FUNCTION public.seed_submit_payout_request(text, uuid, uuid, numeric) TO service_role;