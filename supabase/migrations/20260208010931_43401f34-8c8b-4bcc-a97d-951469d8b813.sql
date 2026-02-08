
-- ============================================================
-- P0 BREAKER CORRECTNESS HARDENING
-- 1. Singleton guarantee (ON CONFLICT DO NOTHING)
-- 2. FOR UPDATE serialization in evaluate_econ_breaker
-- 3. Correct pass-rate with explicit FILTER clause
-- 4. Unified payout enforcement trigger (approval + payment)
-- ============================================================

-- ========================================
-- 1. Guarantee singleton row exists
-- ========================================
INSERT INTO public.econ_breaker_state (
  id, breaker_level, payouts_blocked, approvals_blocked, evaluations_frozen,
  rolling_pass_rate, rolling_pass_count, rolling_total_count,
  net_buffer, pending_liability, previous_level, triggered_by,
  last_evaluated_at, updated_at
) VALUES (
  '00000000-0000-0000-0000-000000000001',
  'normal', false, false, false,
  0, 0, 0,
  0, 0, null, 'bootstrap',
  now(), now()
)
ON CONFLICT (id) DO NOTHING;


-- ========================================
-- 2. Rewrite evaluate_econ_breaker with:
--    - FOR UPDATE lock (serialization)
--    - RAISE on missing row (fail-closed)
--    - Explicit FILTER for pass count
-- ========================================
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
  v_level text;
  v_prev_level text;
  v_payouts_blocked boolean := false;
  v_approvals_blocked boolean := false;
  v_evaluations_frozen boolean := false;
  v_pending_liability numeric;
  v_cash_reserve numeric;
  v_net_buffer numeric;
BEGIN
  -- Lock singleton row to serialize concurrent trigger calls.
  -- Prevents race flapping, duplicate alerts, incorrect previous_level.
  SELECT breaker_level
  INTO v_prev_level
  FROM econ_breaker_state
  WHERE id = '00000000-0000-0000-0000-000000000001'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'BREAKER_STATE_MISSING: fail-closed. Singleton row not found.';
  END IF;

  -- Rolling 30-day pass rate on RESOLVED outcomes only.
  -- Denominator: accounts that resolved (passed OR failed) in last 30 days.
  -- Numerator: subset that passed.
  -- Uses explicit FILTER to prevent any ambiguity.
  SELECT
    COUNT(*) FILTER (
      WHERE passed_at IS NOT NULL AND passed_at >= now() - interval '30 days'
    ),
    COUNT(*)
  INTO v_passed, v_total
  FROM accounts
  WHERE
    (passed_at IS NOT NULL AND passed_at >= now() - interval '30 days')
    OR
    (failed_at IS NOT NULL AND failed_at >= now() - interval '30 days');

  IF v_total > 0 THEN
    v_pass_rate := (v_passed::numeric / v_total::numeric) * 100;
  ELSE
    v_pass_rate := 0;
  END IF;

  -- Pending payout liability: full lifecycle set.
  -- All non-terminal statuses that represent financial exposure.
  SELECT COALESCE(SUM(amount), 0)
  INTO v_pending_liability
  FROM payouts
  WHERE status IN ('pending', 'under_review', 'approved', 'payment_initiated');

  -- Cash reserve (best available from liability_buffer_settings)
  SELECT COALESCE(MAX(cash_reserve), 0)
  INTO v_cash_reserve
  FROM liability_buffer_settings;

  v_net_buffer := v_cash_reserve - v_pending_liability;

  -- CIRCUIT BREAKER THRESHOLDS
  IF v_pass_rate >= 20 THEN
    v_level := 'emergency';
    v_payouts_blocked := true;
    v_approvals_blocked := true;
    v_evaluations_frozen := true;
  ELSIF v_pass_rate >= 18 THEN
    v_level := 'critical';
    v_payouts_blocked := true;
    v_approvals_blocked := true;
    v_evaluations_frozen := false;
  ELSIF v_pass_rate >= 15 THEN
    v_level := 'elevated';
    v_payouts_blocked := true;
    v_approvals_blocked := false;
    v_evaluations_frozen := false;
  ELSE
    v_level := 'normal';
  END IF;

  -- Escalate if net buffer is negative
  IF v_net_buffer < 0 THEN
    v_payouts_blocked := true;
    IF v_level = 'normal' THEN
      v_level := 'elevated';
    END IF;
  END IF;

  -- Update singleton (already locked via FOR UPDATE)
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
    previous_level = v_prev_level,
    last_evaluated_at = now(),
    updated_at = now()
  WHERE id = '00000000-0000-0000-0000-000000000001';

  -- Notify staff on level CHANGE only
  IF v_level != COALESCE(v_prev_level, 'normal') THEN
    INSERT INTO staff_notifications (
      notification_type,
      title,
      body,
      data,
      idempotency_key
    ) VALUES (
      'breaker_level_change',
      CASE v_level
        WHEN 'emergency' THEN '🚨 EMERGENCY: Circuit Breaker Triggered'
        WHEN 'critical'  THEN '🔴 CRITICAL: Circuit Breaker Escalated'
        WHEN 'elevated'  THEN '⚠️ ELEVATED: Pass Rate Warning'
        ELSE '✅ NORMAL: Circuit Breaker Reset'
      END,
      format('Breaker level changed: %s → %s. Pass rate: %s%% (%s/%s). Net buffer: $%s. Pending liability: $%s',
        COALESCE(v_prev_level, 'normal'), v_level,
        round(v_pass_rate, 2), v_passed, v_total,
        round(COALESCE(v_net_buffer, 0), 0),
        round(v_pending_liability, 0)
      ),
      jsonb_build_object(
        'breaker_level', v_level,
        'previous_level', v_prev_level,
        'pass_rate', round(v_pass_rate, 2),
        'net_buffer', round(COALESCE(v_net_buffer, 0), 0),
        'pending_liability', round(v_pending_liability, 0)
      ),
      format('breaker_change_%s_%s_%s', v_prev_level, v_level, date_trunc('hour', now()))
    )
    ON CONFLICT (idempotency_key) DO NOTHING;
  END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.evaluate_econ_breaker() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.evaluate_econ_breaker() TO service_role;


-- ========================================
-- 3. Unified payout enforcement trigger
--    Replaces any previous approval-only or split triggers.
--    Single trigger, single function, covers both paths.
-- ========================================
DROP TRIGGER IF EXISTS trg_breaker_block_payout ON public.payouts;
DROP TRIGGER IF EXISTS trg_breaker_block_payout_approval ON public.payouts;
DROP TRIGGER IF EXISTS trg_breaker_block_payout_payment ON public.payouts;
DROP TRIGGER IF EXISTS trg_breaker_enforce_payout_status ON public.payouts;

-- Drop old function names to avoid orphans
DROP FUNCTION IF EXISTS public.trg_enforce_breaker_on_payout_payment();
DROP FUNCTION IF EXISTS public.trg_enforce_breaker_on_payout_status();

CREATE OR REPLACE FUNCTION public.trg_enforce_breaker_on_payout()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_payouts_blocked boolean;
  v_approvals_blocked boolean;
  v_level text;
BEGIN
  SELECT payouts_blocked, approvals_blocked, breaker_level
  INTO v_payouts_blocked, v_approvals_blocked, v_level
  FROM econ_breaker_state
  WHERE id = '00000000-0000-0000-0000-000000000001';

  -- FAIL-CLOSED: missing row blocks everything
  IF NOT FOUND THEN
    RAISE EXCEPTION 'BREAKER_STATE_MISSING: fail-closed. All payout transitions blocked.';
  END IF;

  -- Block approval transitions
  IF NEW.status = 'approved' AND (OLD.status IS DISTINCT FROM NEW.status) THEN
    IF COALESCE(v_approvals_blocked, true) THEN
      RAISE EXCEPTION 'BREAKER_ACTIVE: approvals blocked. level=%', v_level;
    END IF;
  END IF;

  -- Block payment-exposure transitions
  IF NEW.status IN ('payment_initiated', 'paid', 'paid_confirmed')
     AND (OLD.status IS DISTINCT FROM NEW.status) THEN
    IF COALESCE(v_payouts_blocked, true) THEN
      RAISE EXCEPTION 'BREAKER_ACTIVE: payouts blocked. level=%', v_level;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_breaker_enforce_payout_status
  BEFORE UPDATE OF status ON public.payouts
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_enforce_breaker_on_payout();


-- ========================================
-- 4. Cohort-scoped indexes for future per-cohort breaker queries
-- ========================================
CREATE INDEX IF NOT EXISTS idx_accounts_passed_at_cohort
  ON public.accounts (cohort_id, passed_at)
  WHERE passed_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_accounts_failed_at_cohort
  ON public.accounts (cohort_id, failed_at)
  WHERE failed_at IS NOT NULL;
