
-- Add admin role guard to update_governor_config
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
  -- Admin-only guard
  IF NOT EXISTS (
    SELECT 1 FROM user_roles
    WHERE user_id = auth.uid() AND role = 'admin'
  ) THEN
    RAISE EXCEPTION 'Admin only';
  END IF;

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
    IF v_old_strict = true AND v_new_strict = false THEN
      RAISE EXCEPTION 'Cannot disable strict mode without break_glass=true';
    END IF;
    IF v_new_streak < v_old_streak THEN
      RAISE EXCEPTION 'Cannot lower unlock_after_consecutive_safe without break_glass=true (current: %, requested: %)', v_old_streak, v_new_streak;
    END IF;
    IF v_new_buffer < v_old_buffer THEN
      RAISE EXCEPTION 'Cannot lower min_net_buffer without break_glass=true (current: %, requested: %)', v_old_buffer, v_new_buffer;
    END IF;
    IF COALESCE((v_current->>'enabled')::boolean, true) = true
       AND COALESCE((p_config->>'enabled')::boolean, true) = false THEN
      RAISE EXCEPTION 'Cannot disable governor without break_glass=true';
    END IF;
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
