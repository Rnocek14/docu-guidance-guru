
-- ==========================================================
-- P2 Closure: Add paid_confirmed coverage to 4 reporting RPCs
-- ==========================================================
-- Affected functions:
--   1. check_liability_alert     — "opening soon" subquery
--   2. get_cohort_account_stats  — passed_no_paid_payout stat
--   3. get_econ_guardrail_status — payout volume counts
--   4. get_liability_snapshot    — opening soon + velocity 14d
-- ==========================================================

-- 1) check_liability_alert: line 64 p.status = 'paid' → IN ('paid','paid_confirmed')
CREATE OR REPLACE FUNCTION public.check_liability_alert()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _config public.liability_alerts%rowtype;
  _snapshot jsonb;
  _net_buffer numeric;
  _new_state text;
  _should_fire boolean := false;
  _staff_users uuid[];
  _staff_user uuid;
  _now timestamptz := now();
  _now_ny date;
  _pending_counts jsonb;
  _pending_amounts jsonb;
  _approved_unpaid numeric;
  _opening_soon_count bigint;
  _total_pending_amount numeric;
  _expected_opening_soon_liability numeric;
  _idempotency_key text;
  _notified_count integer := 0;
BEGIN
  SELECT * INTO _config
  FROM public.liability_alerts
  WHERE alert_type = 'negative_net_buffer'
  FOR UPDATE;
  
  IF NOT FOUND OR NOT _config.is_active THEN
    RETURN jsonb_build_object('fired', false, 'reason', 'Alert not active or not found');
  END IF;
  
  _now_ny := (now() AT TIME ZONE 'America/New_York')::date;
  
  SELECT jsonb_build_object(
    'pending', COALESCE(COUNT(*) FILTER (WHERE status = 'pending'), 0),
    'under_review', COALESCE(COUNT(*) FILTER (WHERE status = 'under_review'), 0),
    'approved', COALESCE(COUNT(*) FILTER (WHERE status = 'approved'), 0)
  )
  INTO _pending_counts
  FROM payouts
  WHERE status IN ('pending', 'under_review', 'approved');
  
  SELECT jsonb_build_object(
    'pending', COALESCE(SUM(amount) FILTER (WHERE status = 'pending'), 0),
    'under_review', COALESCE(SUM(amount) FILTER (WHERE status = 'under_review'), 0),
    'approved', COALESCE(SUM(amount) FILTER (WHERE status = 'approved'), 0)
  )
  INTO _pending_amounts
  FROM payouts
  WHERE status IN ('pending', 'under_review', 'approved');
  
  SELECT COALESCE(SUM(amount), 0) INTO _approved_unpaid
  FROM payouts WHERE status = 'approved';
  
  -- FIX: Include paid_confirmed in "opening soon" exclusion
  SELECT COUNT(*) INTO _opening_soon_count
  FROM accounts a
  JOIN cohorts c ON c.id = a.cohort_id
  WHERE a.status = 'passed'
    AND a.passed_at IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM payouts p WHERE p.account_id = a.id AND p.status IN ('paid', 'paid_confirmed'))
    AND (a.passed_at AT TIME ZONE 'America/New_York')::date + COALESCE(c.payout_eligibility_delay_days, 7) > _now_ny
    AND (a.passed_at AT TIME ZONE 'America/New_York')::date + COALESCE(c.payout_eligibility_delay_days, 7) <= _now_ny + 7;
  
  _total_pending_amount := 
    COALESCE(NULLIF(_pending_amounts->>'pending', '')::numeric, 0)
    + COALESCE(NULLIF(_pending_amounts->>'under_review', '')::numeric, 0)
    + COALESCE(NULLIF(_pending_amounts->>'approved', '')::numeric, 0);
  
  _expected_opening_soon_liability := COALESCE(_opening_soon_count, 0) * _config.assumed_avg_first_payout;
  _net_buffer := _config.cash_reserve - _total_pending_amount - _expected_opening_soon_liability;
  
  _snapshot := jsonb_build_object(
    'as_of', _now_ny,
    'pending_counts', _pending_counts,
    'pending_amounts', _pending_amounts,
    'approved_unpaid', _approved_unpaid,
    'opening_soon_count', _opening_soon_count,
    'total_pending_amount', _total_pending_amount,
    'expected_opening_soon_liability', _expected_opening_soon_liability,
    'cash_reserve', _config.cash_reserve,
    'assumed_avg_first_payout', _config.assumed_avg_first_payout,
    'net_buffer', _net_buffer
  );
  
  _new_state := CASE WHEN _net_buffer < _config.threshold THEN 'negative' ELSE 'ok' END;
  
  IF _new_state = 'negative' THEN
    IF _config.last_state = 'ok' THEN
      _should_fire := true;
    ELSIF _config.last_triggered_at IS NULL 
       OR (_now - _config.last_triggered_at) >= (_config.cooldown_minutes || ' minutes')::interval THEN
      _should_fire := true;
    END IF;
  END IF;
  
  UPDATE public.liability_alerts
  SET 
    last_state = _new_state,
    last_triggered_at = CASE WHEN _should_fire THEN _now ELSE last_triggered_at END,
    updated_at = _now
  WHERE id = _config.id;
  
  IF NOT _should_fire THEN
    RETURN jsonb_build_object(
      'fired', false,
      'reason', CASE WHEN _new_state = 'ok' THEN 'Buffer is OK' ELSE 'Cooldown not elapsed' END,
      'net_buffer', _net_buffer,
      'state', _new_state,
      'last_triggered_at', _config.last_triggered_at,
      'cooldown_minutes', _config.cooldown_minutes
    );
  END IF;
  
  _idempotency_key := 'liability_alert:' || _config.id::text || ':' || to_char((_now AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24:MI');
  
  IF _config.channels ? 'in_app' THEN
    SELECT ARRAY_AGG(DISTINCT user_id) INTO _staff_users
    FROM public.user_roles
    WHERE role IN ('risk_officer', 'support', 'admin');
    
    IF _staff_users IS NOT NULL THEN
      FOREACH _staff_user IN ARRAY _staff_users LOOP
        INSERT INTO public.staff_notifications (
          user_id, notification_type, title, body, data, idempotency_key
        )
        VALUES (
          _staff_user, 'liability_alert', 'Net Buffer Negative',
          'Cash reserve is insufficient. Shortfall: $' || ABS(_net_buffer)::text,
          jsonb_build_object('net_buffer', _net_buffer, 'threshold', _config.threshold, 'snapshot', _snapshot),
          _idempotency_key || ':' || _staff_user::text
        )
        ON CONFLICT (idempotency_key) DO NOTHING;
        
        IF FOUND THEN
          _notified_count := _notified_count + 1;
        END IF;
      END LOOP;
    END IF;
  END IF;
  
  INSERT INTO public.audit_logs (user_id, action, details, reason, idempotency_key)
  VALUES (
    NULL, 'liability_alert_fired',
    jsonb_build_object(
      'alert_type', 'negative_net_buffer', 'net_buffer', _net_buffer,
      'threshold', _config.threshold, 'channels', _config.channels,
      'recipients', _config.recipients, 'idempotency_key', _idempotency_key, 'snapshot', _snapshot
    ),
    'Liability alert triggered: net buffer below threshold',
    _idempotency_key
  )
  ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING;
  
  RETURN jsonb_build_object(
    'fired', true, 'net_buffer', _net_buffer, 'threshold', _config.threshold,
    'channels', _config.channels, 'recipients', _config.recipients,
    'state', _new_state, 'in_app_notified', _notified_count,
    'idempotency_key', _idempotency_key
  );
END;
$$;

-- 2) get_cohort_account_stats: passed_no_paid_payout
CREATE OR REPLACE FUNCTION public.get_cohort_account_stats()
RETURNS TABLE(cohort_id uuid, total_accounts bigint, passed_accounts bigint, passed_no_paid_payout bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT has_any_role(auth.uid(), ARRAY['risk_officer'::app_role, 'support'::app_role, 'admin'::app_role]) THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    a.cohort_id,
    COUNT(*) AS total_accounts,
    COUNT(*) FILTER (
      WHERE a.status IN ('passed', 'payout_requested', 'payout_under_review', 'payout_approved')
    ) AS passed_accounts,
    COUNT(*) FILTER (
      WHERE a.status IN ('passed', 'payout_requested', 'payout_under_review', 'payout_approved')
        AND NOT EXISTS (
          SELECT 1 FROM payouts p
          WHERE p.account_id = a.id AND p.status IN ('paid', 'paid_confirmed')
        )
    ) AS passed_no_paid_payout
  FROM accounts a
  GROUP BY a.cohort_id;
END;
$$;

-- 3) get_econ_guardrail_status: payout volume counts
CREATE OR REPLACE FUNCTION public.get_econ_guardrail_status(_window_days integer DEFAULT 30)
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

  -- 3. LIABILITY
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

  -- 4. PAYOUT VOLUME — FIX: include paid_confirmed
  SELECT count(*),
         count(*) FILTER (WHERE status IN ('approved','paid','paid_confirmed','payment_initiated')),
         COALESCE(avg(amount) FILTER (WHERE status IN ('approved','paid','paid_confirmed','payment_initiated')), 0)
  INTO v_payouts_total_30d, v_payouts_approved_30d, v_avg_payout_amount_30d
  FROM payouts WHERE requested_at >= now() - (_window_days || ' days')::interval;

  v_approval_rate_30d := CASE WHEN v_payouts_total_30d > 0 THEN v_payouts_approved_30d::numeric / v_payouts_total_30d ELSE 0 END;

  SELECT count(*), count(*) FILTER (WHERE status IN ('approved','paid','paid_confirmed','payment_initiated'))
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

  -- 6. COHORT HASH
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
    v_reasons := v_reasons || jsonb_build_object('code', 'SIMULATION_STALE_OR_MISSING', 'message', CASE WHEN v_sim_run_id IS NULL THEN 'No simulation linked' ELSE 'Simulation ' || round(COALESCE(v_sim_age_hours, 0))::text || 'h old (max 168)' END, 'value', v_sim_age_hours, 'threshold', 168);
    v_recommended_actions := v_recommended_actions || '"Run new Monte Carlo simulation"'::jsonb;
  END IF;

  IF v_reserve_breach_prob IS NOT NULL AND v_reserve_breach_prob > 0.02 THEN
    v_status := 'block';
    v_reasons := v_reasons || jsonb_build_object('code', 'RESERVE_BREACH_RISK', 'message', 'Reserve breach prob ' || round(v_reserve_breach_prob * 100, 1)::text || '% (max 2%)', 'value', v_reserve_breach_prob, 'threshold', 0.02);
    v_recommended_actions := v_recommended_actions || '"Increase cash reserve"'::jsonb;
  END IF;

  IF v_net_buffer < v_min_reserve THEN
    v_status := 'block';
    v_reasons := v_reasons || jsonb_build_object('code', 'NET_BUFFER_BELOW_MINIMUM', 'message', 'Net buffer $' || round(v_net_buffer)::text || ' < min $' || round(v_min_reserve)::text, 'value', v_net_buffer, 'threshold', v_min_reserve);
    v_recommended_actions := v_recommended_actions || '"Reduce pending payout exposure"'::jsonb;
  END IF;

  IF v_pass_rate_7d > 0.15 THEN
    v_status := 'block';
    v_reasons := v_reasons || jsonb_build_object('code', 'PASS_RATE_7D_CRITICAL', 'message', '7d pass rate ' || round(v_pass_rate_7d * 100, 1)::text || '% (max 15%)', 'value', v_pass_rate_7d, 'threshold', 0.15);
    v_recommended_actions := v_recommended_actions || '"Tighten evaluation criteria"'::jsonb;
  END IF;

  IF v_pass_rate_delta > 0.03 THEN
    v_status := 'block';
    v_reasons := v_reasons || jsonb_build_object('code', 'PASS_RATE_SLOPE_CRITICAL', 'message', 'Pass rate slope +' || round(v_pass_rate_delta * 100, 1)::text || '% (max +3%)', 'value', v_pass_rate_delta, 'threshold', 0.03);
    v_recommended_actions := v_recommended_actions || '"Investigate sudden pass rate increase"'::jsonb;
  END IF;

  -- 8. WARN rules
  IF v_status != 'block' AND v_pass_rate_30d > 0.13 AND v_pass_rate_30d <= 0.15 THEN
    v_status := 'warn';
    v_reasons := v_reasons || jsonb_build_object('code', 'PASS_RATE_ELEVATED', 'message', '30d pass rate ' || round(v_pass_rate_30d * 100, 1)::text || '% (warn: 13%)', 'value', v_pass_rate_30d, 'threshold', 0.13);
  END IF;

  IF v_status != 'block' AND v_pass_rate_delta > 0.02 AND v_pass_rate_delta <= 0.03 THEN
    v_status := 'warn';
    v_reasons := v_reasons || jsonb_build_object('code', 'PASS_RATE_SLOPE_WARNING', 'message', 'Pass rate slope +' || round(v_pass_rate_delta * 100, 1)::text || '%', 'value', v_pass_rate_delta, 'threshold', 0.02);
  END IF;

  IF v_status != 'block' AND v_approval_rate_delta > 0.15 THEN
    v_status := 'warn';
    v_reasons := v_reasons || jsonb_build_object('code', 'APPROVAL_RATE_SPIKE', 'message', 'Approval rate delta +' || round(v_approval_rate_delta * 100, 1)::text || '%', 'value', v_approval_rate_delta, 'threshold', 0.15);
  END IF;

  IF v_status != 'block' AND v_reset_rate_delta > 0.05 THEN
    v_status := 'warn';
    v_reasons := v_reasons || jsonb_build_object('code', 'RESET_RATE_SPIKE', 'message', 'Reset rate delta +' || round(v_reset_rate_delta * 100, 1)::text || '%', 'value', v_reset_rate_delta, 'threshold', 0.05);
  END IF;

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

-- 4) get_liability_snapshot: opening soon + velocity 14d
CREATE OR REPLACE FUNCTION public.get_liability_snapshot(
  _days_forward integer DEFAULT 7,
  _cash_reserve numeric DEFAULT 0,
  _assumed_avg_first_payout numeric DEFAULT 300
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _pending_counts jsonb;
  _pending_amounts jsonb;
  _approved_unpaid numeric;
  _opening_soon_count bigint;
  _opening_soon_by_day jsonb;
  _by_cohort jsonb;
  _velocity_14d jsonb;
  _now_ny date;
  _total_pending_amount numeric;
  _expected_opening_soon_liability numeric;
  _net_buffer numeric;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object('error', 'unauthenticated');
  END IF;
  
  IF NOT has_any_role(auth.uid(), ARRAY['risk_officer'::app_role, 'support'::app_role, 'admin'::app_role]) THEN
    RETURN jsonb_build_object('error', 'unauthorized');
  END IF;
  
  _days_forward := LEAST(GREATEST(COALESCE(_days_forward, 7), 1), 30);
  _cash_reserve := GREATEST(COALESCE(_cash_reserve, 0), 0);
  _assumed_avg_first_payout := LEAST(GREATEST(COALESCE(_assumed_avg_first_payout, 300), 0), 100000);
  
  _now_ny := (now() AT TIME ZONE 'America/New_York')::date;
  
  SELECT jsonb_build_object(
    'pending', COALESCE(COUNT(*) FILTER (WHERE status = 'pending'), 0),
    'under_review', COALESCE(COUNT(*) FILTER (WHERE status = 'under_review'), 0),
    'approved', COALESCE(COUNT(*) FILTER (WHERE status = 'approved'), 0)
  )
  INTO _pending_counts
  FROM payouts
  WHERE status IN ('pending', 'under_review', 'approved');
  
  SELECT jsonb_build_object(
    'pending', COALESCE(SUM(amount) FILTER (WHERE status = 'pending'), 0),
    'under_review', COALESCE(SUM(amount) FILTER (WHERE status = 'under_review'), 0),
    'approved', COALESCE(SUM(amount) FILTER (WHERE status = 'approved'), 0)
  )
  INTO _pending_amounts
  FROM payouts
  WHERE status IN ('pending', 'under_review', 'approved');
  
  SELECT COALESCE(SUM(amount), 0)
  INTO _approved_unpaid
  FROM payouts
  WHERE status = 'approved';
  
  -- FIX: Include paid_confirmed in "opening soon" exclusion
  SELECT COUNT(*)
  INTO _opening_soon_count
  FROM accounts a
  JOIN cohorts c ON c.id = a.cohort_id
  WHERE a.status = 'passed'
    AND a.passed_at IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM payouts p
      WHERE p.account_id = a.id AND p.status IN ('paid', 'paid_confirmed')
    )
    AND (a.passed_at AT TIME ZONE 'America/New_York')::date + COALESCE(c.payout_eligibility_delay_days, 7) > _now_ny
    AND (a.passed_at AT TIME ZONE 'America/New_York')::date + COALESCE(c.payout_eligibility_delay_days, 7) <= _now_ny + _days_forward;
  
  -- FIX: Include paid_confirmed in opening-soon-by-day exclusion
  SELECT COALESCE(jsonb_agg(row_to_json(d) ORDER BY d.opens_on), '[]'::jsonb)
  INTO _opening_soon_by_day
  FROM (
    SELECT 
      ((a.passed_at AT TIME ZONE 'America/New_York')::date + COALESCE(c.payout_eligibility_delay_days, 7))::text as opens_on,
      COUNT(*) as count
    FROM accounts a
    JOIN cohorts c ON c.id = a.cohort_id
    WHERE a.status = 'passed'
      AND a.passed_at IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM payouts p
        WHERE p.account_id = a.id AND p.status IN ('paid', 'paid_confirmed')
      )
      AND (a.passed_at AT TIME ZONE 'America/New_York')::date + COALESCE(c.payout_eligibility_delay_days, 7) > _now_ny
      AND (a.passed_at AT TIME ZONE 'America/New_York')::date + COALESCE(c.payout_eligibility_delay_days, 7) <= _now_ny + _days_forward
    GROUP BY opens_on
    ORDER BY opens_on
  ) d;
  
  WITH payout_per_account AS (
    SELECT
      account_id,
      COALESCE(SUM(amount) FILTER (WHERE status = 'approved'), 0) AS approved_unpaid,
      COALESCE(SUM(amount) FILTER (WHERE status IN ('pending', 'under_review')), 0) AS pending_amount,
      COUNT(*) FILTER (WHERE status = 'approved') AS approved_count,
      COUNT(*) FILTER (WHERE status IN ('pending', 'under_review')) AS pending_count
    FROM payouts
    WHERE status IN ('pending', 'under_review', 'approved')
    GROUP BY account_id
  ),
  payout_agg AS (
    SELECT
      a.cohort_id,
      COALESCE(SUM(p.approved_unpaid), 0) AS approved_unpaid,
      COALESCE(SUM(p.pending_amount), 0) AS pending_amount,
      COALESCE(SUM(p.approved_count), 0) AS approved_count,
      COALESCE(SUM(p.pending_count), 0) AS pending_count
    FROM accounts a
    LEFT JOIN payout_per_account p ON p.account_id = a.id
    GROUP BY a.cohort_id
  )
  SELECT COALESCE(jsonb_agg(row_to_json(cb) ORDER BY cb.approved_unpaid DESC), '[]'::jsonb)
  INTO _by_cohort
  FROM (
    SELECT 
      c.id as cohort_id,
      c.name as cohort_name,
      COALESCE(pa.approved_unpaid, 0) as approved_unpaid,
      COALESCE(pa.pending_amount, 0) as pending_amount,
      COALESCE(pa.approved_count, 0) as approved_count,
      COALESCE(pa.pending_count, 0) as pending_count
    FROM cohorts c
    LEFT JOIN payout_agg pa ON pa.cohort_id = c.id
    WHERE c.is_active = true
  ) cb;
  
  -- FIX: Include paid_confirmed in velocity stats
  SELECT jsonb_build_object(
    'requested_14d', (
      SELECT COUNT(*) FROM payouts
      WHERE requested_at >= now() - interval '14 days'
    ),
    'paid_14d', (
      SELECT COUNT(*) FROM payouts
      WHERE status IN ('paid', 'paid_confirmed') AND paid_at >= now() - interval '14 days'
    ),
    'paid_amount_14d', (
      SELECT COALESCE(SUM(amount), 0) FROM payouts
      WHERE status IN ('paid', 'paid_confirmed') AND paid_at >= now() - interval '14 days'
    )
  ) INTO _velocity_14d;
  
  _total_pending_amount := 
    COALESCE(NULLIF(_pending_amounts->>'pending', '')::numeric, 0)
    + COALESCE(NULLIF(_pending_amounts->>'under_review', '')::numeric, 0)
    + COALESCE(NULLIF(_pending_amounts->>'approved', '')::numeric, 0);
  
  _expected_opening_soon_liability := COALESCE(_opening_soon_count, 0) * _assumed_avg_first_payout;
  _net_buffer := _cash_reserve - _total_pending_amount - _expected_opening_soon_liability;
  
  RETURN jsonb_build_object(
    'as_of', _now_ny,
    'pending_counts', _pending_counts,
    'pending_amounts', _pending_amounts,
    'approved_unpaid', _approved_unpaid,
    'opening_soon_count', _opening_soon_count,
    'opening_soon_by_day', _opening_soon_by_day,
    'by_cohort', _by_cohort,
    'velocity', _velocity_14d,
    'days_forward', _days_forward,
    'total_pending_amount', _total_pending_amount,
    'expected_opening_soon_liability', _expected_opening_soon_liability,
    'cash_reserve', _cash_reserve,
    'assumed_avg_first_payout', _assumed_avg_first_payout,
    'net_buffer', _net_buffer
  );
END;
$$;
