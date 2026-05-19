
-- ─────────────────────────────────────────────────────────────
-- BREAKER v1.2: net revenue + cron + staleness alert
-- ─────────────────────────────────────────────────────────────

ALTER TABLE public.econ_breaker_state
  ADD COLUMN IF NOT EXISTS payrev_net_revenue_30d numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS payrev_chargebacks_30d numeric NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION public.evaluate_econ_breaker()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pass_rate numeric;
  v_passed integer;
  v_total integer;
  v_pending_liability numeric;
  v_cash_reserve numeric;
  v_net_buffer numeric;
  v_gross_revenue_30d numeric;
  v_chargebacks_30d numeric;
  v_net_revenue_30d numeric;
  v_payouts_30d numeric;
  v_payrev numeric;
  v_prev_payrev_level text;
  v_prev_streak integer;
  v_new_payrev_level text;
  v_new_streak integer;
  v_pass_level text;
  v_buffer_level text;
  v_level text;
  v_prev_level text;
  v_payouts_blocked boolean := false;
  v_approvals_blocked boolean := false;
  v_evaluations_frozen boolean := false;
  v_reason text;
  v_audit_idem text;
BEGIN
  SELECT breaker_level, payrev_level, payrev_release_streak
    INTO v_prev_level, v_prev_payrev_level, v_prev_streak
  FROM econ_breaker_state
  WHERE id = '00000000-0000-0000-0000-000000000001';

  v_prev_payrev_level := COALESCE(v_prev_payrev_level, 'normal');
  v_prev_streak := COALESCE(v_prev_streak, 0);

  -- Pass-rate signal (unchanged)
  SELECT
    COUNT(*) FILTER (WHERE passed_at IS NOT NULL AND passed_at >= now() - interval '30 days'),
    COUNT(*)
  INTO v_passed, v_total
  FROM accounts
  WHERE (passed_at IS NOT NULL AND passed_at >= now() - interval '30 days')
     OR (failed_at IS NOT NULL AND failed_at >= now() - interval '30 days');

  v_pass_rate := CASE WHEN v_total > 0 THEN (v_passed::numeric / v_total) * 100 ELSE 0 END;

  -- Gross revenue: fulfilled checkouts in last 30d (refunded rows already excluded
  -- because handle_charge_refunded flips status to 'refunded').
  SELECT COALESCE(SUM(amount_cents), 0) / 100.0
  INTO v_gross_revenue_30d
  FROM checkout_fulfillment_queue
  WHERE status = 'fulfilled' AND created_at >= now() - interval '30 days';

  -- Chargeback leakage: everything not explicitly won in last 30d
  SELECT COALESCE(SUM(amount), 0)
  INTO v_chargebacks_30d
  FROM chargeback_events
  WHERE occurred_at >= now() - interval '30 days'
    AND COALESCE(stage, '') <> 'won';

  v_net_revenue_30d := GREATEST(v_gross_revenue_30d - v_chargebacks_30d, 0);

  SELECT COALESCE(SUM(amount), 0)
  INTO v_payouts_30d
  FROM payouts
  WHERE status IN ('paid', 'paid_confirmed')
    AND COALESCE(updated_at, created_at) >= now() - interval '30 days';

  -- Pay/Rev now uses NET revenue
  v_payrev := CASE WHEN v_net_revenue_30d > 0 THEN v_payouts_30d / v_net_revenue_30d ELSE 0 END;

  -- Hysteresis streaks (unchanged)
  IF v_prev_payrev_level = 'critical' THEN
    v_new_streak := CASE WHEN v_payrev < 0.40 THEN v_prev_streak + 1 ELSE 0 END;
  ELSIF v_prev_payrev_level = 'elevated' THEN
    v_new_streak := CASE WHEN v_payrev < 0.25 THEN v_prev_streak + 1 ELSE 0 END;
  ELSE
    v_new_streak := 0;
  END IF;

  IF v_payrev > 0.45 THEN
    v_new_payrev_level := 'critical'; v_new_streak := 0;
  ELSIF v_payrev > 0.30 AND v_prev_payrev_level <> 'critical' THEN
    v_new_payrev_level := 'elevated'; v_new_streak := 0;
  ELSIF v_prev_payrev_level = 'critical' AND v_new_streak >= 12 THEN
    v_new_payrev_level := 'elevated'; v_new_streak := 0;
  ELSIF v_prev_payrev_level = 'elevated' AND v_new_streak >= 36 THEN
    v_new_payrev_level := 'normal'; v_new_streak := 0;
  ELSE
    v_new_payrev_level := v_prev_payrev_level;
  END IF;

  IF v_pass_rate >= 20 THEN v_pass_level := 'emergency';
  ELSIF v_pass_rate >= 18 THEN v_pass_level := 'critical';
  ELSIF v_pass_rate >= 15 THEN v_pass_level := 'elevated';
  ELSE v_pass_level := 'normal';
  END IF;

  SELECT COALESCE(SUM(amount), 0) INTO v_pending_liability
  FROM payouts WHERE status IN ('pending', 'under_review', 'approved', 'payment_initiated');

  SELECT COALESCE(MAX(cash_reserve), 0) INTO v_cash_reserve FROM liability_buffer_settings;

  v_net_buffer := v_cash_reserve - v_pending_liability;
  v_buffer_level := CASE WHEN v_net_buffer < 0 THEN 'elevated' ELSE 'normal' END;

  v_level := (
    SELECT lvl FROM (VALUES (v_pass_level), (v_new_payrev_level), (v_buffer_level)) t(lvl)
    ORDER BY CASE lvl
      WHEN 'emergency' THEN 4
      WHEN 'critical'  THEN 3
      WHEN 'elevated'  THEN 2
      ELSE 1
    END DESC
    LIMIT 1
  );

  IF v_level = 'emergency' THEN
    v_payouts_blocked := true; v_approvals_blocked := true; v_evaluations_frozen := true;
  ELSIF v_level = 'critical' THEN
    v_payouts_blocked := true; v_approvals_blocked := true;
  ELSIF v_level = 'elevated' THEN
    v_payouts_blocked := true;
  END IF;

  v_reason := format(
    'pass=%s%% [%s] | payrev=%s%% (net rev $%s, cb $%s) [%s, streak=%s] | buffer=$%s [%s]',
    round(v_pass_rate, 2), v_pass_level,
    round(v_payrev * 100, 2), round(v_net_revenue_30d, 0), round(v_chargebacks_30d, 0),
    v_new_payrev_level, v_new_streak,
    round(v_net_buffer, 0), v_buffer_level
  );

  UPDATE econ_breaker_state SET
    breaker_level = v_level,
    payouts_blocked = v_payouts_blocked,
    approvals_blocked = v_approvals_blocked,
    evaluations_frozen = v_evaluations_frozen,
    rolling_pass_rate = v_pass_rate,
    rolling_pass_count = v_passed,
    rolling_total_count = v_total,
    net_buffer = v_net_buffer,
    pending_liability = v_pending_liability,
    rolling_payrev_ratio = v_payrev,
    payrev_revenue_30d = v_gross_revenue_30d,
    payrev_net_revenue_30d = v_net_revenue_30d,
    payrev_chargebacks_30d = v_chargebacks_30d,
    payrev_payouts_30d = v_payouts_30d,
    payrev_level = v_new_payrev_level,
    payrev_release_streak = v_new_streak,
    previous_level = v_prev_level,
    last_evaluated_at = now(),
    updated_at = now(),
    last_transition_at = CASE
      WHEN v_level IS DISTINCT FROM COALESCE(v_prev_level, 'normal') THEN now()
      ELSE last_transition_at END,
    last_transition_reason = CASE
      WHEN v_level IS DISTINCT FROM COALESCE(v_prev_level, 'normal') THEN v_reason
      ELSE last_transition_reason END
  WHERE id = '00000000-0000-0000-0000-000000000001';

  IF v_level IS DISTINCT FROM COALESCE(v_prev_level, 'normal') THEN
    v_audit_idem := format('breaker_trans_%s_%s_%s',
      COALESCE(v_prev_level, 'normal'), v_level,
      extract(epoch from now())::bigint
    );

    BEGIN
      INSERT INTO audit_logs (action, idempotency_key, details, reason)
      VALUES (
        'breaker_transition'::audit_action,
        v_audit_idem,
        jsonb_build_object(
          'from_level', COALESCE(v_prev_level, 'normal'),
          'to_level', v_level,
          'pass_rate_pct', round(v_pass_rate, 2),
          'pass_level', v_pass_level,
          'payrev_ratio', round(v_payrev, 4),
          'payrev_level', v_new_payrev_level,
          'payrev_release_streak', v_new_streak,
          'payouts_30d', round(v_payouts_30d, 2),
          'gross_revenue_30d', round(v_gross_revenue_30d, 2),
          'net_revenue_30d', round(v_net_revenue_30d, 2),
          'chargebacks_30d', round(v_chargebacks_30d, 2),
          'net_buffer', round(v_net_buffer, 2),
          'pending_liability', round(v_pending_liability, 2),
          'window_days', 30,
          'thresholds', jsonb_build_object(
            'payrev_l1', 0.30, 'payrev_l2', 0.45,
            'payrev_l2_release', 0.40, 'payrev_l1_release', 0.25,
            'pass_elevated', 15, 'pass_critical', 18, 'pass_emergency', 20
          )
        ),
        v_reason
      );
    EXCEPTION WHEN unique_violation THEN NULL;
    END;

    INSERT INTO staff_notifications (notification_type, title, body, data, idempotency_key)
    VALUES (
      'breaker_level_change',
      CASE v_level
        WHEN 'emergency' THEN '🚨 EMERGENCY: Circuit Breaker Triggered'
        WHEN 'critical'  THEN '🔴 CRITICAL: Circuit Breaker Escalated'
        WHEN 'elevated'  THEN '⚠️ ELEVATED: Circuit Breaker Engaged'
        ELSE '✅ NORMAL: Circuit Breaker Released'
      END,
      format('%s → %s. %s', COALESCE(v_prev_level, 'normal'), v_level, v_reason),
      jsonb_build_object(
        'breaker_level', v_level,
        'previous_level', v_prev_level,
        'pass_rate', round(v_pass_rate, 2),
        'payrev_ratio', round(v_payrev, 4),
        'payrev_level', v_new_payrev_level,
        'net_revenue_30d', round(v_net_revenue_30d, 0),
        'chargebacks_30d', round(v_chargebacks_30d, 0),
        'net_buffer', round(COALESCE(v_net_buffer, 0), 0)
      ),
      format('breaker_change_%s_%s_%s', COALESCE(v_prev_level, 'normal'), v_level, date_trunc('hour', now()))
    )
    ON CONFLICT (idempotency_key) DO NOTHING;
  END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.evaluate_econ_breaker() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.evaluate_econ_breaker() TO service_role;

-- ── Staleness watchdog ────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.check_breaker_staleness()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_last_eval timestamptz;
  v_age_minutes numeric;
BEGIN
  SELECT last_evaluated_at INTO v_last_eval
  FROM econ_breaker_state
  WHERE id = '00000000-0000-0000-0000-000000000001';

  v_age_minutes := EXTRACT(EPOCH FROM (now() - v_last_eval)) / 60.0;

  IF v_age_minutes > 15 THEN
    INSERT INTO staff_notifications (notification_type, title, body, data, idempotency_key)
    VALUES (
      'breaker_evaluator_stalled',
      '⚠️ Breaker evaluator stalled',
      format('evaluate_econ_breaker has not run for %s minutes (last: %s). Pay/Rev guard is unprotected.',
             round(v_age_minutes, 1), v_last_eval),
      jsonb_build_object(
        'last_evaluated_at', v_last_eval,
        'age_minutes', round(v_age_minutes, 1)
      ),
      format('breaker_stale_%s', date_trunc('hour', now()))
    )
    ON CONFLICT (idempotency_key) DO NOTHING;
  END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.check_breaker_staleness() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.check_breaker_staleness() TO service_role;

-- ── Update get_econ_breaker_state return shape ───────────────
DROP FUNCTION IF EXISTS public.get_econ_breaker_state();

CREATE FUNCTION public.get_econ_breaker_state()
RETURNS TABLE (
  breaker_level text,
  payouts_blocked boolean,
  approvals_blocked boolean,
  evaluations_frozen boolean,
  rolling_pass_rate numeric,
  rolling_pass_count integer,
  rolling_total_count integer,
  net_buffer numeric,
  pending_liability numeric,
  last_evaluated_at timestamptz,
  triggered_by text,
  previous_level text,
  rolling_payrev_ratio numeric,
  payrev_revenue_30d numeric,
  payrev_net_revenue_30d numeric,
  payrev_chargebacks_30d numeric,
  payrev_payouts_30d numeric,
  payrev_window_days integer,
  payrev_level text,
  payrev_release_streak integer,
  last_transition_at timestamptz,
  last_transition_reason text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    breaker_level, payouts_blocked, approvals_blocked, evaluations_frozen,
    rolling_pass_rate, rolling_pass_count, rolling_total_count,
    net_buffer, pending_liability, last_evaluated_at, triggered_by, previous_level,
    rolling_payrev_ratio, payrev_revenue_30d, payrev_net_revenue_30d, payrev_chargebacks_30d,
    payrev_payouts_30d, payrev_window_days, payrev_level, payrev_release_streak,
    last_transition_at, last_transition_reason
  FROM econ_breaker_state
  WHERE id = '00000000-0000-0000-0000-000000000001';
$$;

REVOKE EXECUTE ON FUNCTION public.get_econ_breaker_state() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_econ_breaker_state() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_econ_breaker_state() TO service_role;

-- ── Cron schedules (SQL-based, no HTTP/secrets needed) ───────
DO $$
BEGIN
  PERFORM cron.unschedule('breaker_evaluator');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$
BEGIN
  PERFORM cron.unschedule('breaker_staleness_check');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

SELECT cron.schedule(
  'breaker_evaluator',
  '*/5 * * * *',
  $cron$SELECT public.evaluate_econ_breaker();$cron$
);

SELECT cron.schedule(
  'breaker_staleness_check',
  '*/5 * * * *',
  $cron$SELECT public.check_breaker_staleness();$cron$
);
