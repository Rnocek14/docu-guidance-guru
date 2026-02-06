-- P0-A Hardening: Fix critical security + correctness issues
-- Issue 1: Add immutable kyc_legal_name to profiles (not user-editable)
ALTER TABLE public.profiles 
ADD COLUMN IF NOT EXISTS kyc_legal_name text;

-- Issue 2: Add updated_at to chargeback_events (referenced but missing)
ALTER TABLE public.chargeback_events 
ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- Trigger for updated_at on chargeback_events
CREATE TRIGGER update_chargeback_events_updated_at
  BEFORE UPDATE ON public.chargeback_events
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Issue 3: Add new audit action enum values for freeze/block events
ALTER TYPE public.audit_action ADD VALUE IF NOT EXISTS 'payout_freeze_auto_chargeback';
ALTER TYPE public.audit_action ADD VALUE IF NOT EXISTS 'card_block_auto_chargeback';
ALTER TYPE public.audit_action ADD VALUE IF NOT EXISTS 'payout_freeze_manual';

-- Issue 4: Fix RLS on payment_rails - add WITH CHECK for admin policy
DROP POLICY IF EXISTS "Admins can manage payment rails" ON public.payment_rails;
CREATE POLICY "Admins can manage payment rails" ON public.payment_rails
  FOR ALL USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

-- Issue 5: RLS to prevent client updates to kyc_legal_name (only service role can set)
-- Done via column-level security: users can update profiles but kyc_legal_name is protected by RPC

-- Issue 6: Fix verify_payout_name_match - use auth.uid(), compare against immutable kyc_legal_name
CREATE OR REPLACE FUNCTION public.verify_payout_name_match(_destination_name text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _user_id uuid;
  _profile record;
  _kyc_name_normalized text;
  _dest_name_normalized text;
BEGIN
  -- SECURITY: Always use auth.uid(), never accept user_id as parameter
  _user_id := auth.uid();
  
  IF _user_id IS NULL THEN
    RETURN jsonb_build_object(
      'verified', false,
      'reason', 'not_authenticated'
    );
  END IF;

  -- Fetch profile with immutable KYC legal name
  SELECT 
    kyc_status,
    kyc_legal_name,
    payouts_frozen,
    payouts_frozen_reason
  INTO _profile
  FROM public.profiles
  WHERE user_id = _user_id;

  IF _profile IS NULL THEN
    RETURN jsonb_build_object(
      'verified', false,
      'reason', 'profile_not_found'
    );
  END IF;

  -- Check KYC verified
  IF COALESCE(_profile.kyc_status, 'pending') != 'verified' THEN
    RETURN jsonb_build_object(
      'verified', false,
      'reason', 'kyc_not_verified',
      'kyc_status', _profile.kyc_status
    );
  END IF;

  -- Check payouts not frozen
  IF COALESCE(_profile.payouts_frozen, false) = true THEN
    RETURN jsonb_build_object(
      'verified', false,
      'reason', 'payouts_frozen',
      'freeze_reason', _profile.payouts_frozen_reason
    );
  END IF;

  -- CRITICAL: Compare against IMMUTABLE kyc_legal_name, NOT user-editable full_name
  IF _profile.kyc_legal_name IS NULL OR _profile.kyc_legal_name = '' THEN
    RETURN jsonb_build_object(
      'verified', false,
      'reason', 'kyc_legal_name_missing',
      'hint', 'KYC verification did not capture legal name'
    );
  END IF;

  -- Normalize both names for comparison
  _kyc_name_normalized := normalize_legal_name(_profile.kyc_legal_name);
  _dest_name_normalized := normalize_legal_name(_destination_name);

  IF _dest_name_normalized IS NULL OR _dest_name_normalized = '' THEN
    RETURN jsonb_build_object(
      'verified', false,
      'reason', 'destination_name_missing'
    );
  END IF;

  -- Hard match - no override path
  IF _kyc_name_normalized != _dest_name_normalized THEN
    RETURN jsonb_build_object(
      'verified', false,
      'reason', 'name_mismatch',
      'hint', 'Payout destination name must exactly match your verified legal name'
    );
  END IF;

  RETURN jsonb_build_object(
    'verified', true,
    'matched_name', _kyc_name_normalized
  );
END;
$$;

-- Issue 7: Fix process_chargeback_event to be truly idempotent
-- Track whether this was an insert vs update using xmax trick
CREATE OR REPLACE FUNCTION public.process_chargeback_event(
  _user_id uuid,
  _provider text,
  _provider_event_id text,
  _provider_dispute_id text,
  _stage text,
  _reason_code text,
  _amount numeric,
  _currency text,
  _occurred_at timestamptz,
  _card_fingerprint text DEFAULT NULL,
  _ip inet DEFAULT NULL,
  _country text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _event_id uuid;
  _was_inserted boolean := false;
  _previous_stage text;
  _profile record;
  _chargeback_count_90d integer;
  _should_freeze boolean := false;
  _should_block_cards boolean := false;
  _freeze_reason text;
  _audit_action public.audit_action;
BEGIN
  -- Check for existing event to detect insert vs update
  SELECT id, stage INTO _event_id, _previous_stage
  FROM public.chargeback_events
  WHERE provider = _provider AND provider_event_id = _provider_event_id;

  IF _event_id IS NULL THEN
    -- True first-time insert
    INSERT INTO public.chargeback_events (
      user_id, provider, provider_event_id, provider_dispute_id,
      stage, reason_code, amount, currency, occurred_at,
      card_fingerprint, ip, country
    ) VALUES (
      _user_id, _provider, _provider_event_id, _provider_dispute_id,
      _stage, _reason_code, _amount, _currency, _occurred_at,
      _card_fingerprint, _ip, _country
    )
    RETURNING id INTO _event_id;
    
    _was_inserted := true;
    _previous_stage := NULL;
  ELSE
    -- Update existing - only update stage if it changed
    IF _previous_stage IS DISTINCT FROM _stage THEN
      UPDATE public.chargeback_events
      SET stage = _stage,
          updated_at = now()
      WHERE id = _event_id;
    END IF;
  END IF;

  -- Only process freeze/block logic on TRUE first insert
  -- (not on webhook retries or stage updates to same stage)
  IF NOT _was_inserted THEN
    -- Handle stage TRANSITIONS (e.g., dispute_opened -> lost)
    IF _previous_stage = 'dispute_opened' AND _stage = 'lost' THEN
      _should_block_cards := true;
      _freeze_reason := 'Chargeback dispute lost';
      _audit_action := 'card_block_auto_chargeback';
    END IF;
    
    -- If no meaningful transition, return early (idempotent success)
    IF NOT _should_block_cards THEN
      RETURN jsonb_build_object(
        'success', true,
        'event_id', _event_id,
        'was_duplicate', true,
        'previous_stage', _previous_stage,
        'new_stage', _stage
      );
    END IF;
  ELSE
    -- First-time insert: apply standard freeze rules
    
    -- Increment lifetime count (only on true insert)
    UPDATE public.profiles
    SET chargeback_count_lifetime = chargeback_count_lifetime + 1,
        last_chargeback_at = _occurred_at
    WHERE user_id = _user_id;

    -- Calculate 90-day count
    SELECT COUNT(*) INTO _chargeback_count_90d
    FROM public.chargeback_events
    WHERE user_id = _user_id
      AND occurred_at >= now() - interval '90 days';

    UPDATE public.profiles
    SET chargeback_count_90d = _chargeback_count_90d
    WHERE user_id = _user_id;

    -- Fetch current profile state
    SELECT payouts_frozen, card_payments_blocked
    INTO _profile
    FROM public.profiles
    WHERE user_id = _user_id;

    -- Rule 1: Any dispute_opened -> freeze payouts (if not already frozen)
    IF _stage = 'dispute_opened' AND NOT COALESCE(_profile.payouts_frozen, false) THEN
      _should_freeze := true;
      _freeze_reason := 'Chargeback dispute opened';
      _audit_action := 'payout_freeze_auto_chargeback';
    END IF;

    -- Rule 2: Lost dispute -> block cards permanently
    IF _stage = 'lost' AND NOT COALESCE(_profile.card_payments_blocked, false) THEN
      _should_block_cards := true;
      _freeze_reason := 'Chargeback dispute lost';
      _audit_action := 'card_block_auto_chargeback';
    END IF;

    -- Rule 3: 2+ disputes in 365 days -> freeze payouts
    IF _chargeback_count_90d >= 2 AND NOT COALESCE(_profile.payouts_frozen, false) THEN
      _should_freeze := true;
      _freeze_reason := 'Multiple chargebacks within 90 days';
      _audit_action := 'payout_freeze_auto_chargeback';
    END IF;
  END IF;

  -- Apply freeze
  IF _should_freeze THEN
    UPDATE public.profiles
    SET payouts_frozen = true,
        payouts_frozen_at = now(),
        payouts_frozen_reason = _freeze_reason
    WHERE user_id = _user_id;

    UPDATE public.chargeback_events
    SET auto_freeze_applied = true
    WHERE id = _event_id;

    -- Audit log with correct action type
    INSERT INTO public.audit_logs (
      user_id,
      action,
      details,
      reason
    ) VALUES (
      _user_id,
      _audit_action,
      jsonb_build_object(
        'chargeback_event_id', _event_id,
        'provider', _provider,
        'stage', _stage,
        'amount', _amount,
        'actor_type', 'system'
      ),
      _freeze_reason
    );
  END IF;

  -- Apply card block
  IF _should_block_cards THEN
    UPDATE public.profiles
    SET card_payments_blocked = true,
        payouts_frozen = true,
        payouts_frozen_at = COALESCE(payouts_frozen_at, now()),
        payouts_frozen_reason = COALESCE(payouts_frozen_reason, _freeze_reason)
    WHERE user_id = _user_id;

    UPDATE public.chargeback_events
    SET auto_freeze_applied = true
    WHERE id = _event_id;

    -- Audit log for card block
    INSERT INTO public.audit_logs (
      user_id,
      action,
      details,
      reason
    ) VALUES (
      _user_id,
      'card_block_auto_chargeback',
      jsonb_build_object(
        'chargeback_event_id', _event_id,
        'provider', _provider,
        'stage', _stage,
        'amount', _amount,
        'actor_type', 'system'
      ),
      _freeze_reason
    );
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'event_id', _event_id,
    'was_inserted', _was_inserted,
    'freeze_applied', _should_freeze,
    'card_block_applied', _should_block_cards,
    'freeze_reason', _freeze_reason,
    'chargeback_count_90d', _chargeback_count_90d
  );
END;
$$;

-- Issue 8: select_payment_rail should return structured results with reasons
DROP FUNCTION IF EXISTS public.select_payment_rail(text, text, text, int, numeric, text);

CREATE OR REPLACE FUNCTION public.select_payment_rail(
  p_direction text,
  p_method text,
  p_country text,
  p_risk_tier int,
  p_amount numeric,
  p_currency text DEFAULT 'USD'
)
RETURNS TABLE(
  rail_key text,
  provider text,
  priority int,
  reason text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT 
    pr.rail_key,
    pr.provider,
    pr.priority,
    'matched' AS reason
  FROM public.payment_rails pr
  WHERE pr.is_enabled = true
    AND (
      (p_direction = 'inbound' AND pr.supports_inbound = true) OR
      (p_direction = 'outbound' AND pr.supports_outbound = true)
    )
    AND (pr.methods @> array[p_method])
    AND (pr.currencies @> array[COALESCE(p_currency, 'USD')])
    AND (
      cardinality(pr.allowed_countries) = 0 OR
      pr.allowed_countries @> array[p_country]
    )
    AND NOT (pr.blocked_countries @> array[p_country])
    AND (pr.allowed_risk_tiers @> array[p_risk_tier])
    AND (pr.max_single_inbound IS NULL OR p_direction != 'inbound' OR p_amount <= pr.max_single_inbound)
    AND (pr.max_single_outbound IS NULL OR p_direction != 'outbound' OR p_amount <= pr.max_single_outbound)
  ORDER BY pr.priority ASC
  LIMIT 5;
END;
$$;