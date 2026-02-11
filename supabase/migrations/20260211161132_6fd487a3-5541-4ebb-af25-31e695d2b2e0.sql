
-- Step 1: Drop any overloaded seed RPCs
DROP FUNCTION IF EXISTS public.seed_submit_payout_request(uuid, numeric, uuid, text);
DROP FUNCTION IF EXISTS public.seed_submit_payout_request(text, uuid, uuid, numeric);

-- Step 2: Recreate ONE canonical seed RPC
CREATE FUNCTION public.seed_submit_payout_request(
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
  _expected_secret text;
  _account_owner uuid;
  _eligibility jsonb;
  _payout_id uuid;
BEGIN
  SELECT value INTO _expected_secret
  FROM internal_secrets
  WHERE key = 'seed_secret';

  IF _expected_secret IS NULL OR _seed_secret IS NULL OR _seed_secret <> _expected_secret THEN
    RETURN jsonb_build_object('success', false, 'error', 'Invalid seed secret');
  END IF;

  SELECT user_id INTO _account_owner
  FROM accounts
  WHERE id = _account_id;

  IF _account_owner IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Account not found');
  END IF;

  IF _account_owner <> _user_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'Ownership mismatch');
  END IF;

  _eligibility := public.calculate_payout_eligibility(_account_id);

  IF coalesce((_eligibility->>'eligible')::boolean, false) IS NOT TRUE THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', coalesce(_eligibility->>'reason', 'Not eligible'),
      'reason_code', _eligibility->>'reason_code'
    );
  END IF;

  IF _requested_amount < 50 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Minimum payout amount is $50');
  END IF;

  IF _requested_amount > (_eligibility->>'max_eligible_amount')::numeric THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', format(
        'Maximum eligible amount is $%s',
        (_eligibility->>'max_eligible_amount')::numeric(12,2)
      )
    );
  END IF;

  INSERT INTO payouts (account_id, amount, status, submitted_amount, calculated_eligible_amount)
  VALUES (_account_id, _requested_amount, 'pending', _requested_amount, (_eligibility->>'max_eligible_amount')::numeric)
  RETURNING id INTO _payout_id;

  UPDATE accounts
     SET status = 'payout_requested',
         updated_at = now()
   WHERE id = _account_id
     AND status IN ('active', 'passed');

  RETURN jsonb_build_object('success', true, 'payout_id', _payout_id);
END;
$$;

REVOKE ALL ON FUNCTION public.seed_submit_payout_request(text, uuid, uuid, numeric) FROM public;
REVOKE ALL ON FUNCTION public.seed_submit_payout_request(text, uuid, uuid, numeric) FROM anon;
REVOKE ALL ON FUNCTION public.seed_submit_payout_request(text, uuid, uuid, numeric) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.seed_submit_payout_request(text, uuid, uuid, numeric) TO service_role;
