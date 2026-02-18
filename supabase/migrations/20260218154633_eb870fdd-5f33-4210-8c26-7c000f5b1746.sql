
-- Replace governor_apply_lock with gold-standard version
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
  v_inbound boolean;
  v_outbound boolean;
  v_pause_reason text;
  v_intake_raw jsonb;
  v_intake_active boolean;
  v_owner jsonb;
  v_changed text[] := array[]::text[];
  v_now timestamptz := now();
  v_any_paused boolean;
BEGIN
  -- 1. Ensure payment_system_state row exists, then lock it
  SELECT id INTO v_ps_id
    FROM public.payment_system_state
    LIMIT 1;

  IF v_ps_id IS NULL THEN
    INSERT INTO public.payment_system_state (is_paused_inbound, is_paused_outbound, pause_reason, paused_at)
      VALUES (false, false, null, null)
      RETURNING id INTO v_ps_id;
  END IF;

  SELECT is_paused_inbound, is_paused_outbound, pause_reason
    INTO v_inbound, v_outbound, v_pause_reason
    FROM public.payment_system_state
    WHERE id = v_ps_id
    FOR UPDATE;

  -- 2. Read intake state
  SELECT value INTO v_intake_raw
    FROM public.system_settings
    WHERE key = 'global_intake_active'
    LIMIT 1;

  -- Parse intake_active robustly from jsonb
  v_intake_active := NULL;
  IF v_intake_raw IS NOT NULL THEN
    IF jsonb_typeof(v_intake_raw) = 'boolean' THEN
      v_intake_active := (v_intake_raw)::boolean;
    ELSIF jsonb_typeof(v_intake_raw) = 'string' THEN
      IF lower(v_intake_raw::text) = '"true"' THEN v_intake_active := true; END IF;
      IF lower(v_intake_raw::text) = '"false"' THEN v_intake_active := false; END IF;
    END IF;
  END IF;

  -- 3. Read current owner
  SELECT value INTO v_owner
    FROM public.system_settings
    WHERE key = 'kill_switch_owner'
    LIMIT 1;

  -- ═══════════════════════════════════════════════════════════════
  -- LOCK: enforce all 3 switches + set canonical owner
  -- ═══════════════════════════════════════════════════════════════
  IF p_action = 'lock' THEN
    -- inbound
    IF v_inbound IS DISTINCT FROM true THEN
      UPDATE public.payment_system_state
        SET is_paused_inbound = true,
            paused_at = COALESCE(paused_at, v_now)
        WHERE id = v_ps_id;
      v_changed := array_append(v_changed, 'inbound');
    END IF;

    -- outbound
    IF v_outbound IS DISTINCT FROM true THEN
      UPDATE public.payment_system_state
        SET is_paused_outbound = true,
            paused_at = COALESCE(paused_at, v_now)
        WHERE id = v_ps_id;
      v_changed := array_append(v_changed, 'outbound');
    END IF;

    -- reason (set only if currently empty)
    IF (v_pause_reason IS NULL OR v_pause_reason = '') THEN
      UPDATE public.payment_system_state
        SET pause_reason = COALESCE(p_reason, format('Governor lock (%s)', p_locked_by))
        WHERE id = v_ps_id;
      v_changed := array_append(v_changed, 'reason');
    END IF;

    -- intake → false
    IF v_intake_active IS DISTINCT FROM false THEN
      INSERT INTO public.system_settings(key, value, updated_at)
        VALUES ('global_intake_active', to_jsonb(false), v_now)
        ON CONFLICT (key)
        DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;
      v_changed := array_append(v_changed, 'intake');
    END IF;

    -- canonical owner (always set on lock)
    INSERT INTO public.system_settings(key, value, updated_at)
      VALUES (
        'kill_switch_owner',
        jsonb_build_object('owner', p_locked_by, 'reason', COALESCE(p_reason, ''), 'at', v_now),
        v_now
      )
      ON CONFLICT (key)
      DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;
    v_changed := array_append(v_changed, 'owner');

    RETURN jsonb_build_object('ok', true, 'action', 'lock', 'changed', v_changed);

  -- ═══════════════════════════════════════════════════════════════
  -- STAGED UNLOCK: intake
  -- ═══════════════════════════════════════════════════════════════
  ELSIF p_action = 'unlock_intake' THEN
    IF v_intake_active IS DISTINCT FROM true THEN
      INSERT INTO public.system_settings(key, value, updated_at)
        VALUES ('global_intake_active', to_jsonb(true), v_now)
        ON CONFLICT (key)
        DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;
      v_changed := array_append(v_changed, 'intake');
    END IF;
    RETURN jsonb_build_object('ok', true, 'action', 'unlock_intake', 'changed', v_changed);

  -- ═══════════════════════════════════════════════════════════════
  -- STAGED UNLOCK: outbound
  -- ═══════════════════════════════════════════════════════════════
  ELSIF p_action = 'unlock_outbound' THEN
    IF v_outbound IS DISTINCT FROM false THEN
      UPDATE public.payment_system_state
        SET is_paused_outbound = false
        WHERE id = v_ps_id;
      v_changed := array_append(v_changed, 'outbound');
    END IF;
    RETURN jsonb_build_object('ok', true, 'action', 'unlock_outbound', 'changed', v_changed);

  -- ═══════════════════════════════════════════════════════════════
  -- STAGED UNLOCK: inbound (final stage — clears owner if fully unlocked)
  -- ═══════════════════════════════════════════════════════════════
  ELSIF p_action = 'unlock_inbound' THEN
    IF v_inbound IS DISTINCT FROM false THEN
      UPDATE public.payment_system_state
        SET is_paused_inbound = false
        WHERE id = v_ps_id;
      v_changed := array_append(v_changed, 'inbound');
    END IF;

    -- Re-read full state to check if now fully unlocked
    SELECT is_paused_inbound, is_paused_outbound, pause_reason
      INTO v_inbound, v_outbound, v_pause_reason
      FROM public.payment_system_state
      WHERE id = v_ps_id;

    SELECT value INTO v_intake_raw
      FROM public.system_settings
      WHERE key = 'global_intake_active'
      LIMIT 1;

    v_intake_active := NULL;
    IF v_intake_raw IS NOT NULL THEN
      IF jsonb_typeof(v_intake_raw) = 'boolean' THEN
        v_intake_active := (v_intake_raw)::boolean;
      ELSIF jsonb_typeof(v_intake_raw) = 'string' THEN
        IF lower(v_intake_raw::text) = '"true"' THEN v_intake_active := true; END IF;
        IF lower(v_intake_raw::text) = '"false"' THEN v_intake_active := false; END IF;
      END IF;
    END IF;

    v_any_paused := COALESCE(v_inbound, false)
                 OR COALESCE(v_outbound, false)
                 OR (v_intake_active IS DISTINCT FROM true);

    -- If fully unlocked: clear reason, paused_at, and owner
    IF NOT v_any_paused THEN
      UPDATE public.payment_system_state
        SET pause_reason = NULL,
            paused_at = NULL
        WHERE id = v_ps_id;
      v_changed := array_append(v_changed, 'reason');

      INSERT INTO public.system_settings(key, value, updated_at)
        VALUES ('kill_switch_owner', jsonb_build_object('owner', 'none', 'reason', NULL, 'at', v_now), v_now)
        ON CONFLICT (key)
        DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;
      v_changed := array_append(v_changed, 'owner');
    END IF;

    RETURN jsonb_build_object('ok', true, 'action', 'unlock_inbound', 'changed', v_changed);

  ELSE
    RAISE EXCEPTION 'Invalid p_action: %', p_action;
  END IF;
END;
$$;

-- Permissions: service_role only
REVOKE EXECUTE ON FUNCTION public.governor_apply_lock(text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.governor_apply_lock(text, text, text) TO service_role;
