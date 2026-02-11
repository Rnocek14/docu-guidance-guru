
-- ============================================================
-- seed_submit_payout_request: Canonical payout request logic
-- with explicit user_id instead of auth.uid(), gated by
-- internal_secrets seed key match.
-- ============================================================
-- SECURITY: Only callable by service_role (EXECUTE revoked from public/anon/authenticated).
-- Additional gate: requires _seed_secret to match internal_secrets.value WHERE key='seed_secret'.
-- ============================================================

CREATE OR REPLACE FUNCTION public.seed_submit_payout_request(
  _account_id uuid,
  _requested_amount numeric,
  _user_id uuid,
  _seed_secret text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _stored_secret text;
  _account record;
  _eligibility record;
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

  -- 2. Verify ownership (using explicit _user_id, not auth.uid())
  IF _account.user_id != _user_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'User does not own this account');
  END IF;

  -- 3. Validate via existing eligibility RPC
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
$function$;

-- Restrict access: only service_role can call this
REVOKE EXECUTE ON FUNCTION public.seed_submit_payout_request(uuid, numeric, uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.seed_submit_payout_request(uuid, numeric, uuid, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.seed_submit_payout_request(uuid, numeric, uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.seed_submit_payout_request(uuid, numeric, uuid, text) TO service_role;

-- Insert a seed secret (idempotent) for gating
INSERT INTO internal_secrets (key, value)
VALUES ('seed_secret', encode(gen_random_bytes(32), 'hex'))
ON CONFLICT (key) DO NOTHING;
