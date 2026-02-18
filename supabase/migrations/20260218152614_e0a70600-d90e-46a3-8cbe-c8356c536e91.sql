
-- 1. Add warnings + config snapshot columns to governor_certifications
ALTER TABLE public.governor_certifications
  ADD COLUMN IF NOT EXISTS warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS config_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb;

-- 2. Replace governor_apply_lock with idempotent, 3-switch-aware version
CREATE OR REPLACE FUNCTION public.governor_apply_lock(
  p_action text,
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
  v_ps record;
  v_intake_val jsonb;
  v_result jsonb;
  v_changes text[] := '{}';
BEGIN
  -- Get payment_system_state row with full state
  SELECT id, is_paused_inbound, is_paused_outbound, pause_reason, paused_at
    INTO v_ps
    FROM payment_system_state
    LIMIT 1
    FOR UPDATE;  -- lock row for duration

  IF v_ps.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'No payment_system_state row');
  END IF;

  -- Get current intake state
  SELECT value INTO v_intake_val FROM system_settings WHERE key = 'global_intake_active';

  CASE p_action
    -- ================================================================
    -- FULL LOCK: reconcile all 3 switches to locked, idempotently
    -- ================================================================
    WHEN 'lock' THEN
      -- Inbound
      IF NOT v_ps.is_paused_inbound THEN
        v_changes := array_append(v_changes, 'inbound');
      END IF;
      -- Outbound
      IF NOT v_ps.is_paused_outbound THEN
        v_changes := array_append(v_changes, 'outbound');
      END IF;

      UPDATE payment_system_state SET
        is_paused_inbound = true,
        is_paused_outbound = true,
        pause_reason = coalesce(p_reason, pause_reason, 'Governor auto-lock'),
        paused_at = coalesce(paused_at, now()),
        updated_at = now()
      WHERE id = v_ps.id;

      -- Intake
      IF v_intake_val IS NULL OR v_intake_val::text != 'false' THEN
        v_changes := array_append(v_changes, 'intake');
      END IF;

      INSERT INTO system_settings (key, value, updated_at)
      VALUES ('global_intake_active', 'false'::jsonb, now())
      ON CONFLICT (key) DO UPDATE SET value = 'false'::jsonb, updated_at = now();

      v_result := jsonb_build_object(
        'ok', true,
        'action', 'locked',
        'changed', to_jsonb(v_changes),
        'detail', format('Governor locked — changed: %s', array_to_string(v_changes, ', '))
      );

    -- ================================================================
    -- STAGED UNLOCK: each step is idempotent (no-op if already in target state)
    -- ================================================================
    WHEN 'unlock_intake' THEN
      INSERT INTO system_settings (key, value, updated_at)
      VALUES ('global_intake_active', 'true'::jsonb, now())
      ON CONFLICT (key) DO UPDATE SET value = 'true'::jsonb, updated_at = now();

      v_result := jsonb_build_object('ok', true, 'action', 'unlock_intake',
        'was_locked', coalesce(v_intake_val::text, 'null') != 'true',
        'detail', 'Intake re-enabled');

    WHEN 'unlock_outbound' THEN
      UPDATE payment_system_state SET
        is_paused_outbound = false,
        updated_at = now()
      WHERE id = v_ps.id;

      v_result := jsonb_build_object('ok', true, 'action', 'unlock_outbound',
        'was_locked', v_ps.is_paused_outbound,
        'detail', 'Outbound re-enabled');

    WHEN 'unlock_inbound' THEN
      UPDATE payment_system_state SET
        is_paused_inbound = false,
        pause_reason = NULL,
        paused_at = NULL,
        updated_at = now()
      WHERE id = v_ps.id;

      v_result := jsonb_build_object('ok', true, 'action', 'unlock_inbound',
        'was_locked', v_ps.is_paused_inbound,
        'detail', 'Inbound re-enabled — system fully unlocked');

    WHEN 'full_unlock' THEN
      UPDATE payment_system_state SET
        is_paused_inbound = false,
        is_paused_outbound = false,
        pause_reason = NULL,
        paused_at = NULL,
        updated_at = now()
      WHERE id = v_ps.id;

      INSERT INTO system_settings (key, value, updated_at)
      VALUES ('global_intake_active', 'true'::jsonb, now())
      ON CONFLICT (key) DO UPDATE SET value = 'true'::jsonb, updated_at = now();

      v_result := jsonb_build_object('ok', true, 'action', 'full_unlock',
        'detail', 'Operator override: all 3 switches unlocked');

    ELSE
      v_result := jsonb_build_object('ok', false, 'error', format('Unknown action: %s', p_action));
  END CASE;

  RETURN v_result;
END;
$$;

-- Re-apply permissions
REVOKE EXECUTE ON FUNCTION public.governor_apply_lock FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.governor_apply_lock FROM anon;
REVOKE EXECUTE ON FUNCTION public.governor_apply_lock FROM authenticated;
GRANT EXECUTE ON FUNCTION public.governor_apply_lock TO service_role;

-- 3. Create admin RPC to update governor config safely
CREATE OR REPLACE FUNCTION public.update_governor_config(
  p_config jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO system_settings (key, value, updated_at)
  VALUES ('governor_config', p_config, now())
  ON CONFLICT (key) DO UPDATE SET value = p_config, updated_at = now();

  RETURN jsonb_build_object('ok', true, 'config', p_config);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.update_governor_config FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.update_governor_config FROM anon;
GRANT EXECUTE ON FUNCTION public.update_governor_config TO service_role;
GRANT EXECUTE ON FUNCTION public.update_governor_config TO authenticated;
