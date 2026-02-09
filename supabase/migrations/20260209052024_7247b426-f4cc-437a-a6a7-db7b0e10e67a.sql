
-- ============================================================
-- P0 PATCH SET: All 4 launch-blocking fixes
-- ============================================================

-- ── P0-3: Fix calculate_payout_eligibility ──────────────────
-- Replace every status = 'paid' with status IN ('paid','paid_confirmed')
CREATE OR REPLACE FUNCTION public.calculate_payout_eligibility(_account_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _account RECORD;
  _cohort RECORD;
  _profile RECORD;
  _last_payout RECORD;
  _has_prior_payout boolean := false;
  _eligible boolean := false;
  _reason text := '';
  _reason_code text := '';
  _hint text := '';
  _max_eligible numeric := 0;
  _total_eligible_by_split numeric := 0;
  _realized_profit numeric := 0;
  _cycle_baseline numeric;
  _payout_split_percent numeric;
  _days_since_pass integer := 0;
  _cooling_period_days integer;
  _payout_window_opened boolean := false;
  _payout_window_opens_at timestamptz;
  _is_first_payout_in_cycle boolean := true;
  _first_payout_cap_amount numeric;
  _first_payout_cap_applied boolean := false;
  _lifetime_cap_amount numeric;
  _lifetime_paid_total numeric := 0;
  _lifetime_headroom numeric;
  _lifetime_cap_applied boolean := false;
  _max_eligible_before_first_cap numeric := 0;
  _paid_since_cycle numeric := 0;
  _paid_count_since_cycle integer := 0;
  _user_cohort_payout RECORD;
  _profit_buffer_required numeric;
  _profit_buffer_remaining numeric := 0;
  _profit_buffer_met boolean := true;
  _profit_buffer_progress_pct numeric := 100;
  _required_winning_days integer := 0;
  _winning_days_since_payout integer := 0;
  _winning_days_remaining integer := 0;
  _winning_days_progress_pct numeric := 100;
BEGIN
  -- Fetch account
  SELECT * INTO _account FROM accounts WHERE id = _account_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('eligible', false, 'reason', 'Account not found', 'reason_code', 'ACCOUNT_NOT_FOUND');
  END IF;

  -- Fetch cohort
  SELECT * INTO _cohort FROM cohorts WHERE id = _account.cohort_id;

  -- Fetch profile
  SELECT * INTO _profile FROM profiles WHERE user_id = _account.user_id;

  -- Phase guard — only Performance accounts can request payouts
  IF COALESCE(_cohort.cohort_phase, 'evaluation') <> 'performance' THEN
    RETURN jsonb_build_object(
      'eligible', false,
      'reason', CASE _cohort.cohort_phase
        WHEN 'evaluation' THEN 'Complete the evaluation phase to unlock payouts'
        WHEN 'verification' THEN 'Complete the verification phase to unlock payouts'
        ELSE 'This account phase is not eligible for payouts'
      END,
      'reason_code', 'NOT_PERFORMANCE_PHASE',
      'cohort_phase', COALESCE(_cohort.cohort_phase, 'evaluation'),
      'hint', 'Payouts are only available from Performance Accounts after successfully completing all prior phases.'
    );
  END IF;

  -- Check account status
  IF _account.status NOT IN ('passed', 'payout_requested', 'payout_under_review', 'payout_approved') THEN
    RETURN jsonb_build_object(
      'eligible', false,
      'reason', 'Account must be in passed status to request a payout',
      'reason_code', 'BAD_STATUS',
      'account_status', _account.status
    );
  END IF;

  -- Check for pending violations
  IF EXISTS (SELECT 1 FROM violations WHERE account_id = _account_id AND confirmed_at IS NULL) THEN
    RETURN jsonb_build_object(
      'eligible', false,
      'reason', 'Account has pending violations that must be resolved first',
      'reason_code', 'PENDING_VIOLATIONS'
    );
  END IF;

  -- KYC check
  IF _profile.kyc_status IS NULL OR _profile.kyc_status <> 'verified' THEN
    RETURN jsonb_build_object(
      'eligible', false,
      'reason', 'KYC verification is required before requesting a payout',
      'reason_code', 'KYC_REQUIRED',
      'kyc_status', COALESCE(_profile.kyc_status, 'pending')
    );
  END IF;

  -- Cooling period (post-pass, before first payout window)
  _cooling_period_days := COALESCE(_cohort.payout_eligibility_delay_days, 7);
  IF _account.passed_at IS NOT NULL THEN
    _days_since_pass := EXTRACT(DAY FROM (now() - _account.passed_at))::integer;
    _payout_window_opens_at := _account.passed_at + (_cooling_period_days || ' days')::interval;
    _payout_window_opened := now() >= _payout_window_opens_at;
  END IF;

  IF NOT _payout_window_opened THEN
    RETURN jsonb_build_object(
      'eligible', false,
      'reason', format('Payout window opens in %s days', GREATEST(_cooling_period_days - _days_since_pass, 0)),
      'reason_code', 'COOLING_PERIOD',
      'hint', 'Your account must complete a cooling period after passing before payouts are available.',
      'payout_window_opened', false,
      'cooling_period_days', _cooling_period_days,
      'days_since_pass', _days_since_pass,
      'days_remaining', GREATEST(_cooling_period_days - _days_since_pass, 0),
      'payout_window_opens_at', _payout_window_opens_at,
      'passed_at', _account.passed_at
    );
  END IF;

  -- Payout split and baseline
  _payout_split_percent := COALESCE(_cohort.payout_split_percent, 80);
  _cycle_baseline := COALESCE(_account.payout_cycle_start_balance, _account.starting_balance);
  _realized_profit := _account.current_balance - _cycle_baseline;

  -- *** P0-3 FIX: Check for prior payouts using BOTH paid statuses ***
  SELECT * INTO _last_payout FROM payouts
  WHERE account_id = _account_id AND status IN ('paid', 'paid_confirmed')
  ORDER BY paid_at DESC LIMIT 1;

  _required_winning_days := COALESCE(_cohort.min_winning_days_between_payouts, _cohort.min_trading_days_between_payouts, 0);

  IF _last_payout IS NOT NULL THEN
    _has_prior_payout := true;

    -- Winning days: count net-positive PnL days since last paid payout
    WITH day_pnl AS (
      SELECT
        ((COALESCE(closed_at, opened_at) AT TIME ZONE 'America/New_York' - interval '17 hours')::date) AS trading_day,
        SUM(COALESCE(pnl, 0)) AS net_pnl
      FROM trades
      WHERE account_id = _account_id
        AND COALESCE(closed_at, opened_at) > _last_payout.paid_at
      GROUP BY 1
    )
    SELECT COUNT(*) INTO _winning_days_since_payout
    FROM day_pnl
    WHERE net_pnl > 0;

    -- Check winning days gate
    IF _required_winning_days > 0 AND _winning_days_since_payout < _required_winning_days THEN
      _winning_days_remaining := _required_winning_days - _winning_days_since_payout;
      _winning_days_progress_pct := CASE
        WHEN _required_winning_days <= 0 THEN 100
        ELSE LEAST(100, GREATEST(0, (_winning_days_since_payout::numeric / _required_winning_days) * 100))
      END;

      RETURN jsonb_build_object(
        'eligible', false,
        'reason', format('You need %s more winning trading day(s) before requesting a payout', _winning_days_remaining),
        'reason_code', 'MIN_WINNING_DAYS',
        'hint', format('Complete %s winning trading days since your last payout to unlock your next payout request.', _required_winning_days),
        'has_prior_payout', true,
        'payout_window_opened', true,
        'cooling_period_days', _cooling_period_days,
        'days_since_pass', _days_since_pass,
        'passed_at', _account.passed_at,
        'winning_days_since_payout', _winning_days_since_payout,
        'required_winning_days', _required_winning_days,
        'winning_days_remaining', _winning_days_remaining,
        'winning_days_progress_pct', _winning_days_progress_pct,
        'realized_profit', _realized_profit,
        'payout_split_percent', _payout_split_percent
      );
    END IF;

    -- Profit buffer gate
    _profit_buffer_required := _cohort.min_profit_buffer;
    IF _profit_buffer_required IS NOT NULL AND _profit_buffer_required > 0 THEN
      _profit_buffer_remaining := GREATEST(_profit_buffer_required - _realized_profit, 0);
      _profit_buffer_met := _realized_profit >= _profit_buffer_required;
      _profit_buffer_progress_pct := CASE
        WHEN _profit_buffer_required <= 0 THEN 100
        WHEN _realized_profit <= 0 THEN 0
        ELSE LEAST(100, GREATEST(0, (_realized_profit / _profit_buffer_required) * 100))
      END;

      IF _realized_profit <= 0 THEN
        RETURN jsonb_build_object(
          'eligible', false,
          'reason', 'You need to generate profit above your cycle baseline before requesting a payout',
          'reason_code', 'NO_PROFIT',
          'hint', format('Your current balance must exceed your cycle baseline of $%s', _cycle_baseline),
          'has_prior_payout', true,
          'payout_window_opened', true,
          'cooling_period_days', _cooling_period_days,
          'days_since_pass', _days_since_pass,
          'passed_at', _account.passed_at,
          'profit_buffer_required', _profit_buffer_required,
          'profit_buffer_remaining', _profit_buffer_remaining,
          'profit_buffer_met', false,
          'profit_buffer_progress_pct', 0,
          'realized_profit', _realized_profit,
          'payout_split_percent', _payout_split_percent,
          'winning_days_since_payout', _winning_days_since_payout,
          'required_winning_days', _required_winning_days,
          'winning_days_remaining', GREATEST(_required_winning_days - _winning_days_since_payout, 0),
          'winning_days_progress_pct', CASE WHEN COALESCE(_required_winning_days, 0) <= 0 THEN 100 ELSE LEAST(100, GREATEST(0, (_winning_days_since_payout::numeric / _required_winning_days) * 100)) END
        );
      END IF;

      IF NOT _profit_buffer_met THEN
        RETURN jsonb_build_object(
          'eligible', false,
          'reason', format('You need $%s more in profit to meet the buffer requirement', ROUND(_profit_buffer_remaining, 2)),
          'reason_code', 'PROFIT_BUFFER',
          'hint', format('Earn at least $%s in profit above your cycle baseline before requesting a payout.', _profit_buffer_required),
          'has_prior_payout', true,
          'payout_window_opened', true,
          'cooling_period_days', _cooling_period_days,
          'days_since_pass', _days_since_pass,
          'passed_at', _account.passed_at,
          'profit_buffer_required', _profit_buffer_required,
          'profit_buffer_remaining', _profit_buffer_remaining,
          'profit_buffer_met', false,
          'profit_buffer_progress_pct', _profit_buffer_progress_pct,
          'realized_profit', _realized_profit,
          'payout_split_percent', _payout_split_percent,
          'winning_days_since_payout', _winning_days_since_payout,
          'required_winning_days', _required_winning_days,
          'winning_days_remaining', GREATEST(_required_winning_days - _winning_days_since_payout, 0),
          'winning_days_progress_pct', CASE WHEN COALESCE(_required_winning_days, 0) <= 0 THEN 100 ELSE LEAST(100, GREATEST(0, (_winning_days_since_payout::numeric / _required_winning_days) * 100)) END
        );
      END IF;
    ELSE
      IF _realized_profit <= 0 THEN
        RETURN jsonb_build_object(
          'eligible', false,
          'reason', 'You need to generate profit above your cycle baseline before requesting a payout',
          'reason_code', 'NO_PROFIT',
          'hint', format('Your current balance must exceed your cycle baseline of $%s', _cycle_baseline),
          'has_prior_payout', true,
          'payout_window_opened', true,
          'realized_profit', _realized_profit,
          'payout_split_percent', _payout_split_percent
        );
      END IF;
    END IF;

    -- *** P0-3 FIX: Count paid payouts in cycle using BOTH paid statuses ***
    SELECT COUNT(*), COALESCE(SUM(amount), 0) INTO _paid_count_since_cycle, _paid_since_cycle
    FROM payouts WHERE account_id = _account_id AND status IN ('paid', 'paid_confirmed')
      AND paid_at >= COALESCE(_account.payout_cycle_started_at, _account.created_at);

    _is_first_payout_in_cycle := _paid_count_since_cycle = 0;
  ELSE
    IF _realized_profit <= 0 THEN
      RETURN jsonb_build_object(
        'eligible', false,
        'reason', 'You need to generate profit above your starting balance before requesting a payout',
        'reason_code', 'NO_PROFIT',
        'hint', 'Start trading and generate positive returns to unlock your first payout.',
        'has_prior_payout', false,
        'payout_window_opened', true,
        'realized_profit', _realized_profit,
        'payout_split_percent', _payout_split_percent
      );
    END IF;
    _is_first_payout_in_cycle := true;
  END IF;

  -- Calculate eligible amount
  _total_eligible_by_split := (_realized_profit * _payout_split_percent / 100);
  _max_eligible := GREATEST(_total_eligible_by_split - _paid_since_cycle, 0);
  _max_eligible_before_first_cap := _max_eligible;

  _first_payout_cap_amount := _cohort.first_payout_cap_amount;
  IF _is_first_payout_in_cycle AND _first_payout_cap_amount IS NOT NULL AND _max_eligible > _first_payout_cap_amount THEN
    _max_eligible := _first_payout_cap_amount;
    _first_payout_cap_applied := true;
  END IF;

  IF _cohort.lifetime_cap_multiple IS NOT NULL AND _cohort.entry_fee IS NOT NULL THEN
    _lifetime_cap_amount := _cohort.entry_fee * _cohort.lifetime_cap_multiple;

    SELECT * INTO _user_cohort_payout FROM user_cohort_payouts
    WHERE user_id = _account.user_id AND cohort_id = _cohort.id;

    _lifetime_paid_total := COALESCE(_user_cohort_payout.lifetime_paid_total, 0);
    _lifetime_headroom := _lifetime_cap_amount - _lifetime_paid_total;

    IF _lifetime_headroom <= 0 THEN
      RETURN jsonb_build_object(
        'eligible', false,
        'reason', 'Lifetime payout cap has been reached for this cohort tier',
        'reason_code', 'LIFETIME_CAP',
        'lifetime_cap_amount', _lifetime_cap_amount,
        'lifetime_paid_total', _lifetime_paid_total,
        'lifetime_headroom', 0,
        'payout_window_opened', true,
        'has_prior_payout', _has_prior_payout
      );
    END IF;

    IF _max_eligible > _lifetime_headroom THEN
      _max_eligible := _lifetime_headroom;
      _lifetime_cap_applied := true;
    END IF;
  END IF;

  IF _cohort.max_payout_absolute IS NOT NULL AND _max_eligible > _cohort.max_payout_absolute THEN
    _max_eligible := _cohort.max_payout_absolute;
  END IF;

  IF _max_eligible < 50 THEN
    RETURN jsonb_build_object(
      'eligible', false,
      'reason', 'Eligible amount is below the minimum payout threshold of $50',
      'reason_code', 'BELOW_MINIMUM',
      'max_eligible_amount', _max_eligible,
      'realized_profit', _realized_profit,
      'payout_split_percent', _payout_split_percent,
      'payout_window_opened', true,
      'has_prior_payout', _has_prior_payout
    );
  END IF;

  _winning_days_remaining := GREATEST(_required_winning_days - _winning_days_since_payout, 0);
  _winning_days_progress_pct := CASE
    WHEN COALESCE(_required_winning_days, 0) <= 0 THEN 100
    ELSE LEAST(100, GREATEST(0, (_winning_days_since_payout::numeric / _required_winning_days) * 100))
  END;

  _eligible := true;
  RETURN jsonb_build_object(
    'eligible', true,
    'max_eligible_amount', ROUND(_max_eligible, 2),
    'max_eligible_before_first_cap', ROUND(_max_eligible_before_first_cap, 2),
    'total_eligible_by_split', ROUND(_total_eligible_by_split, 2),
    'realized_profit', ROUND(_realized_profit, 2),
    'cycle_baseline', _cycle_baseline,
    'cycle_started_at', _account.payout_cycle_started_at,
    'paid_since_cycle', _paid_since_cycle,
    'paid_count_since_cycle', _paid_count_since_cycle,
    'is_first_payout_in_cycle', _is_first_payout_in_cycle,
    'first_payout_cap_amount', _first_payout_cap_amount,
    'first_payout_cap_applied', _first_payout_cap_applied,
    'lifetime_cap_amount', _lifetime_cap_amount,
    'lifetime_paid_total', _lifetime_paid_total,
    'lifetime_headroom', _lifetime_headroom,
    'lifetime_cap_applied', _lifetime_cap_applied,
    'cohort_id', _cohort.id,
    'payout_split_percent', _payout_split_percent,
    'max_payout_percent_of_eligible', _cohort.max_payout_percent,
    'max_payout_absolute', _cohort.max_payout_absolute,
    'account_status', _account.status,
    'kyc_status', _profile.kyc_status,
    'payout_window_opened', true,
    'cooling_period_days', _cooling_period_days,
    'days_since_pass', _days_since_pass,
    'passed_at', _account.passed_at,
    'has_prior_payout', _has_prior_payout,
    'profit_buffer_required', _profit_buffer_required,
    'profit_buffer_remaining', _profit_buffer_remaining,
    'profit_buffer_met', _profit_buffer_met,
    'profit_buffer_progress_pct', _profit_buffer_progress_pct,
    'winning_days_since_payout', _winning_days_since_payout,
    'required_winning_days', _required_winning_days,
    'winning_days_remaining', _winning_days_remaining,
    'winning_days_progress_pct', _winning_days_progress_pct
  );
END;
$function$;


-- ── P0-2: Fix guard_payout_immutable_fields ─────────────────
-- Protect BOTH 'paid' and 'paid_confirmed' terminal statuses
CREATE OR REPLACE FUNCTION public.guard_payout_immutable_fields()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- approved_by immutable once set
  IF OLD.approved_by IS NOT NULL AND NEW.approved_by IS DISTINCT FROM OLD.approved_by THEN
    RAISE EXCEPTION 'approved_by is immutable once set';
  END IF;

  -- paid_by immutable once set
  IF OLD.paid_by IS NOT NULL AND NEW.paid_by IS DISTINCT FROM OLD.paid_by THEN
    RAISE EXCEPTION 'paid_by is immutable once set';
  END IF;

  -- *** P0-2 FIX: Once paid OR paid_confirmed, status is immutable ***
  IF OLD.status IN ('paid', 'paid_confirmed') AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'Terminal payouts (paid/paid_confirmed) are immutable; status cannot be changed';
  END IF;

  -- Once terminal, paid_by cannot be nulled
  IF OLD.status IN ('paid', 'paid_confirmed') AND NEW.paid_by IS NULL THEN
    RAISE EXCEPTION 'Cannot null paid_by on a terminal payout';
  END IF;

  -- Once terminal, paid_at and payment_reference are immutable
  IF OLD.status IN ('paid', 'paid_confirmed') AND (
    NEW.paid_at IS DISTINCT FROM OLD.paid_at OR
    NEW.payment_reference IS DISTINCT FROM OLD.payment_reference
  ) THEN
    RAISE EXCEPTION 'Terminal payout fields (paid_at, payment_reference) are immutable';
  END IF;

  -- Cannot null approved_by once terminal
  IF OLD.status IN ('paid', 'paid_confirmed') AND NEW.approved_by IS NULL THEN
    RAISE EXCEPTION 'Cannot null approved_by on a terminal payout';
  END IF;

  RETURN NEW;
END;
$function$;


-- ── P0-4: Fix account_last_event view RLS bypass ────────────
ALTER VIEW public.account_last_event SET (security_invoker = true);


-- ── P0-1 (partial): Create cron_http_runs observability table ──
CREATE TABLE IF NOT EXISTS public.cron_http_runs (
  id bigserial PRIMARY KEY,
  jobname text NOT NULL,
  ran_at timestamptz NOT NULL DEFAULT now(),
  http_status int,
  http_content text
);

ALTER TABLE public.cron_http_runs ENABLE ROW LEVEL SECURITY;

-- Only staff can read cron run logs
CREATE POLICY "Staff can view cron runs"
  ON public.cron_http_runs
  FOR SELECT
  USING (has_any_role(auth.uid(), ARRAY['risk_officer'::app_role, 'admin'::app_role]));

-- No client writes
CREATE POLICY "No client writes on cron_http_runs"
  ON public.cron_http_runs
  FOR INSERT
  WITH CHECK (false);

CREATE POLICY "No client updates on cron_http_runs"
  ON public.cron_http_runs
  FOR UPDATE
  USING (false);

CREATE POLICY "No client deletes on cron_http_runs"
  ON public.cron_http_runs
  FOR DELETE
  USING (false);
