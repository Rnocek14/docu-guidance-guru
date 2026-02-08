
-- ============================================================
-- P0 + P1 BREAKER HARDENING MIGRATION
-- Fixes: fail-closed enforcement, payment blocking, pass-rate
-- denominator, liability set, indexes, compound simulator
-- ============================================================

-- ========================================
-- P0-1: Fix enforcement trigger — fail-closed on missing row
--        + block BOTH approvals AND payments
-- ========================================

-- Drop old trigger + function
DROP TRIGGER IF EXISTS trg_breaker_block_payout_approval ON public.payouts;
DROP FUNCTION IF EXISTS public.trg_enforce_breaker_on_payout();

-- New combined enforcement: blocks approval when approvals_blocked,
-- blocks payment when payouts_blocked. Missing row = BLOCK.
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
  v_found boolean;
BEGIN
  SELECT payouts_blocked, approvals_blocked, breaker_level
    INTO v_payouts_blocked, v_approvals_blocked, v_level
  FROM econ_breaker_state
  WHERE id = '00000000-0000-0000-0000-000000000001';

  v_found := FOUND;

  -- FAIL-CLOSED: missing singleton row blocks everything
  IF NOT v_found THEN
    RAISE EXCEPTION 'BREAKER_STATE_MISSING: Econ breaker singleton row not found. All payout transitions blocked (fail-closed).';
  END IF;

  -- Block transition TO 'approved' when approvals_blocked
  IF NEW.status = 'approved' AND (OLD.status IS DISTINCT FROM NEW.status) THEN
    IF COALESCE(v_approvals_blocked, true) THEN
      RAISE EXCEPTION 'BREAKER_ACTIVE: Payout approval blocked. Circuit breaker level: %. Approvals are paused until economic conditions normalize.', v_level;
    END IF;
  END IF;

  -- Block transition TO 'paid', 'paid_confirmed', 'payment_initiated'
  -- when payouts_blocked (these are actual money movements)
  IF NEW.status IN ('paid', 'paid_confirmed', 'payment_initiated')
     AND (OLD.status IS DISTINCT FROM NEW.status) THEN
    IF COALESCE(v_payouts_blocked, true) THEN
      RAISE EXCEPTION 'BREAKER_ACTIVE: Payout payment blocked. Circuit breaker level: %. Payments are paused until economic conditions normalize.', v_level;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_breaker_block_payout
  BEFORE UPDATE OF status ON public.payouts
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_enforce_breaker_on_payout();


-- ========================================
-- P0-2: Fix account intake trigger — fail-closed on missing row
-- ========================================

DROP TRIGGER IF EXISTS trg_breaker_block_account_create ON public.accounts;
DROP FUNCTION IF EXISTS public.trg_enforce_breaker_on_account_create();

CREATE OR REPLACE FUNCTION public.trg_enforce_breaker_on_account_create()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_frozen boolean;
  v_level text;
BEGIN
  SELECT evaluations_frozen, breaker_level
    INTO v_frozen, v_level
  FROM econ_breaker_state
  WHERE id = '00000000-0000-0000-0000-000000000001';

  -- FAIL-CLOSED: missing row blocks intake
  IF NOT FOUND THEN
    RAISE EXCEPTION 'BREAKER_STATE_MISSING: Econ breaker singleton row not found. Account creation blocked (fail-closed).';
  END IF;

  IF COALESCE(v_frozen, true) THEN
    RAISE EXCEPTION 'BREAKER_ACTIVE: New evaluations frozen. Circuit breaker level: %. Platform intake is paused until pass rate normalizes.', v_level;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_breaker_block_account_create
  BEFORE INSERT ON public.accounts
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_enforce_breaker_on_account_create();


-- ========================================
-- P0-3: Fix pass-rate denominator
-- Use resolved outcomes only (passed_at or failed_at set in last 30d)
-- NOT created_at, which inflates denominator with in-progress accounts
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
  -- Get previous level for change detection
  SELECT breaker_level INTO v_prev_level
  FROM econ_breaker_state
  WHERE id = '00000000-0000-0000-0000-000000000001';

  -- Rolling 30-day pass rate on RESOLVED outcomes only
  -- Denominator: accounts that resolved (passed or failed) in last 30 days
  -- Numerator: accounts that passed in last 30 days
  SELECT
    COUNT(*) FILTER (WHERE passed_at IS NOT NULL
                     AND passed_at >= now() - interval '30 days'),
    COUNT(*)
  INTO v_passed, v_total
  FROM accounts
  WHERE (
    (passed_at IS NOT NULL AND passed_at >= now() - interval '30 days')
    OR
    (failed_at IS NOT NULL AND failed_at >= now() - interval '30 days')
  );

  IF v_total > 0 THEN
    v_pass_rate := (v_passed::numeric / v_total::numeric) * 100;
  ELSE
    v_pass_rate := 0;
  END IF;

  -- Pending payout liability: full lifecycle set
  -- Include all non-terminal statuses that represent financial exposure
  SELECT COALESCE(SUM(amount), 0)
  INTO v_pending_liability
  FROM payouts
  WHERE status IN ('pending', 'under_review', 'approved', 'payment_initiated');

  -- Cash reserve (best available from liability_buffer_settings)
  SELECT COALESCE(MAX(cash_reserve), 0)
  INTO v_cash_reserve
  FROM liability_buffer_settings;

  v_net_buffer := v_cash_reserve - v_pending_liability;

  -- CIRCUIT BREAKER THRESHOLDS (C)
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

  -- Also escalate if net buffer is negative
  IF v_net_buffer < 0 THEN
    v_payouts_blocked := true;
    IF v_level = 'normal' THEN
      v_level := 'elevated';
    END IF;
  END IF;

  -- Update singleton
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

  -- Notify staff on level CHANGE (not on every evaluation)
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
-- P1-1: Performance indexes for breaker evaluation
-- ========================================

-- Index for resolved-outcome pass-rate query
CREATE INDEX IF NOT EXISTS idx_accounts_passed_at
  ON public.accounts (passed_at)
  WHERE passed_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_accounts_failed_at
  ON public.accounts (failed_at)
  WHERE failed_at IS NOT NULL;

-- Index for pending liability query
CREATE INDEX IF NOT EXISTS idx_payouts_status
  ON public.payouts (status)
  WHERE status IN ('pending', 'under_review', 'approved', 'payment_initiated');


-- ========================================
-- P1-2: Expand compound-change simulator
-- Now incorporates lifetime_cap_multiple and first_payout_cap changes
-- and computes per-cohort weighted impact
-- ========================================

CREATE OR REPLACE FUNCTION public.simulate_compound_config_impact()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result jsonb;
  v_current_avg_split numeric;
  v_current_avg_cap_multiple numeric;
  v_current_avg_entry_fee numeric;
  v_current_avg_first_cap numeric;
  v_pending_changes jsonb;
  v_pending_count integer;
  v_proposed_avg_split numeric;
  v_proposed_avg_cap_multiple numeric;
  v_proposed_avg_first_cap numeric;
  v_current_breakeven numeric;
  v_proposed_breakeven numeric;
  v_breaker record;
BEGIN
  -- Current weighted averages across active performance cohorts
  SELECT
    COALESCE(AVG(payout_split_percent), 80),
    COALESCE(AVG(lifetime_cap_multiple), 8),
    COALESCE(AVG(entry_fee), 149),
    COALESCE(AVG(first_payout_cap_amount), 500)
  INTO v_current_avg_split, v_current_avg_cap_multiple,
       v_current_avg_entry_fee, v_current_avg_first_cap
  FROM cohorts
  WHERE is_active = true AND cohort_phase = 'performance';

  -- Collect all pending safety setting changes
  SELECT
    COALESCE(jsonb_agg(jsonb_build_object(
      'id', id,
      'setting_key', setting_key,
      'proposed_value', proposed_value,
      'current_value_snapshot', current_value_snapshot,
      'reason', reason,
      'proposed_at', proposed_at,
      'proposed_by_system', proposed_by_system
    )), '[]'::jsonb),
    COUNT(*)
  INTO v_pending_changes, v_pending_count
  FROM safety_setting_changes
  WHERE status = 'pending';

  -- Calculate proposed values incorporating ALL pending change types
  SELECT
    COALESCE(AVG(
      CASE
        WHEN split_change.proposed_value IS NOT NULL
          THEN (split_change.proposed_value->>'value')::numeric
        ELSE c.payout_split_percent
      END
    ), 80),
    COALESCE(AVG(
      CASE
        WHEN cap_change.proposed_value IS NOT NULL
          THEN (cap_change.proposed_value->>'value')::numeric
        ELSE COALESCE(c.lifetime_cap_multiple, 8)
      END
    ), 8),
    COALESCE(AVG(
      CASE
        WHEN first_cap_change.proposed_value IS NOT NULL
          THEN (first_cap_change.proposed_value->>'value')::numeric
        ELSE COALESCE(c.first_payout_cap_amount, 500)
      END
    ), 500)
  INTO v_proposed_avg_split, v_proposed_avg_cap_multiple, v_proposed_avg_first_cap
  FROM cohorts c
  LEFT JOIN safety_setting_changes split_change
    ON split_change.setting_key = 'cohort.' || c.id::text || '.payout_split_percent'
    AND split_change.status = 'pending'
  LEFT JOIN safety_setting_changes cap_change
    ON cap_change.setting_key = 'cohort.' || c.id::text || '.lifetime_cap_multiple'
    AND cap_change.status = 'pending'
  LEFT JOIN safety_setting_changes first_cap_change
    ON first_cap_change.setting_key = 'cohort.' || c.id::text || '.first_payout_cap_amount'
    AND first_cap_change.status = 'pending'
  WHERE c.is_active = true AND c.cohort_phase = 'performance';

  -- Approximate breakeven pass rate (heuristic, not Monte Carlo)
  -- Higher split or higher cap multiple → more payout per pass → lower tolerable pass rate
  v_current_breakeven := ROUND(
    (v_current_avg_entry_fee / (v_current_avg_entry_fee + (100000 * 0.10 * v_current_avg_split / 100 * LEAST(v_current_avg_cap_multiple, 12) / 10))) * 100,
    2
  );

  v_proposed_breakeven := ROUND(
    (v_current_avg_entry_fee / (v_current_avg_entry_fee + (100000 * 0.10 * v_proposed_avg_split / 100 * LEAST(v_proposed_avg_cap_multiple, 12) / 10))) * 100,
    2
  );

  -- Get current breaker state for context
  SELECT * INTO v_breaker
  FROM econ_breaker_state
  WHERE id = '00000000-0000-0000-0000-000000000001';

  v_result := jsonb_build_object(
    'current', jsonb_build_object(
      'avg_payout_split', ROUND(v_current_avg_split, 2),
      'avg_lifetime_cap_multiple', ROUND(v_current_avg_cap_multiple, 2),
      'avg_entry_fee', ROUND(v_current_avg_entry_fee, 0),
      'avg_first_payout_cap', ROUND(v_current_avg_first_cap, 0),
      'estimated_breakeven_pass_rate', v_current_breakeven
    ),
    'proposed', jsonb_build_object(
      'avg_payout_split', ROUND(v_proposed_avg_split, 2),
      'avg_lifetime_cap_multiple', ROUND(v_proposed_avg_cap_multiple, 2),
      'avg_first_payout_cap', ROUND(v_proposed_avg_first_cap, 0),
      'estimated_breakeven_pass_rate', v_proposed_breakeven
    ),
    'delta', jsonb_build_object(
      'split_change_pct', ROUND(v_proposed_avg_split - v_current_avg_split, 2),
      'cap_multiple_change', ROUND(v_proposed_avg_cap_multiple - v_current_avg_cap_multiple, 2),
      'first_cap_change', ROUND(v_proposed_avg_first_cap - v_current_avg_first_cap, 0),
      'breakeven_shift_pct', ROUND(v_proposed_breakeven - v_current_breakeven, 2)
    ),
    'breaker', jsonb_build_object(
      'level', v_breaker.breaker_level,
      'rolling_pass_rate', v_breaker.rolling_pass_rate,
      'headroom_to_elevated', ROUND(15 - COALESCE(v_breaker.rolling_pass_rate, 0), 2),
      'headroom_to_breakeven', ROUND(COALESCE(v_current_breakeven, 16) - COALESCE(v_breaker.rolling_pass_rate, 0), 2)
    ),
    'pending_changes_count', v_pending_count,
    'pending_changes', v_pending_changes,
    'approximation_notice', 'Heuristic estimate. Not a Monte Carlo simulation. Reflects split, lifetime cap, and first payout cap changes only.',
    'warning', CASE
      WHEN v_proposed_breakeven < v_current_breakeven - 2
        THEN 'DANGER: Compound changes reduce breakeven tolerance by >2 percentage points'
      WHEN v_proposed_breakeven < v_current_breakeven - 1
        THEN 'WARNING: Compound changes reduce breakeven tolerance by >1 percentage point'
      WHEN v_proposed_breakeven < v_current_breakeven - 0.5
        THEN 'CAUTION: Compound changes reduce breakeven tolerance'
      ELSE null
    END,
    'evaluated_at', now()
  );

  RETURN v_result;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.simulate_compound_config_impact() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.simulate_compound_config_impact() TO authenticated;
GRANT EXECUTE ON FUNCTION public.simulate_compound_config_impact() TO service_role;
