
-- Replace governor_apply_lock with version that stores canonical lock owner in system_settings
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
  v_changed jsonb := '[]'::jsonb;
  v_was_inbound boolean;
  v_was_outbound boolean;
  v_was_intake_paused boolean;
  v_intake_val jsonb;
BEGIN
  -- Lock payment_system_state row
  SELECT id, is_paused_inbound, is_paused_outbound
    INTO v_ps_id, v_was_inbound, v_was_outbound
    FROM payment_system_state
    LIMIT 1
    FOR UPDATE;

  -- Read intake state
  SELECT value INTO v_intake_val
    FROM system_settings
    WHERE key = 'global_intake_active'
    FOR UPDATE;

  -- intake is paused if value is false (jsonb boolean) or missing
  v_was_intake_paused := COALESCE(v_intake_val::text, 'true') NOT IN ('true', '"true"');

  IF p_action = 'lock' THEN
    -- Full lock: enforce all 3 switches regardless of current state
    IF NOT v_was_inbound THEN
      UPDATE payment_system_state
        SET is_paused_inbound = true,
            pause_reason = COALESCE(p_reason, pause_reason),
            paused_at = COALESCE(paused_at, now()),
            paused_by = NULL,
            updated_at = now()
        WHERE id = v_ps_id;
      v_changed := v_changed || '"inbound"'::jsonb;
    END IF;

    IF NOT v_was_outbound THEN
      UPDATE payment_system_state
        SET is_paused_outbound = true,
            pause_reason = COALESCE(p_reason, pause_reason),
            paused_at = COALESCE(paused_at, now()),
            paused_by = NULL,
            updated_at = now()
        WHERE id = v_ps_id;
      v_changed := v_changed || '"outbound"'::jsonb;
    END IF;

    IF NOT v_was_intake_paused THEN
      INSERT INTO system_settings (key, value, updated_at)
        VALUES ('global_intake_active', 'false'::jsonb, now())
        ON CONFLICT (key) DO UPDATE SET value = 'false'::jsonb, updated_at = now();
      v_changed := v_changed || '"intake"'::jsonb;
    END IF;

    -- If we changed at least the pause_reason, ensure it's set even if all were already locked
    IF v_was_inbound AND v_was_outbound AND v_was_intake_paused THEN
      -- Already fully locked, just update reason if provided
      IF p_reason IS NOT NULL THEN
        UPDATE payment_system_state
          SET pause_reason = p_reason, updated_at = now()
          WHERE id = v_ps_id;
      END IF;
    END IF;

    -- Store canonical lock owner
    INSERT INTO system_settings (key, value, updated_at)
      VALUES ('kill_switch_owner', jsonb_build_object('owner', p_locked_by, 'reason', p_reason, 'at', now()::text), now())
      ON CONFLICT (key) DO UPDATE SET value = jsonb_build_object('owner', p_locked_by, 'reason', p_reason, 'at', now()::text), updated_at = now();

    RETURN jsonb_build_object(
      'action', 'locked',
      'changed', v_changed,
      'was_fully_locked', v_was_inbound AND v_was_outbound AND v_was_intake_paused
    );

  ELSIF p_action = 'unlock_intake' THEN
    IF v_was_intake_paused THEN
      INSERT INTO system_settings (key, value, updated_at)
        VALUES ('global_intake_active', 'true'::jsonb, now())
        ON CONFLICT (key) DO UPDATE SET value = 'true'::jsonb, updated_at = now();
    END IF;
    RETURN jsonb_build_object('action', 'unlock_intake', 'was_locked', v_was_intake_paused);

  ELSIF p_action = 'unlock_outbound' THEN
    IF v_was_outbound THEN
      UPDATE payment_system_state
        SET is_paused_outbound = false, updated_at = now()
        WHERE id = v_ps_id;
    END IF;
    RETURN jsonb_build_object('action', 'unlock_outbound', 'was_locked', v_was_outbound);

  ELSIF p_action = 'unlock_inbound' THEN
    IF v_was_inbound THEN
      UPDATE payment_system_state
        SET is_paused_inbound = false,
            pause_reason = NULL,
            paused_at = NULL,
            paused_by = NULL,
            updated_at = now()
        WHERE id = v_ps_id;
    END IF;
    -- Clear lock owner on final unlock stage
    INSERT INTO system_settings (key, value, updated_at)
      VALUES ('kill_switch_owner', '{"owner":"none"}'::jsonb, now())
      ON CONFLICT (key) DO UPDATE SET value = '{"owner":"none"}'::jsonb, updated_at = now();
    RETURN jsonb_build_object('action', 'unlock_inbound', 'was_locked', v_was_inbound);

  ELSE
    RAISE EXCEPTION 'Unknown action: %', p_action;
  END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.governor_apply_lock(text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.governor_apply_lock(text, text, text) TO service_role;

-- Replace update_governor_config with tighten-only version
CREATE OR REPLACE FUNCTION public.update_governor_config(p_config jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_current jsonb;
  v_new_strict boolean;
  v_old_strict boolean;
  v_new_streak int;
  v_old_streak int;
  v_new_buffer numeric;
  v_old_buffer numeric;
BEGIN
  SELECT value INTO v_current
    FROM system_settings
    WHERE key = 'governor_config';

  v_current := COALESCE(v_current, '{}'::jsonb);

  -- Extract old vs new values
  v_old_strict := COALESCE((v_current->>'strict_launch_mode')::boolean, true);
  v_new_strict := COALESCE((p_config->>'strict_launch_mode')::boolean, v_old_strict);

  v_old_streak := COALESCE((v_current->>'unlock_after_consecutive_safe')::int, 3);
  v_new_streak := COALESCE((p_config->>'unlock_after_consecutive_safe')::int, v_old_streak);

  v_old_buffer := COALESCE((v_current->>'min_net_buffer')::numeric, 1);
  v_new_buffer := COALESCE((p_config->>'min_net_buffer')::numeric, v_old_buffer);

  -- Tighten-only enforcement: cannot loosen without break_glass
  IF (p_config->>'break_glass') IS DISTINCT FROM 'true' THEN
    -- Cannot disable strict mode
    IF v_old_strict = true AND v_new_strict = false THEN
      RAISE EXCEPTION 'Cannot disable strict mode without break_glass=true';
    END IF;
    -- Cannot lower streak threshold
    IF v_new_streak < v_old_streak THEN
      RAISE EXCEPTION 'Cannot lower unlock_after_consecutive_safe without break_glass=true (current: %, requested: %)', v_old_streak, v_new_streak;
    END IF;
    -- Cannot lower min buffer
    IF v_new_buffer < v_old_buffer THEN
      RAISE EXCEPTION 'Cannot lower min_net_buffer without break_glass=true (current: %, requested: %)', v_old_buffer, v_new_buffer;
    END IF;
    -- Cannot disable governor
    IF COALESCE((v_current->>'enabled')::boolean, true) = true
       AND COALESCE((p_config->>'enabled')::boolean, true) = false THEN
      RAISE EXCEPTION 'Cannot disable governor without break_glass=true';
    END IF;
    -- Cannot disable auto_lock
    IF COALESCE((v_current->>'auto_lock')::boolean, true) = true
       AND COALESCE((p_config->>'auto_lock')::boolean, true) = false THEN
      RAISE EXCEPTION 'Cannot disable auto_lock without break_glass=true';
    END IF;
  END IF;

  -- Merge (p_config wins, minus break_glass key)
  v_current := v_current || (p_config - 'break_glass');

  UPDATE system_settings SET value = v_current, updated_at = now()
    WHERE key = 'governor_config';

  RETURN jsonb_build_object('ok', true, 'config', v_current);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.update_governor_config(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_governor_config(jsonb) TO service_role, authenticated;
