
-- -----------------------------------------------------------------------
-- FIX 1: Fix ON CONFLICT syntax in propose_econ_auto_tightening
-- Remove invalid WHERE clause from ON CONFLICT (partial index is matched automatically)
-- -----------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.propose_econ_auto_tightening(
  _econ jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status text;
  v_pass_rate_7d numeric;
  v_pass_rate_30d numeric;
  v_pass_rate_delta numeric;
  v_reserve_breach_prob numeric;
  v_total_pending int;
BEGIN
  v_status := _econ->>'status';
  v_pass_rate_7d := COALESCE((_econ->'metrics'->>'pass_rate_7d')::numeric, 0);
  v_pass_rate_30d := COALESCE((_econ->'metrics'->>'pass_rate_30d')::numeric, 0);
  v_pass_rate_delta := COALESCE((_econ->'metrics'->>'pass_rate_delta')::numeric, 0);
  v_reserve_breach_prob := COALESCE((_econ->'metrics'->>'reserve_breach_prob')::numeric, 0);

  IF v_status NOT IN ('warn', 'block') THEN
    RETURN jsonb_build_object('proposals_pending', 0, 'status', v_status);
  END IF;

  -- Propose: increase payout cooldown
  IF v_pass_rate_7d > 0.13 OR v_pass_rate_delta > 0.02 THEN
    INSERT INTO safety_setting_changes (
      setting_key, proposed_by, proposed_by_system, proposed_value, reason, status
    ) VALUES (
      'payout_cooldown_increase', NULL, true,
      jsonb_build_object('suggested_cooldown_days', 45, 'pass_rate_7d', round(v_pass_rate_7d * 100, 1), 'pass_rate_30d', round(v_pass_rate_30d * 100, 1)),
      format('Auto: pass rate trend (7d=%.1f%%, 30d=%.1f%%, delta=+%.1f%%)', v_pass_rate_7d * 100, v_pass_rate_30d * 100, v_pass_rate_delta * 100),
      'pending'
    ) ON CONFLICT (setting_key) DO NOTHING;
  END IF;

  -- Propose: reduce payout split
  IF v_pass_rate_7d > 0.15 OR v_reserve_breach_prob > 0.02 THEN
    INSERT INTO safety_setting_changes (
      setting_key, proposed_by, proposed_by_system, proposed_value, reason, status
    ) VALUES (
      'payout_split_reduction', NULL, true,
      jsonb_build_object('suggested_split_percent', 70, 'reserve_breach_prob', round(v_reserve_breach_prob * 100, 1)),
      format('Auto: reduce split due to %s', CASE WHEN v_pass_rate_7d > 0.15 THEN 'critical pass rate' ELSE 'reserve breach risk' END),
      'pending'
    ) ON CONFLICT (setting_key) DO NOTHING;
  END IF;

  -- Propose: mandatory manual review
  IF v_status = 'block' THEN
    INSERT INTO safety_setting_changes (
      setting_key, proposed_by, proposed_by_system, proposed_value, reason, status
    ) VALUES (
      'mandatory_manual_review', NULL, true,
      jsonb_build_object('require_manual_review', true, 'block_reasons', _econ->'reasons'),
      'Auto: econ gate BLOCK — require manual review',
      'pending'
    ) ON CONFLICT (setting_key) DO NOTHING;
  END IF;

  SELECT count(*) INTO v_total_pending
  FROM safety_setting_changes
  WHERE proposed_by_system = true AND status = 'pending';

  RETURN jsonb_build_object('proposals_pending', v_total_pending, 'status', v_status, 'evaluated_at', now());
END;
$$;

-- FIX 3: Revoke service_role from approve_safety_setting_change (human-only)
REVOKE EXECUTE ON FUNCTION public.approve_safety_setting_change(uuid, text) FROM service_role;
