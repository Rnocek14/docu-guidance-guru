-- P0-A Final Sign-off: Close last edges

-- ============================================
-- 1) Explicit GRANT to service_role for process_chargeback_event
-- ============================================

-- Ensure no one except service_role can call this
REVOKE EXECUTE ON FUNCTION public.process_chargeback_event(
  uuid, text, text, text, text, text, numeric, text, timestamptz, text, inet, text
) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.process_chargeback_event(
  uuid, text, text, text, text, text, numeric, text, timestamptz, text, inet, text
) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.process_chargeback_event(
  uuid, text, text, text, text, text, numeric, text, timestamptz, text, inet, text
) TO service_role;

-- ============================================
-- 2) Restrict manual_payout_unfreeze to service_role only
-- ============================================

REVOKE EXECUTE ON FUNCTION public.manual_payout_unfreeze(uuid, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.manual_payout_unfreeze(uuid, text, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.manual_payout_unfreeze(uuid, text, text) TO service_role;

-- ============================================
-- 3) Fix immutability trigger - no role check, pure immutability
-- ============================================

CREATE OR REPLACE FUNCTION public.block_kyc_legal_name_changes()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- Pure immutability: once set, cannot be changed by anyone
    IF OLD.kyc_legal_name IS NOT NULL 
       AND NEW.kyc_legal_name IS DISTINCT FROM OLD.kyc_legal_name THEN
      RAISE EXCEPTION 'kyc_legal_name is immutable once set';
    END IF;
    -- If OLD is NULL, allow the change (first-time KYC verification)
  END IF;
  RETURN NEW;
END;
$$;

-- ============================================
-- 4) Make audit_logs tamper-resistant (no UPDATE/DELETE)
-- ============================================

-- Block all updates on audit_logs
DROP POLICY IF EXISTS "No updates on audit_logs" ON public.audit_logs;
CREATE POLICY "No updates on audit_logs" ON public.audit_logs
  FOR UPDATE USING (false);

-- Block all deletes on audit_logs  
DROP POLICY IF EXISTS "No deletes on audit_logs" ON public.audit_logs;
CREATE POLICY "No deletes on audit_logs" ON public.audit_logs
  FOR DELETE USING (false);

-- ============================================
-- 5) Fix chargeback counts to only count meaningful stages
-- ============================================

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
  _chargeback_count_365d integer;
  _should_freeze boolean := false;
  _should_block_cards boolean := false;
  _freeze_reason text;
  _audit_action public.audit_action;
  _request_id uuid := gen_random_uuid();
BEGIN
  -- Validate stage is meaningful
  IF _stage NOT IN ('dispute_opened', 'lost', 'won', 'warning') THEN
    RETURN jsonb_build_object(
      'success', false,
      'reason', 'invalid_stage',
      'valid_stages', ARRAY['dispute_opened', 'lost', 'won', 'warning']
    );
  END IF;

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
  IF NOT _was_inserted THEN
    -- Handle stage TRANSITIONS (e.g., dispute_opened -> lost)
    IF _previous_stage = 'dispute_opened' AND _stage = 'lost' THEN
      _should_block_cards := true;
      _freeze_reason := 'Chargeback dispute lost';
      _audit_action := 'card_block_auto_chargeback';
    END IF;
    
    -- "won" does NOT auto-unfreeze - requires manual review
    
    -- If no meaningful transition, return early (idempotent success)
    IF NOT _should_block_cards THEN
      RETURN jsonb_build_object(
        'success', true,
        'event_id', _event_id,
        'was_duplicate', true,
        'previous_stage', _previous_stage,
        'new_stage', _stage,
        'request_id', _request_id,
        'note', CASE WHEN _stage = 'won' THEN 'Dispute won - manual unfreeze required via staff workflow' ELSE NULL END
      );
    END IF;
  ELSE
    -- First-time insert: apply standard freeze rules
    
    -- Only increment lifetime count for meaningful stages (dispute_opened, lost)
    -- NOT for 'warning' or 'won'
    IF _stage IN ('dispute_opened', 'lost') THEN
      UPDATE public.profiles
      SET chargeback_count_lifetime = chargeback_count_lifetime + 1,
          last_chargeback_at = _occurred_at
      WHERE user_id = _user_id;
    END IF;

    -- Calculate 90-day count (only dispute_opened and lost)
    SELECT COUNT(*) INTO _chargeback_count_90d
    FROM public.chargeback_events
    WHERE user_id = _user_id
      AND stage IN ('dispute_opened', 'lost')
      AND occurred_at >= now() - interval '90 days';

    -- Calculate 365-day count (only dispute_opened and lost)
    SELECT COUNT(*) INTO _chargeback_count_365d
    FROM public.chargeback_events
    WHERE user_id = _user_id
      AND stage IN ('dispute_opened', 'lost')
      AND occurred_at >= now() - interval '365 days';

    UPDATE public.profiles
    SET chargeback_count_90d = _chargeback_count_90d,
        chargeback_count_365d = _chargeback_count_365d
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

    -- Rule 3: 2+ disputes in 365 days -> freeze payouts + manual review required
    IF _chargeback_count_365d >= 2 AND NOT COALESCE(_profile.payouts_frozen, false) THEN
      _should_freeze := true;
      _freeze_reason := 'Multiple chargebacks within 365 days - manual review required';
      _audit_action := 'payout_freeze_auto_chargeback';
    END IF;
    
    -- Note: 'warning' stage does NOT trigger any freeze/block action
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

    -- Full audit payload
    INSERT INTO public.audit_logs (
      user_id,
      action,
      details,
      reason,
      request_id
    ) VALUES (
      _user_id,
      _audit_action,
      jsonb_build_object(
        'chargeback_event_id', _event_id,
        'provider', _provider,
        'provider_event_id', _provider_event_id,
        'provider_dispute_id', _provider_dispute_id,
        'stage', _stage,
        'amount', _amount,
        'currency', _currency,
        'actor_type', 'system',
        'actor_user_id', NULL,
        'chargeback_count_90d', _chargeback_count_90d,
        'chargeback_count_365d', _chargeback_count_365d
      ),
      _freeze_reason,
      _request_id
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

    INSERT INTO public.audit_logs (
      user_id,
      action,
      details,
      reason,
      request_id
    ) VALUES (
      _user_id,
      'card_block_auto_chargeback',
      jsonb_build_object(
        'chargeback_event_id', _event_id,
        'provider', _provider,
        'provider_event_id', _provider_event_id,
        'provider_dispute_id', _provider_dispute_id,
        'stage', _stage,
        'amount', _amount,
        'currency', _currency,
        'actor_type', 'system',
        'actor_user_id', NULL,
        'previous_stage', _previous_stage
      ),
      _freeze_reason,
      _request_id
    );
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'event_id', _event_id,
    'was_inserted', _was_inserted,
    'freeze_applied', _should_freeze,
    'card_block_applied', _should_block_cards,
    'freeze_reason', _freeze_reason,
    'chargeback_count_90d', _chargeback_count_90d,
    'chargeback_count_365d', _chargeback_count_365d,
    'request_id', _request_id,
    'stage_counted', _stage IN ('dispute_opened', 'lost')
  );
END;
$$;