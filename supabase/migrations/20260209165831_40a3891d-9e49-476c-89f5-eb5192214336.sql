
-- ============================================================
-- Blocker 2: Per-user aggregate payout velocity limit
-- Prevents fraud rings from bypassing per-account limits
-- by spreading requests across multiple accounts.
-- ============================================================

-- Add a new audit action for user-level velocity blocks
-- (existing enum may already cover this via 'payout_request_blocked',
--  but we want a distinct signal for analytics)

CREATE OR REPLACE FUNCTION public.validate_payout_request(
  _account_id uuid,
  _requested_amount numeric
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_account public.accounts%rowtype;
  v_profile public.profiles%rowtype;
  v_eligibility jsonb;
  v_max_eligible numeric;
  v_jurisdiction_check jsonb;
  v_pause_check jsonb;
  v_pending_flag_count integer;
  v_pending_fraud_count integer;
  v_recent_request_count integer;
  v_user_recent_request_count integer;
  v_user_paid_7d numeric;
BEGIN
  -- Check kill-switch first
  v_pause_check := public.check_payment_system_paused('outbound');
  IF (v_pause_check->>'paused')::boolean THEN
    RETURN jsonb_build_object(
      'valid', false, 
      'reason', 'system_paused',
      'pause_reason', v_pause_check->>'reason'
    );
  END IF;

  -- Get account and verify ownership
  SELECT * INTO v_account FROM public.accounts WHERE id = _account_id;
  
  IF NOT FOUND THEN
    RETURN jsonb_build_object('valid', false, 'reason', 'account_not_found');
  END IF;

  v_user_id := v_account.user_id;
  
  -- Ownership check
  IF v_user_id <> auth.uid() THEN
    RETURN jsonb_build_object('valid', false, 'reason', 'not_account_owner');
  END IF;

  -- Get profile for freeze/hold checks
  SELECT * INTO v_profile FROM public.profiles WHERE user_id = v_user_id;

  -- Check payouts_frozen (chargeback-based freeze)
  IF v_profile.payouts_frozen THEN
    RETURN jsonb_build_object('valid', false, 'reason', 'payouts_frozen', 'frozen_reason', v_profile.payouts_frozen_reason);
  END IF;

  -- Check payouts_hold (geo-mismatch hold)
  IF v_profile.payouts_hold THEN
    RETURN jsonb_build_object('valid', false, 'reason', 'payouts_on_hold', 'hold_reason', v_profile.payouts_hold_reason);
  END IF;

  -- D3: Check pending flags on this account
  SELECT COUNT(*) INTO v_pending_flag_count
  FROM public.flags
  WHERE account_id = _account_id AND status = 'pending';

  IF v_pending_flag_count > 0 THEN
    RETURN jsonb_build_object(
      'valid', false,
      'reason', 'pending_flags',
      'pending_flag_count', v_pending_flag_count,
      'hint', 'Your account has pending flags that must be resolved before requesting a payout'
    );
  END IF;

  -- D3: Check pending fraud reviews for this account
  SELECT COUNT(*) INTO v_pending_fraud_count
  FROM public.fraud_reviews
  WHERE entity_type = 'account' AND entity_id = _account_id::text AND status = 'pending';

  IF v_pending_fraud_count > 0 THEN
    RETURN jsonb_build_object(
      'valid', false,
      'reason', 'pending_fraud_review',
      'pending_fraud_count', v_pending_fraud_count,
      'hint', 'Your account has a pending fraud review that must be resolved before requesting a payout'
    );
  END IF;

  -- D4: Velocity limiting — max 3 payout requests per account in rolling 24h
  SELECT COUNT(*) INTO v_recent_request_count
  FROM public.payouts
  WHERE account_id = _account_id
    AND requested_at > now() - interval '24 hours';

  IF v_recent_request_count >= 3 THEN
    RETURN jsonb_build_object(
      'valid', false,
      'reason', 'velocity_limit_exceeded',
      'recent_requests', v_recent_request_count,
      'hint', 'Maximum 3 payout requests per account per 24 hours. Please try again later.'
    );
  END IF;

  -- D5: Per-USER aggregate velocity — max 5 payout requests across ALL accounts in rolling 24h
  SELECT COUNT(*) INTO v_user_recent_request_count
  FROM public.payouts p
  JOIN public.accounts a ON a.id = p.account_id
  WHERE a.user_id = v_user_id
    AND p.requested_at > now() - interval '24 hours';

  IF v_user_recent_request_count >= 5 THEN
    RETURN jsonb_build_object(
      'valid', false,
      'reason', 'user_velocity_limit_exceeded',
      'recent_requests', v_user_recent_request_count,
      'hint', 'Maximum 5 payout requests per user per 24 hours across all accounts. Please try again later.'
    );
  END IF;

  -- D6: Per-USER rolling 7-day paid amount cap — max $5,000 confirmed payouts per user per 7 days
  SELECT COALESCE(SUM(p.amount), 0) INTO v_user_paid_7d
  FROM public.payouts p
  JOIN public.accounts a ON a.id = p.account_id
  WHERE a.user_id = v_user_id
    AND p.status IN ('paid', 'paid_confirmed')
    AND p.paid_at > now() - interval '7 days';

  IF v_user_paid_7d + _requested_amount > 5000 THEN
    RETURN jsonb_build_object(
      'valid', false,
      'reason', 'user_weekly_payout_cap_exceeded',
      'paid_last_7d', v_user_paid_7d,
      'requested', _requested_amount,
      'weekly_cap', 5000,
      'headroom', GREATEST(5000 - v_user_paid_7d, 0),
      'hint', format('Maximum $5,000 in confirmed payouts per user per rolling 7 days. You have $%s remaining.', 
                      GREATEST(5000 - v_user_paid_7d, 0)::text)
    );
  END IF;

  -- Jurisdiction check
  v_jurisdiction_check := public.assert_jurisdiction_allowed('payout_request');
  IF NOT (v_jurisdiction_check->>'allowed')::boolean THEN
    RETURN jsonb_build_object('valid', false, 'reason', v_jurisdiction_check->>'reason', 'country', v_jurisdiction_check->>'country');
  END IF;

  -- Calculate eligibility
  v_eligibility := public.calculate_payout_eligibility(_account_id);
  
  IF NOT (v_eligibility->>'eligible')::boolean THEN
    RETURN jsonb_build_object('valid', false, 'reason', v_eligibility->>'reason', 'eligibility', v_eligibility);
  END IF;

  v_max_eligible := (v_eligibility->>'max_eligible_amount')::numeric;

  IF _requested_amount > v_max_eligible THEN
    RETURN jsonb_build_object(
      'valid', false, 
      'reason', 'amount_exceeds_eligible',
      'requested', _requested_amount,
      'max_eligible', v_max_eligible,
      'eligibility', v_eligibility
    );
  END IF;

  IF _requested_amount <= 0 THEN
    RETURN jsonb_build_object('valid', false, 'reason', 'invalid_amount');
  END IF;

  RETURN jsonb_build_object(
    'valid', true,
    'requested_amount', _requested_amount,
    'max_eligible', v_max_eligible,
    'eligibility', v_eligibility,
    'jurisdiction', v_jurisdiction_check
  );
END;
$$;

-- Maintain existing privilege model: EXECUTE revoked from PUBLIC, granted to authenticated
REVOKE ALL ON FUNCTION public.validate_payout_request(uuid, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.validate_payout_request(uuid, numeric) TO authenticated;

-- Add index to support the per-user velocity query efficiently
CREATE INDEX IF NOT EXISTS idx_payouts_account_requested_at 
  ON public.payouts (account_id, requested_at DESC);

-- Composite index for the 7-day paid amount query
CREATE INDEX IF NOT EXISTS idx_payouts_status_paid_at
  ON public.payouts (status, paid_at DESC)
  WHERE status IN ('paid', 'paid_confirmed');
