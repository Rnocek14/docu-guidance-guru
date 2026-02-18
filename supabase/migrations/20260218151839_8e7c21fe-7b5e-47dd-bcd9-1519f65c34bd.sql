
-- ============================================================================
-- ATOMIC GOVERNOR LOCK/UNLOCK RPC
-- Ensures all kill switches are toggled in one transaction
-- ============================================================================

-- Add safe_streak column to governor_certifications for consecutive-safe tracking
ALTER TABLE public.governor_certifications
  ADD COLUMN IF NOT EXISTS safe_streak integer NOT NULL DEFAULT 0;

-- Create the atomic governor state RPC
CREATE OR REPLACE FUNCTION public.governor_apply_lock(
  p_action text,           -- 'lock' | 'unlock_intake' | 'unlock_outbound' | 'unlock_inbound' | 'full_unlock'
  p_reason text DEFAULT NULL,
  p_locked_by text DEFAULT 'governor'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ps_id uuid;
  v_result jsonb;
BEGIN
  -- Get payment_system_state row
  SELECT id INTO v_ps_id FROM payment_system_state LIMIT 1;
  IF v_ps_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'No payment_system_state row');
  END IF;

  CASE p_action
    WHEN 'lock' THEN
      -- Full crisis lock: inbound + outbound + intake
      UPDATE payment_system_state SET
        is_paused_inbound = true,
        is_paused_outbound = true,
        pause_reason = p_reason,
        paused_by = NULL, -- UUID column, use pause_reason for attribution
        paused_at = now(),
        updated_at = now()
      WHERE id = v_ps_id;

      -- Pause intake
      INSERT INTO system_settings (key, value, updated_at)
      VALUES ('global_intake_active', 'false'::jsonb, now())
      ON CONFLICT (key) DO UPDATE SET value = 'false'::jsonb, updated_at = now();

      v_result := jsonb_build_object(
        'ok', true,
        'action', 'locked',
        'detail', format('Governor locked: %s', p_reason)
      );

    WHEN 'unlock_intake' THEN
      -- Stage 1: re-enable intake only
      INSERT INTO system_settings (key, value, updated_at)
      VALUES ('global_intake_active', 'true'::jsonb, now())
      ON CONFLICT (key) DO UPDATE SET value = 'true'::jsonb, updated_at = now();

      v_result := jsonb_build_object('ok', true, 'action', 'unlock_intake', 'detail', 'Intake re-enabled');

    WHEN 'unlock_outbound' THEN
      -- Stage 2: re-enable outbound
      UPDATE payment_system_state SET
        is_paused_outbound = false,
        updated_at = now()
      WHERE id = v_ps_id;

      v_result := jsonb_build_object('ok', true, 'action', 'unlock_outbound', 'detail', 'Outbound re-enabled');

    WHEN 'unlock_inbound' THEN
      -- Stage 3: re-enable inbound (final stage) + clear pause metadata
      UPDATE payment_system_state SET
        is_paused_inbound = false,
        pause_reason = NULL,
        paused_at = NULL,
        updated_at = now()
      WHERE id = v_ps_id;

      v_result := jsonb_build_object('ok', true, 'action', 'unlock_inbound', 'detail', 'Inbound re-enabled — system fully unlocked');

    WHEN 'full_unlock' THEN
      -- All-at-once unlock (for operator override)
      UPDATE payment_system_state SET
        is_paused_inbound = false,
        is_paused_outbound = false,
        pause_reason = NULL,
        paused_at = NULL,
        updated_at = now()
      WHERE id = v_ps_id;

      INSERT INTO system_settings (key, value, updated_at)
      VALUES ('global_intake_active', 'true'::jsonb, now())
      ON CONFLICT (key) DO UPDATE SET value = 'true'::jsonb, updated_at = now();

      v_result := jsonb_build_object('ok', true, 'action', 'full_unlock', 'detail', 'Full operator override unlock');

    ELSE
      v_result := jsonb_build_object('ok', false, 'error', format('Unknown action: %s', p_action));
  END CASE;

  RETURN v_result;
END;
$$;

-- Restrict access: only service_role can call this
REVOKE EXECUTE ON FUNCTION public.governor_apply_lock FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.governor_apply_lock FROM anon;
REVOKE EXECUTE ON FUNCTION public.governor_apply_lock FROM authenticated;
GRANT EXECUTE ON FUNCTION public.governor_apply_lock TO service_role;
