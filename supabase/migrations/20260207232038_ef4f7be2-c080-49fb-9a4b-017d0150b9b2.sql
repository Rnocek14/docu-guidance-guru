
-- =============================================================================
-- Economic Safety Gate: get_econ_guardrail_status()
-- =============================================================================
-- Aggregates all economic health signals into a single fail-closed verdict.
-- Returns status: 'ok' | 'warn' | 'block' with reasons, metrics, and recommendations.
-- SECURITY DEFINER — service_role only (called from edge functions).
-- =============================================================================

CREATE OR REPLACE FUNCTION public.get_econ_guardrail_status(
  _window_days int DEFAULT 30
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  -- Pass rate signals
  v_pass_rate_30d numeric;
  v_pass_rate_7d numeric;
  v_pass_rate_delta numeric;
  v_total_accounts_30d int;
  v_passed_accounts_30d int;
  v_total_accounts_7d int;
  v_passed_accounts_7d int;

  -- Simulation signals
  v_sim_run_id uuid;
  v_sim_created_at timestamptz;
  v_sim_age_hours numeric;
  v_sim_stale boolean;
  v_sim_loss_prob numeric;
  v_reserve_breach_prob numeric;
  v_sim_worst_month numeric;

  -- Reserve/liability
  v_net_buffer numeric;
  v_min_reserve numeric;
  v_reserve_config jsonb;

  -- Payout volume signals
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

  -- Reset signals
  v_resets_30d int;
  v_resets_7d int;
  v_active_accounts int;
  v_reset_rate_30d numeric;
  v_reset_rate_7d numeric;
  v_reset_rate_delta numeric;

  -- Cohort config hash
  v_cohort_hash text;

  -- Verdict
  v_status text := 'ok';
  v_reasons jsonb := '[]'::jsonb;
  v_recommended_actions jsonb := '[]'::jsonb;
BEGIN
  -- =========================================================================
  -- 1. PASS RATE (30d and 7d windows)
  -- =========================================================================
  SELECT count(*), count(*) FILTER (WHERE status IN ('passed','payout_requested','payout_under_review','payout_approved','closed'))
  INTO v_total_accounts_30d, v_passed_accounts_30d
  FROM accounts
  WHERE created_at >= now() - (_window_days || ' days')::interval;

  v_pass_rate_30d := CASE WHEN v_total_accounts_30d > 0
    THEN v_passed_accounts_30d::numeric / v_total_accounts_30d
    ELSE 0 END;

  SELECT count(*), count(*) FILTER (WHERE status IN ('passed','payout_requested','payout_under_review','payout_approved','closed'))
  INTO v_total_accounts_7d, v_passed_accounts_7d
  FROM accounts
  WHERE created_at >= now() - interval '7 days';

  v_pass_rate_7d := CASE WHEN v_total_accounts_7d > 0
    THEN v_passed_accounts_7d::numeric / v_total_accounts_7d
    ELSE 0 END;

  v_pass_rate_delta := v_pass_rate_7d - v_pass_rate_30d;

  -- =========================================================================
  -- 2. SIMULATION FRESHNESS + RISK METRICS
  -- =========================================================================
  SELECT (value->>'last_simulation_run_id')::uuid,
         value
  INTO v_sim_run_id, v_reserve_config
  FROM system_settings
  WHERE key = 'reserve_aware_approval';

  v_sim_stale := true;
  v_min_reserve := COALESCE((v_reserve_config->>'min_reserve_after_approval')::numeric, 5000);

  IF v_sim_run_id IS NOT NULL THEN
    SELECT id, created_at, probability_of_loss, reserve_breach_probability, worst_month
    INTO v_sim_run_id, v_sim_created_at, v_sim_loss_prob, v_reserve_breach_prob, v_sim_worst_month
    FROM simulation_runs
    WHERE id = v_sim_run_id;

    IF v_sim_created_at IS NOT NULL THEN
      v_sim_age_hours := EXTRACT(EPOCH FROM (now() - v_sim_created_at)) / 3600.0;
      v_sim_stale := v_sim_age_hours > 168; -- 7 days
    END IF;
  END IF;

  -- =========================================================================
  -- 3. LIABILITY / NET BUFFER
  -- =========================================================================
  -- Inline liability calc (avoids RPC-in-RPC)
  SELECT sum(amount) FILTER (WHERE status IN ('pending','under_review','approved','payment_initiated')),
         count(*) FILTER (WHERE status IN ('pending','under_review','approved','payment_initiated'))
  INTO v_pending_payouts_amount, v_pending_payouts_count
  FROM payouts;

  v_pending_payouts_amount := COALESCE(v_pending_payouts_amount, 0);
  v_pending_payouts_count := COALESCE(v_pending_payouts_count, 0);

  -- Get cash reserve from liability_buffer_settings (use max across staff entries)
  -- or fall back to liability_alerts cash_reserve
  DECLARE
    v_cash_reserve numeric;
  BEGIN
    SELECT COALESCE(max(cash_reserve), 0) INTO v_cash_reserve
    FROM liability_buffer_settings;

    IF v_cash_reserve = 0 THEN
      SELECT COALESCE(max(cash_reserve), 0) INTO v_cash_reserve
      FROM liability_alerts WHERE is_active = true;
    END IF;

    v_net_buffer := v_cash_reserve - v_pending_payouts_amount;
  END;

  -- =========================================================================
  -- 4. PAYOUT VOLUME / APPROVAL RATE (30d and 7d)
  -- =========================================================================
  SELECT count(*),
         count(*) FILTER (WHERE status IN ('approved','paid','payment_initiated')),
         COALESCE(avg(amount) FILTER (WHERE status IN ('approved','paid','payment_initiated')), 0)
  INTO v_payouts_total_30d, v_payouts_approved_30d, v_avg_payout_amount_30d
  FROM payouts
  WHERE requested_at >= now() - (_window_days || ' days')::interval;

  v_approval_rate_30d := CASE WHEN v_payouts_total_30d > 0
    THEN v_payouts_approved_30d::numeric / v_payouts_total_30d
    ELSE 0 END;

  SELECT count(*),
         count(*) FILTER (WHERE status IN ('approved','paid','payment_initiated'))
  INTO v_payouts_total_7d, v_payouts_approved_7d
  FROM payouts
  WHERE requested_at >= now() - interval '7 days';

  v_approval_rate_7d := CASE WHEN v_payouts_total_7d > 0
    THEN v_payouts_approved_7d::numeric / v_payouts_total_7d
    ELSE 0 END;

  v_approval_rate_delta := v_approval_rate_7d - v_approval_rate_30d;

  -- =========================================================================
  -- 5. RESET RATE (proxy: accounts that failed and have a child account)
  -- =========================================================================
  SELECT count(*) INTO v_active_accounts
  FROM accounts WHERE status = 'active';

  SELECT count(*) INTO v_resets_30d
  FROM accounts
  WHERE status = 'active'
    AND parent_account_id IS NOT NULL
    AND created_at >= now() - (_window_days || ' days')::interval;

  SELECT count(*) INTO v_resets_7d
  FROM accounts
  WHERE status = 'active'
    AND parent_account_id IS NOT NULL
    AND created_at >= now() - interval '7 days';

  v_reset_rate_30d := CASE WHEN v_active_accounts > 0
    THEN v_resets_30d::numeric / v_active_accounts
    ELSE 0 END;

  v_reset_rate_7d := CASE WHEN v_active_accounts > 0
    THEN v_resets_7d::numeric / v_active_accounts
    ELSE 0 END;

  v_reset_rate_delta := v_reset_rate_7d - v_reset_rate_30d;

  -- =========================================================================
  -- 6. COHORT CONFIG HASH (detect drift)
  -- =========================================================================
  SELECT md5(string_agg(
    id::text || payout_split_percent::text || COALESCE(lifetime_cap_multiple::text,'') ||
    COALESCE(first_payout_cap_amount::text,'') || max_payout_percent::text || payout_cooldown_days::text,
    '|' ORDER BY name
  ))
  INTO v_cohort_hash
  FROM cohorts
  WHERE is_active = true;

  -- =========================================================================
  -- 7. VERDICT ENGINE — BLOCK rules (fail-closed)
  -- =========================================================================

  -- BLOCK: simulation stale or missing
  IF v_sim_run_id IS NULL OR v_sim_stale THEN
    v_status := 'block';
    v_reasons := v_reasons || jsonb_build_object(
      'code', 'SIMULATION_STALE_OR_MISSING',
      'message', CASE WHEN v_sim_run_id IS NULL THEN 'No simulation linked to reserve gate'
        ELSE format('Simulation is %.0f hours old (max 168)', v_sim_age_hours) END,
      'value', v_sim_age_hours,
      'threshold', 168
    );
    v_recommended_actions := v_recommended_actions || '"Run a new Monte Carlo simulation immediately"'::jsonb;
  END IF;

  -- BLOCK: reserve breach probability > 2%
  IF v_reserve_breach_prob IS NOT NULL AND v_reserve_breach_prob > 0.02 THEN
    v_status := 'block';
    v_reasons := v_reasons || jsonb_build_object(
      'code', 'RESERVE_BREACH_RISK',
      'message', format('Reserve breach probability is %.1f%% (max 2%%)', v_reserve_breach_prob * 100),
      'value', v_reserve_breach_prob,
      'threshold', 0.02
    );
    v_recommended_actions := v_recommended_actions || '"Review simulation assumptions and increase cash reserve"'::jsonb;
  END IF;

  -- BLOCK: net buffer below minimum reserve
  IF v_net_buffer < v_min_reserve THEN
    v_status := 'block';
    v_reasons := v_reasons || jsonb_build_object(
      'code', 'NET_BUFFER_BELOW_MINIMUM',
      'message', format('Net buffer $%.0f is below minimum $%.0f', v_net_buffer, v_min_reserve),
      'value', v_net_buffer,
      'threshold', v_min_reserve
    );
    v_recommended_actions := v_recommended_actions || '"Increase cash reserve or reduce pending payout exposure"'::jsonb;
  END IF;

  -- BLOCK: 7d pass rate > 15% OR delta > 3%
  IF v_pass_rate_7d > 0.15 THEN
    v_status := 'block';
    v_reasons := v_reasons || jsonb_build_object(
      'code', 'PASS_RATE_7D_CRITICAL',
      'message', format('7-day pass rate is %.1f%% (max 15%%)', v_pass_rate_7d * 100),
      'value', v_pass_rate_7d,
      'threshold', 0.15
    );
    v_recommended_actions := v_recommended_actions || '"Tighten evaluation criteria or pause intake for affected cohorts"'::jsonb;
  END IF;

  IF v_pass_rate_delta > 0.03 THEN
    v_status := 'block';
    v_reasons := v_reasons || jsonb_build_object(
      'code', 'PASS_RATE_SLOPE_CRITICAL',
      'message', format('Pass rate slope (7d - 30d) is +%.1f%% (max +3%%)', v_pass_rate_delta * 100),
      'value', v_pass_rate_delta,
      'threshold', 0.03
    );
    v_recommended_actions := v_recommended_actions || '"Investigate sudden pass rate increase — possible rule softness or adversarial exploit"'::jsonb;
  END IF;

  -- =========================================================================
  -- 8. VERDICT ENGINE — WARN rules (only if not already BLOCK)
  -- =========================================================================

  -- WARN: pass rate 13-15%
  IF v_status != 'block' AND v_pass_rate_30d > 0.13 AND v_pass_rate_30d <= 0.15 THEN
    v_status := 'warn';
    v_reasons := v_reasons || jsonb_build_object(
      'code', 'PASS_RATE_ELEVATED',
      'message', format('30-day pass rate is %.1f%% (warning threshold: 13%%)', v_pass_rate_30d * 100),
      'value', v_pass_rate_30d,
      'threshold', 0.13
    );
  END IF;

  -- WARN: pass rate slope > 2%
  IF v_status != 'block' AND v_pass_rate_delta > 0.02 AND v_pass_rate_delta <= 0.03 THEN
    v_status := 'warn';
    v_reasons := v_reasons || jsonb_build_object(
      'code', 'PASS_RATE_SLOPE_WARNING',
      'message', format('Pass rate slope (7d - 30d) is +%.1f%%', v_pass_rate_delta * 100),
      'value', v_pass_rate_delta,
      'threshold', 0.02
    );
  END IF;

  -- WARN: approval rate spike (7d > 30d + 15pp)
  IF v_status != 'block' AND v_approval_rate_delta > 0.15 THEN
    v_status := 'warn';
    v_reasons := v_reasons || jsonb_build_object(
      'code', 'APPROVAL_RATE_SPIKE',
      'message', format('Payout approval rate 7d vs 30d delta is +%.1f%%', v_approval_rate_delta * 100),
      'value', v_approval_rate_delta,
      'threshold', 0.15
    );
  END IF;

  -- WARN: reset rate spike (7d rate significantly above 30d)
  IF v_status != 'block' AND v_reset_rate_delta > 0.05 THEN
    v_status := 'warn';
    v_reasons := v_reasons || jsonb_build_object(
      'code', 'RESET_RATE_SPIKE',
      'message', format('Reset rate 7d vs 30d delta is +%.1f%%', v_reset_rate_delta * 100),
      'value', v_reset_rate_delta,
      'threshold', 0.05
    );
  END IF;

  -- =========================================================================
  -- 9. AUTO-TIGHTENING PROPOSALS (Step 3)
  -- When status is warn or block, insert pending proposals into safety_setting_changes
  -- Only if no pending proposal already exists for that key.
  -- =========================================================================
  IF v_status IN ('warn', 'block') THEN
    -- Propose: increase payout cooldown
    IF v_pass_rate_7d > 0.13 OR v_pass_rate_delta > 0.02 THEN
      INSERT INTO safety_setting_changes (
        setting_key, proposed_by, proposed_value, reason, status
      )
      SELECT
        'payout_cooldown_increase',
        '00000000-0000-0000-0000-000000000000', -- SYSTEM actor
        jsonb_build_object(
          'suggested_cooldown_days', 45,
          'current_trigger', 'pass_rate_elevated',
          'pass_rate_7d', round(v_pass_rate_7d * 100, 1),
          'pass_rate_30d', round(v_pass_rate_30d * 100, 1)
        ),
        format('Auto-proposed: pass rate trend (7d=%.1f%%, 30d=%.1f%%, delta=+%.1f%%)',
          v_pass_rate_7d * 100, v_pass_rate_30d * 100, v_pass_rate_delta * 100),
        'pending'
      WHERE NOT EXISTS (
        SELECT 1 FROM safety_setting_changes
        WHERE setting_key = 'payout_cooldown_increase'
          AND status = 'pending'
      );
    END IF;

    -- Propose: reduce payout split temporarily
    IF v_pass_rate_7d > 0.15 OR v_reserve_breach_prob > 0.02 THEN
      INSERT INTO safety_setting_changes (
        setting_key, proposed_by, proposed_value, reason, status
      )
      SELECT
        'payout_split_reduction',
        '00000000-0000-0000-0000-000000000000',
        jsonb_build_object(
          'suggested_split_percent', 70,
          'current_trigger', CASE
            WHEN v_pass_rate_7d > 0.15 THEN 'pass_rate_critical'
            ELSE 'reserve_breach_risk' END,
          'reserve_breach_prob', round(COALESCE(v_reserve_breach_prob, 0) * 100, 1)
        ),
        format('Auto-proposed: reduce payout split due to %s',
          CASE WHEN v_pass_rate_7d > 0.15 THEN 'critical pass rate' ELSE 'reserve breach risk' END),
        'pending'
      WHERE NOT EXISTS (
        SELECT 1 FROM safety_setting_changes
        WHERE setting_key = 'payout_split_reduction'
          AND status = 'pending'
      );
    END IF;

    -- Propose: require manual review for all approvals
    IF v_status = 'block' THEN
      INSERT INTO safety_setting_changes (
        setting_key, proposed_by, proposed_value, reason, status
      )
      SELECT
        'mandatory_manual_review',
        '00000000-0000-0000-0000-000000000000',
        jsonb_build_object(
          'require_manual_review', true,
          'block_reasons', v_reasons
        ),
        'Auto-proposed: econ gate is BLOCK — all payout approvals require manual review',
        'pending'
      WHERE NOT EXISTS (
        SELECT 1 FROM safety_setting_changes
        WHERE setting_key = 'mandatory_manual_review'
          AND status = 'pending'
      );
    END IF;
  END IF;

  -- =========================================================================
  -- 10. RETURN VERDICT
  -- =========================================================================
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

-- Restrict to service_role only (called from edge functions, never client-side)
REVOKE EXECUTE ON FUNCTION public.get_econ_guardrail_status(int) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_econ_guardrail_status(int) FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_econ_guardrail_status(int) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.get_econ_guardrail_status(int) TO service_role;

-- =============================================================================
-- Modify approve_safety_setting_change to check econ gate
-- =============================================================================
-- We wrap the existing logic: if econ gate is BLOCK, refuse approval.

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

  -- Check admin role
  IF NOT has_role(v_caller_id, 'admin') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Admin role required');
  END IF;

  -- Fetch the change
  SELECT * INTO v_change
  FROM safety_setting_changes
  WHERE id = _change_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Change not found');
  END IF;

  IF v_change.status != 'pending' THEN
    RETURN jsonb_build_object('success', false, 'error', format('Change is %s, not pending', v_change.status));
  END IF;

  -- Two-key: different person must approve
  IF v_change.proposed_by = v_caller_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'Cannot approve your own proposal (two-key rule)');
  END IF;

  -- *** ECONOMIC SAFETY GATE CHECK ***
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

  -- Snapshot current value
  UPDATE safety_setting_changes
  SET status = 'approved',
      approved_by = v_caller_id,
      approved_at = now(),
      current_value_snapshot = (
        SELECT value FROM system_settings WHERE key = v_change.setting_key
      )
  WHERE id = _change_id;

  RETURN jsonb_build_object(
    'success', true,
    'change_id', _change_id,
    'setting_key', v_change.setting_key,
    'approved_by', v_caller_id,
    'econ_gate_status', v_econ_status->>'status'
  );
END;
$$;

-- Maintain existing permissions
REVOKE EXECUTE ON FUNCTION public.approve_safety_setting_change(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.approve_safety_setting_change(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.approve_safety_setting_change(uuid, text) TO authenticated;
