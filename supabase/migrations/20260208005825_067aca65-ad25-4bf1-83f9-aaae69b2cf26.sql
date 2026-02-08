
-- ============================================================
-- ECONOMIC CIRCUIT BREAKER (A + C) + COMPOUND CHANGE SIMULATOR (B)
-- ============================================================
-- A: Event-driven econ gate — triggers on account pass / payout approval
-- C: Hard pass-rate circuit breaker at 15% / 18% / 20%
-- B: Compound-change impact simulator RPC

-- 1. BREAKER STATE TABLE (singleton)
CREATE TABLE public.econ_breaker_state (
  id uuid PRIMARY KEY DEFAULT '00000000-0000-0000-0000-000000000001'::uuid,
  breaker_level text NOT NULL DEFAULT 'normal'
    CHECK (breaker_level IN ('normal', 'elevated', 'critical', 'emergency')),
  payouts_blocked boolean NOT NULL DEFAULT false,
  approvals_blocked boolean NOT NULL DEFAULT false,
  evaluations_frozen boolean NOT NULL DEFAULT false,
  rolling_pass_rate numeric NOT NULL DEFAULT 0,
  rolling_pass_count integer NOT NULL DEFAULT 0,
  rolling_total_count integer NOT NULL DEFAULT 0,
  net_buffer numeric,
  pending_liability numeric NOT NULL DEFAULT 0,
  last_evaluated_at timestamptz NOT NULL DEFAULT now(),
  triggered_by text,
  previous_level text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Seed singleton row
INSERT INTO public.econ_breaker_state (id) VALUES ('00000000-0000-0000-0000-000000000001');

-- RLS
ALTER TABLE public.econ_breaker_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can view breaker state"
  ON public.econ_breaker_state FOR SELECT
  USING (has_any_role(auth.uid(), ARRAY['risk_officer'::app_role, 'admin'::app_role]));

CREATE POLICY "No client writes on breaker state"
  ON public.econ_breaker_state FOR INSERT
  WITH CHECK (false);

CREATE POLICY "No client updates on breaker state"
  ON public.econ_breaker_state FOR UPDATE
  USING (false);

CREATE POLICY "No client deletes on breaker state"
  ON public.econ_breaker_state FOR DELETE
  USING (false);


-- 2. CORE EVALUATION FUNCTION
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

  -- Rolling 30-day pass rate
  -- Count accounts created in last 30 days that reached passed+ states
  SELECT
    COUNT(*) FILTER (WHERE status IN ('passed', 'payout_requested', 'payout_under_review', 'payout_approved', 'closed')
                     AND passed_at IS NOT NULL),
    COUNT(*)
  INTO v_passed, v_total
  FROM accounts
  WHERE created_at >= now() - interval '30 days';

  IF v_total > 0 THEN
    v_pass_rate := (v_passed::numeric / v_total::numeric) * 100;
  ELSE
    v_pass_rate := 0;
  END IF;

  -- Pending payout liability
  SELECT COALESCE(SUM(amount), 0)
  INTO v_pending_liability
  FROM payouts
  WHERE status IN ('pending', 'under_review', 'approved');

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


-- 3. EVENT-DRIVEN TRIGGERS (A)

-- Trigger on account status changes
CREATE OR REPLACE FUNCTION public.trg_account_status_breaker()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Fire when account transitions TO a passed-like state
  IF NEW.status IN ('passed', 'payout_requested', 'payout_under_review', 'payout_approved')
     AND (OLD.status IS NULL OR OLD.status IS DISTINCT FROM NEW.status) THEN
    PERFORM evaluate_econ_breaker();
    UPDATE econ_breaker_state
    SET triggered_by = 'account_' || NEW.status::text
    WHERE id = '00000000-0000-0000-0000-000000000001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_account_breaker_eval
  AFTER UPDATE OF status ON public.accounts
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_account_status_breaker();


-- Trigger on payout status changes
CREATE OR REPLACE FUNCTION public.trg_payout_status_breaker()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Fire when payout changes status (approval, payment, etc.)
  IF TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status THEN
    PERFORM evaluate_econ_breaker();
    UPDATE econ_breaker_state
    SET triggered_by = 'payout_' || NEW.status::text
    WHERE id = '00000000-0000-0000-0000-000000000001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_payout_breaker_eval_update
  AFTER UPDATE OF status ON public.payouts
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_payout_status_breaker();

CREATE TRIGGER trg_payout_breaker_eval_insert
  AFTER INSERT ON public.payouts
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_payout_status_breaker();


-- 4. DB-LEVEL ENFORCEMENT (fail-closed)

-- Block payout approvals when breaker says so
CREATE OR REPLACE FUNCTION public.trg_enforce_breaker_on_payout()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_blocked boolean;
  v_level text;
BEGIN
  -- Only enforce on transitions TO approved (human approval step)
  -- Allow 'paid' and other terminal states (webhook-driven)
  IF NEW.status = 'approved' AND (OLD.status IS NULL OR OLD.status != 'approved') THEN
    SELECT approvals_blocked, breaker_level
    INTO v_blocked, v_level
    FROM econ_breaker_state
    WHERE id = '00000000-0000-0000-0000-000000000001';

    IF COALESCE(v_blocked, false) THEN
      RAISE EXCEPTION 'BREAKER_ACTIVE: Payout approvals blocked. Circuit breaker level: %. Pass rate or net buffer has triggered economic protection. Manual override not available at DB level.', v_level;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_breaker_block_payout_approval
  BEFORE UPDATE OF status ON public.payouts
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_enforce_breaker_on_payout();


-- Block new account creation when evaluations are frozen
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

  IF COALESCE(v_frozen, false) THEN
    RAISE EXCEPTION 'BREAKER_ACTIVE: New evaluations frozen. Circuit breaker level: %. Platform intake is paused until pass rate normalizes.', v_level;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_breaker_block_account_create
  BEFORE INSERT ON public.accounts
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_enforce_breaker_on_account_create();


-- 5. READ RPC for UI/Edge Functions
CREATE OR REPLACE FUNCTION public.get_econ_breaker_state()
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
  previous_level text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    breaker_level,
    payouts_blocked,
    approvals_blocked,
    evaluations_frozen,
    rolling_pass_rate,
    rolling_pass_count,
    rolling_total_count,
    net_buffer,
    pending_liability,
    last_evaluated_at,
    triggered_by,
    previous_level
  FROM econ_breaker_state
  WHERE id = '00000000-0000-0000-0000-000000000001';
$$;

REVOKE EXECUTE ON FUNCTION public.get_econ_breaker_state() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_econ_breaker_state() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_econ_breaker_state() TO service_role;


-- 6. COMPOUND CHANGE IMPACT SIMULATOR (B)
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
  v_pending_changes jsonb;
  v_pending_count integer;
  v_proposed_avg_split numeric;
  v_current_breakeven numeric;
  v_proposed_breakeven numeric;
  v_breaker record;
BEGIN
  -- Current weighted averages across active performance cohorts
  SELECT
    COALESCE(AVG(payout_split_percent), 80),
    COALESCE(AVG(lifetime_cap_multiple), 8),
    COALESCE(AVG(entry_fee), 149)
  INTO v_current_avg_split, v_current_avg_cap_multiple, v_current_avg_entry_fee
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

  -- Calculate proposed split incorporating pending changes
  SELECT COALESCE(AVG(
    CASE
      WHEN ssc.proposed_value IS NOT NULL
           AND ssc.setting_key LIKE '%payout_split%'
        THEN (ssc.proposed_value->>'value')::numeric
      ELSE c.payout_split_percent
    END
  ), 80)
  INTO v_proposed_avg_split
  FROM cohorts c
  LEFT JOIN safety_setting_changes ssc
    ON ssc.setting_key = 'cohort.' || c.id::text || '.payout_split_percent'
    AND ssc.status = 'pending'
  WHERE c.is_active = true AND c.cohort_phase = 'performance';

  -- Approximate breakeven pass rate
  -- Higher split → more payout per pass → lower tolerable pass rate
  -- Formula: breakeven ≈ entry_fee / (entry_fee + avg_payout_exposure)
  -- avg_payout_exposure ≈ starting_balance * profit_target * split * cap_factor
  v_current_breakeven := ROUND(
    (v_current_avg_entry_fee / (v_current_avg_entry_fee + (100000 * 0.10 * v_current_avg_split / 100 * LEAST(v_current_avg_cap_multiple, 12) / 10))) * 100,
    2
  );

  v_proposed_breakeven := ROUND(
    (v_current_avg_entry_fee / (v_current_avg_entry_fee + (100000 * 0.10 * v_proposed_avg_split / 100 * LEAST(v_current_avg_cap_multiple, 12) / 10))) * 100,
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
      'estimated_breakeven_pass_rate', v_current_breakeven
    ),
    'proposed', jsonb_build_object(
      'avg_payout_split', ROUND(v_proposed_avg_split, 2),
      'estimated_breakeven_pass_rate', v_proposed_breakeven
    ),
    'delta', jsonb_build_object(
      'split_change_pct', ROUND(v_proposed_avg_split - v_current_avg_split, 2),
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
