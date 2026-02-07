
-- =============================================================================
-- HARDENING: Economic Safety Gate Fixes (Items 1-4, 7)
-- =============================================================================

-- -----------------------------------------------------------------------
-- ITEM 7: Add unique partial index for idempotent proposals
-- -----------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS safety_setting_changes_pending_one_per_key
ON safety_setting_changes(setting_key)
WHERE status = 'pending';

-- -----------------------------------------------------------------------
-- ITEM 4: Make proposed_by nullable + add proposed_by_system flag
-- -----------------------------------------------------------------------
ALTER TABLE safety_setting_changes
  ALTER COLUMN proposed_by DROP NOT NULL;

ALTER TABLE safety_setting_changes
  ADD COLUMN IF NOT EXISTS proposed_by_system boolean NOT NULL DEFAULT false;

-- -----------------------------------------------------------------------
-- ITEM 1+2+3: Refactor get_econ_guardrail_status to be READ-ONLY
-- Fix nested DECLARE, fix cohort hash subquery
-- -----------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_econ_guardrail_status(
  _window_days int DEFAULT 30
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pass_rate_30d numeric;
  v_pass_rate_7d numeric;
  v_pass_rate_delta numeric;
  v_total_accounts_30d int;
  v_passed_accounts_30d int;
  v_total_accounts_7d int;
  v_passed_accounts_7d int;
  v_sim_run_id uuid;
  v_sim_created_at timestamptz;
  v_sim_age_hours numeric;
  v_sim_stale boolean;
  v_sim_loss_prob numeric;
  v_reserve_breach_prob numeric;
  v_sim_worst_month numeric;
  v_net_buffer numeric;
  v_min_reserve numeric;
  v_reserve_config jsonb;
  v_cash_reserve numeric;
  v_payouts_approved_30d int;
  v_payouts_total_30d int;
  v_approval_rate_30d numeric;
  v_payouts_approved_7d int;
  v_payouts_total_7d int;
  v_approval_rate_7d numeric;
  v_approval_rate_delta numeric;
  v_avg_payout_amount_30d numeric;
  v_pending_payouts_amount numeric;
  v_pending_payouts_count int;
  v_resets_30d int;
  v_resets_7d int;
  v_active_accounts int;
  v_reset_rate_30d numeric;
  v_reset_rate_7d numeric;
  v_reset_rate_delta numeric;
  v_cohort_hash text;
  v_status text := 'ok';
  v_reasons jsonb := '[]'::jsonb;
  v_recommended_actions jsonb := '[]'::jsonb;
BEGIN
  -- 1. PASS RATE
  SELECT count(*), count(*) FILTER (WHERE status IN ('passed','payout_requested','payout_under_review','payout_approved','closed'))
  INTO v_total_accounts_30d, v_passed_accounts_30d
  FROM accounts WHERE created_at >= now() - (_window_days || ' days')::interval;

  v_pass_rate_30d := CASE WHEN v_total_accounts_30d > 0 THEN v_passed_accounts_30d::numeric / v_total_accounts_30d ELSE 0 END;

  SELECT count(*), count(*) FILTER (WHERE status IN ('passed','payout_requested','payout_under_review','payout_approved','closed'))
  INTO v_total_accounts_7d, v_passed_accounts_7d
  FROM accounts WHERE created_at >= now() - interval '7 days';

  v_pass_rate_7d := CASE WHEN v_total_accounts_7d > 0 THEN v_passed_accounts_7d::numeric / v_total_accounts_7d ELSE 0 END;
  v_pass_rate_delta := v_pass_rate_7d - v_pass_rate_30d;

  -- 2. SIMULATION
  SELECT (value->>'last_simulation_run_id')::uuid, value
  INTO v_sim_run_id, v_reserve_config
  FROM system_settings WHERE key = 'reserve_aware_approval';

  v_sim_stale := true;
  v_min_reserve := COALESCE((v_reserve_config->>'min_reserve_after_approval')::numeric, 5000);

  IF v_sim_run_id IS NOT NULL THEN
    SELECT id, created_at, probability_of_loss, reserve_breach_probability, worst_month
    INTO v_sim_run_id, v_sim_created_at, v_sim_loss_prob, v_reserve_breach_prob, v_sim_worst_month
    FROM simulation_runs WHERE id = v_sim_run_id;

    IF v_sim_created_at IS NOT NULL THEN
      v_sim_age_hours := EXTRACT(EPOCH FROM (now() - v_sim_created_at)) / 3600.0;
      v_sim_stale := v_sim_age_hours > 168;
    END IF;
  END IF;

  -- 3. LIABILITY (no nested DECLARE)
  SELECT sum(amount) FILTER (WHERE status IN ('pending','under_review','approved','payment_initiated')),
         count(*) FILTER (WHERE status IN ('pending','under_review','approved','payment_initiated'))
  INTO v_pending_payouts_amount, v_pending_payouts_count
  FROM payouts;

  v_pending_payouts_amount := COALESCE(v_pending_payouts_amount, 0);
  v_pending_payouts_count := COALESCE(v_pending_payouts_count, 0);

  SELECT COALESCE(max(cash_reserve), 0) INTO v_cash_reserve FROM liability_buffer_settings;
  IF v_cash_reserve = 0 THEN
    SELECT COALESCE(max(cash_reserve), 0) INTO v_cash_reserve FROM liability_alerts WHERE is_active = true;
  END IF;
  v_net_buffer := v_cash_reserve - v_pending_payouts_amount;

  -- 4. PAYOUT VOLUME
  SELECT count(*),
         count(*) FILTER (WHERE status IN ('approved','paid','payment_initiated')),
         COALESCE(avg(amount) FILTER (WHERE status IN ('approved','paid','payment_initiated')), 0)
  INTO v_payouts_total_30d, v_payouts_approved_30d, v_avg_payout_amount_30d
  FROM payouts WHERE requested_at >= now() - (_window_days || ' days')::interval;

  v_approval_rate_30d := CASE WHEN v_payouts_total_30d > 0 THEN v_payouts_approved_30d::numeric / v_payouts_total_30d ELSE 0 END;

  SELECT count(*), count(*) FILTER (WHERE status IN ('approved','paid','payment_initiated'))
  INTO v_payouts_total_7d, v_payouts_approved_7d
  FROM payouts WHERE requested_at >= now() - interval '7 days';

  v_approval_rate_7d := CASE WHEN v_payouts_total_7d > 0 THEN v_payouts_approved_7d::numeric / v_payouts_total_7d ELSE 0 END;
  v_approval_rate_delta := v_approval_rate_7d - v_approval_rate_30d;

  -- 5. RESET RATE
  SELECT count(*) INTO v_active_accounts FROM accounts WHERE status = 'active';
  SELECT count(*) INTO v_resets_30d FROM accounts WHERE status = 'active' AND parent_account_id IS NOT NULL AND created_at >= now() - (_window_days || ' days')::interval;
  SELECT count(*) INTO v_resets_7d FROM accounts WHERE status = 'active' AND parent_account_id IS NOT NULL AND created_at >= now() - interval '7 days';

  v_reset_rate_30d := CASE WHEN v_active_accounts > 0 THEN v_resets_30d::numeric / v_active_accounts ELSE 0 END;
  v_reset_rate_7d := CASE WHEN v_active_accounts > 0 THEN v_resets_7d::numeric / v_active_accounts ELSE 0 END;
  v_reset_rate_delta := v_reset_rate_7d - v_reset_rate_30d;

  -- 6. COHORT HASH (correct subquery pattern)
  SELECT md5(string_agg(piece, '|' ORDER BY cname))
  INTO v_cohort_hash
  FROM (
    SELECT name AS cname,
           id::text || ':' || payout_split_percent::text || ':' ||
           COALESCE(lifetime_cap_multiple::text, 'null') || ':' ||
           COALESCE(first_payout_cap_amount::text, 'null') || ':' ||
           max_payout_percent::text || ':' || payout_cooldown_days::text AS piece
    FROM cohorts WHERE is_active = true
  ) t;

  -- 7. BLOCK rules
  IF v_sim_run_id IS NULL OR v_sim_stale THEN
    v_status := 'block';
    v_reasons := v_reasons || jsonb_build_object('code', 'SIMULATION_STALE_OR_MISSING', 'message', CASE WHEN v_sim_run_id IS NULL THEN 'No simulation linked' ELSE format('Simulation %.0fh old (max 168)', v_sim_age_hours) END, 'value', v_sim_age_hours, 'threshold', 168);
    v_recommended_actions := v_recommended_actions || '"Run new Monte Carlo simulation"'::jsonb;
  END IF;

  IF v_reserve_breach_prob IS NOT NULL AND v_reserve_breach_prob > 0.02 THEN
    v_status := 'block';
    v_reasons := v_reasons || jsonb_build_object('code', 'RESERVE_BREACH_RISK', 'message', format('Reserve breach prob %.1f%% (max 2%%)', v_reserve_breach_prob * 100), 'value', v_reserve_breach_prob, 'threshold', 0.02);
    v_recommended_actions := v_recommended_actions || '"Increase cash reserve"'::jsonb;
  END IF;

  IF v_net_buffer < v_min_reserve THEN
    v_status := 'block';
    v_reasons := v_reasons || jsonb_build_object('code', 'NET_BUFFER_BELOW_MINIMUM', 'message', format('Net buffer $%.0f < min $%.0f', v_net_buffer, v_min_reserve), 'value', v_net_buffer, 'threshold', v_min_reserve);
    v_recommended_actions := v_recommended_actions || '"Reduce pending payout exposure"'::jsonb;
  END IF;

  IF v_pass_rate_7d > 0.15 THEN
    v_status := 'block';
    v_reasons := v_reasons || jsonb_build_object('code', 'PASS_RATE_7D_CRITICAL', 'message', format('7d pass rate %.1f%% (max 15%%)', v_pass_rate_7d * 100), 'value', v_pass_rate_7d, 'threshold', 0.15);
    v_recommended_actions := v_recommended_actions || '"Tighten evaluation criteria"'::jsonb;
  END IF;

  IF v_pass_rate_delta > 0.03 THEN
    v_status := 'block';
    v_reasons := v_reasons || jsonb_build_object('code', 'PASS_RATE_SLOPE_CRITICAL', 'message', format('Pass rate slope +%.1f%% (max +3%%)', v_pass_rate_delta * 100), 'value', v_pass_rate_delta, 'threshold', 0.03);
    v_recommended_actions := v_recommended_actions || '"Investigate sudden pass rate increase"'::jsonb;
  END IF;

  -- 8. WARN rules
  IF v_status != 'block' AND v_pass_rate_30d > 0.13 AND v_pass_rate_30d <= 0.15 THEN
    v_status := 'warn';
    v_reasons := v_reasons || jsonb_build_object('code', 'PASS_RATE_ELEVATED', 'message', format('30d pass rate %.1f%% (warn: 13%%)', v_pass_rate_30d * 100), 'value', v_pass_rate_30d, 'threshold', 0.13);
  END IF;

  IF v_status != 'block' AND v_pass_rate_delta > 0.02 AND v_pass_rate_delta <= 0.03 THEN
    v_status := 'warn';
    v_reasons := v_reasons || jsonb_build_object('code', 'PASS_RATE_SLOPE_WARNING', 'message', format('Pass rate slope +%.1f%%', v_pass_rate_delta * 100), 'value', v_pass_rate_delta, 'threshold', 0.02);
  END IF;

  IF v_status != 'block' AND v_approval_rate_delta > 0.15 THEN
    v_status := 'warn';
    v_reasons := v_reasons || jsonb_build_object('code', 'APPROVAL_RATE_SPIKE', 'message', format('Approval rate delta +%.1f%%', v_approval_rate_delta * 100), 'value', v_approval_rate_delta, 'threshold', 0.15);
  END IF;

  IF v_status != 'block' AND v_reset_rate_delta > 0.05 THEN
    v_status := 'warn';
    v_reasons := v_reasons || jsonb_build_object('code', 'RESET_RATE_SPIKE', 'message', format('Reset rate delta +%.1f%%', v_reset_rate_delta * 100), 'value', v_reset_rate_delta, 'threshold', 0.05);
  END IF;

  -- NO side effects. Pure read-only verdict.

  RETURN jsonb_build_object(
    'status', v_status,
    'reasons', v_reasons,
    'recommended_actions', v_recommended_actions,
    'metrics', jsonb_build_object(
      'pass_rate_30d', round(v_pass_rate_30d, 4),
      'pass_rate_7d', round(v_pass_rate_7d, 4),
      'pass_rate_delta', round(v_pass_rate_delta, 4),
      'total_accounts_30d', v_total_accounts_30d,
      'passed_accounts_30d', v_passed_accounts_30d,
      'total_accounts_7d', v_total_accounts_7d,
      'passed_accounts_7d', v_passed_accounts_7d,
      'simulation_run_id', v_sim_run_id,
      'simulation_age_hours', round(COALESCE(v_sim_age_hours, 0), 1),
      'simulation_stale', COALESCE(v_sim_stale, true),
      'simulation_loss_prob', round(COALESCE(v_sim_loss_prob, 0), 4),
      'reserve_breach_prob', round(COALESCE(v_reserve_breach_prob, 0), 4),
      'worst_month', v_sim_worst_month,
      'net_buffer', round(COALESCE(v_net_buffer, 0), 2),
      'min_reserve', v_min_reserve,
      'pending_payouts_count', v_pending_payouts_count,
      'pending_payouts_amount', round(v_pending_payouts_amount, 2),
      'payouts_approved_30d', v_payouts_approved_30d,
      'payouts_total_30d', v_payouts_total_30d,
      'approval_rate_30d', round(v_approval_rate_30d, 4),
      'approval_rate_7d', round(v_approval_rate_7d, 4),
      'approval_rate_delta', round(v_approval_rate_delta, 4),
      'avg_payout_amount_30d', round(v_avg_payout_amount_30d, 2),
      'resets_30d', v_resets_30d,
      'resets_7d', v_resets_7d,
      'reset_rate_30d', round(v_reset_rate_30d, 4),
      'reset_rate_7d', round(v_reset_rate_7d, 4),
      'reset_rate_delta', round(v_reset_rate_delta, 4),
      'active_accounts', v_active_accounts,
      'cohort_config_hash', v_cohort_hash
    ),
    'evaluated_at', now()
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.get_econ_guardrail_status(int) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_econ_guardrail_status(int) FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_econ_guardrail_status(int) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.get_econ_guardrail_status(int) TO service_role;

-- -----------------------------------------------------------------------
-- ITEM 1: New propose_econ_auto_tightening() — cron-only, idempotent
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
  v_inserted int := 0;
  v_total_pending int;
BEGIN
  v_status := _econ->>'status';
  v_pass_rate_7d := COALESCE((_econ->'metrics'->>'pass_rate_7d')::numeric, 0);
  v_pass_rate_30d := COALESCE((_econ->'metrics'->>'pass_rate_30d')::numeric, 0);
  v_pass_rate_delta := COALESCE((_econ->'metrics'->>'pass_rate_delta')::numeric, 0);
  v_reserve_breach_prob := COALESCE((_econ->'metrics'->>'reserve_breach_prob')::numeric, 0);

  IF v_status NOT IN ('warn', 'block') THEN
    RETURN jsonb_build_object('proposals_created', 0, 'status', v_status);
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
    ) ON CONFLICT (setting_key) WHERE status = 'pending' DO NOTHING;
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
    ) ON CONFLICT (setting_key) WHERE status = 'pending' DO NOTHING;
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
    ) ON CONFLICT (setting_key) WHERE status = 'pending' DO NOTHING;
  END IF;

  SELECT count(*) INTO v_total_pending
  FROM safety_setting_changes
  WHERE proposed_by IS NULL AND proposed_by_system = true AND status = 'pending';

  RETURN jsonb_build_object('proposals_pending', v_total_pending, 'status', v_status, 'evaluated_at', now());
END;
$$;

REVOKE EXECUTE ON FUNCTION public.propose_econ_auto_tightening(jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.propose_econ_auto_tightening(jsonb) FROM anon;
REVOKE EXECUTE ON FUNCTION public.propose_econ_auto_tightening(jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.propose_econ_auto_tightening(jsonb) TO service_role;

-- -----------------------------------------------------------------------
-- ITEM 5: Fix approve_safety_setting_change — human-only, system proposal two-key fix
-- -----------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.approve_safety_setting_change(
  _change_id uuid,
  _reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_change record;
  v_caller_id uuid;
  v_econ_status jsonb;
BEGIN
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Not authenticated');
  END IF;

  IF NOT has_role(v_caller_id, 'admin') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Admin role required');
  END IF;

  SELECT * INTO v_change FROM safety_setting_changes WHERE id = _change_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Change not found');
  END IF;

  IF v_change.status != 'pending' THEN
    RETURN jsonb_build_object('success', false, 'error', format('Change is %s, not pending', v_change.status));
  END IF;

  -- Two-key: different person must approve (system proposals skip this check)
  IF v_change.proposed_by IS NOT NULL AND v_change.proposed_by = v_caller_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'Cannot approve your own proposal (two-key rule)');
  END IF;

  -- Econ gate check (read-only)
  v_econ_status := get_econ_guardrail_status();
  IF (v_econ_status->>'status') = 'block' THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Safety setting change blocked by economic safety gate',
      'econ_gate_status', v_econ_status->>'status',
      'econ_gate_reasons', v_econ_status->'reasons',
      'hint', 'Resolve economic health issues before approving safety setting changes'
    );
  END IF;

  UPDATE safety_setting_changes
  SET status = 'approved', approved_by = v_caller_id, approved_at = now(),
      current_value_snapshot = (SELECT value FROM system_settings WHERE key = v_change.setting_key)
  WHERE id = _change_id;

  RETURN jsonb_build_object('success', true, 'change_id', _change_id, 'setting_key', v_change.setting_key, 'approved_by', v_caller_id, 'econ_gate_status', v_econ_status->>'status');
END;
$$;

REVOKE EXECUTE ON FUNCTION public.approve_safety_setting_change(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.approve_safety_setting_change(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.approve_safety_setting_change(uuid, text) TO service_role;

-- -----------------------------------------------------------------------
-- Clean up fake all-zero UUID proposals
-- -----------------------------------------------------------------------
UPDATE safety_setting_changes
SET proposed_by = NULL, proposed_by_system = true
WHERE proposed_by = '00000000-0000-0000-0000-000000000000';
