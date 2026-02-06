
CREATE OR REPLACE FUNCTION public.calculate_payout_eligibility(_account_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _account record;
  _cohort record;
  _cohort_payout record;
  _last_payout record;
  _pending_violations integer;
  _pending_flags integer;
  _pending_fraud_reviews integer;
  _trading_days_since_payout integer;
  _days_since_last_payout integer;
  _realized_profit numeric;
  _eligible_by_split numeric;
  _max_eligible numeric;
  _max_eligible_before_cap numeric;
  _cycle_baseline numeric;
  _cycle_started_at timestamptz;
  _paid_since_cycle numeric;
  _paid_count_since_cycle integer;
  _is_first_payout_in_cycle boolean;
  _first_payout_cap numeric;
  _lifetime_cap_amount numeric;
  _lifetime_paid_total numeric;
  _lifetime_headroom numeric;
  _lifetime_cap_applied boolean := false;
  _kyc_status text;
  _has_prior_payout boolean;
  _days_since_pass integer;
  _cooling_period_days integer;
  _payout_window_opens_at date;
  _payout_window_opened boolean := true;
  _now_ny date;
  _passed_at_ny date;
  _profit_buffer_required numeric;
  _profit_buffer_remaining numeric;
  _profit_buffer_met boolean := true;
  _profit_buffer_progress_pct numeric;
  _winning_days_progress_pct numeric;
  _winning_days_remaining integer;
  _required_trading_days integer;
BEGIN
  SELECT * INTO _account FROM accounts WHERE id = _account_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('eligible', false, 'reason', 'Account not found', 'reason_code', 'ACCOUNT_NOT_FOUND', 'payout_window_opened', false);
  END IF;

  SELECT kyc_status INTO _kyc_status FROM public.profiles WHERE user_id = _account.user_id;
  IF COALESCE(_kyc_status, 'pending') NOT IN ('verified') THEN
    RETURN jsonb_build_object(
      'eligible', false, 'reason', 'KYC verification required before payout',
      'reason_code', 'KYC_REQUIRED',
      'kyc_status', COALESCE(_kyc_status, 'pending'),
      'hint', 'Complete identity verification to unlock payouts',
      'payout_window_opened', false
    );
  END IF;

  SELECT * INTO _cohort FROM cohorts WHERE id = _account.cohort_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('eligible', false, 'reason', 'Cohort not found', 'reason_code', 'COHORT_NOT_FOUND', 'payout_window_opened', false);
  END IF;

  SELECT * INTO _cohort_payout FROM user_cohort_payouts
  WHERE user_id = _account.user_id AND cohort_id = _account.cohort_id;
  _lifetime_paid_total := COALESCE(_cohort_payout.lifetime_paid_total, 0);

  IF _account.status NOT IN ('passed', 'payout_requested', 'payout_under_review', 'payout_approved') THEN
    RETURN jsonb_build_object(
      'eligible', false, 'reason', 'Account status must be passed or in payout flow',
      'reason_code', 'BAD_STATUS',
      'current_status', _account.status, 'payout_window_opened', false
    );
  END IF;

  SELECT COUNT(*) INTO _pending_violations FROM violations WHERE account_id = _account_id AND confirmed_at IS NULL;
  IF _pending_violations > 0 THEN
    RETURN jsonb_build_object('eligible', false, 'reason', 'Account has pending violations',
      'reason_code', 'PENDING_VIOLATIONS',
      'pending_violations', _pending_violations, 'payout_window_opened', true);
  END IF;

  SELECT COUNT(*) INTO _pending_flags FROM flags WHERE account_id = _account_id AND status = 'pending';
  IF _pending_flags > 0 THEN
    RETURN jsonb_build_object('eligible', false, 'reason', 'Account has pending flags',
      'reason_code', 'PENDING_FLAGS',
      'pending_flags', _pending_flags, 'payout_window_opened', true);
  END IF;

  SELECT COUNT(*) INTO _pending_fraud_reviews FROM fraud_reviews
  WHERE entity_type = 'account' AND entity_id = _account_id AND status IN ('pending', 'in_review');
  IF _pending_fraud_reviews > 0 THEN
    RETURN jsonb_build_object('eligible', false, 'reason', 'Account has pending fraud review',
      'reason_code', 'PENDING_FRAUD_REVIEW',
      'pending_fraud_reviews', _pending_fraud_reviews, 'payout_window_opened', true);
  END IF;

  SELECT EXISTS(SELECT 1 FROM payouts WHERE account_id = _account_id AND status = 'paid') INTO _has_prior_payout;
  _cooling_period_days := COALESCE(_cohort.payout_eligibility_delay_days, 7);

  IF NOT _has_prior_payout AND _account.passed_at IS NOT NULL THEN
    _now_ny := (now() AT TIME ZONE 'America/New_York')::date;
    _passed_at_ny := (_account.passed_at AT TIME ZONE 'America/New_York')::date;
    _days_since_pass := (_now_ny - _passed_at_ny);
    _payout_window_opens_at := (_passed_at_ny + _cooling_period_days);
    IF _days_since_pass < _cooling_period_days THEN
      _payout_window_opened := false;
      RETURN jsonb_build_object(
        'eligible', false, 'reason', 'Payout window not yet open',
        'reason_code', 'COOLING_PERIOD',
        'payout_window_opened', false, 'cooling_period_days', _cooling_period_days,
        'days_since_pass', _days_since_pass, 'days_remaining', _cooling_period_days - _days_since_pass,
        'payout_window_opens_at', _payout_window_opens_at, 'passed_at', _account.passed_at,
        'has_prior_payout', false,
        'hint', 'Your payout window opens on ' || to_char(_payout_window_opens_at, 'Mon DD, YYYY')
      );
    END IF;
  END IF;

  SELECT * INTO _last_payout FROM payouts
  WHERE account_id = _account_id AND status = 'paid' ORDER BY paid_at DESC LIMIT 1;

  _required_trading_days := _cohort.min_trading_days_between_payouts;

  IF _last_payout IS NOT NULL THEN
    _days_since_last_payout := (now()::date - _last_payout.paid_at::date);
    IF _days_since_last_payout < _cohort.payout_cooldown_days THEN
      RETURN jsonb_build_object(
        'eligible', false, 'reason', 'Payout cooldown period not met',
        'reason_code', 'COOLDOWN',
        'days_since_last_payout', _days_since_last_payout,
        'required_cooldown_days', _cohort.payout_cooldown_days,
        'days_remaining', _cohort.payout_cooldown_days - _days_since_last_payout,
        'payout_window_opened', true
      );
    END IF;

    SELECT COUNT(DISTINCT (
      (COALESCE(closed_at, opened_at) AT TIME ZONE 'America/New_York' - interval '17 hours')::date
    )) INTO _trading_days_since_payout
    FROM trades WHERE account_id = _account_id AND COALESCE(closed_at, opened_at) > _last_payout.paid_at;

    -- Compute winning days progress fields
    _winning_days_remaining := GREATEST(_required_trading_days - _trading_days_since_payout, 0);
    _winning_days_progress_pct :=
      CASE
        WHEN _required_trading_days <= 0 THEN 100
        ELSE LEAST(100, GREATEST(0, (_trading_days_since_payout::numeric / _required_trading_days) * 100))
      END;

    IF _trading_days_since_payout < _required_trading_days THEN
      RETURN jsonb_build_object(
        'eligible', false, 'reason', 'Not enough trading days since last payout',
        'reason_code', 'MIN_TRADING_DAYS',
        'trading_days_since_payout', _trading_days_since_payout,
        'required_trading_days', _required_trading_days,
        'winning_days_remaining', _winning_days_remaining,
        'winning_days_progress_pct', ROUND(_winning_days_progress_pct, 1),
        'has_prior_payout', _has_prior_payout,
        'payout_window_opened', true,
        'hint', 'You need ' || _winning_days_remaining || ' more trading day(s) before your next payout'
      );
    END IF;
  END IF;

  IF _cohort.entry_fee IS NOT NULL AND _cohort.lifetime_cap_multiple IS NOT NULL THEN
    _lifetime_cap_amount := _cohort.entry_fee * _cohort.lifetime_cap_multiple;
    _lifetime_headroom := _lifetime_cap_amount - _lifetime_paid_total;
    IF _lifetime_headroom < 50 THEN
      RETURN jsonb_build_object(
        'eligible', false, 'reason', 'Lifetime payout cap reached for this tier',
        'reason_code', 'LIFETIME_CAP',
        'lifetime_paid_total', _lifetime_paid_total, 'lifetime_cap_amount', _lifetime_cap_amount,
        'lifetime_headroom', GREATEST(_lifetime_headroom, 0), 'cohort_id', _account.cohort_id,
        'hint', 'You have reached the maximum lifetime payout for this account tier.',
        'payout_window_opened', true
      );
    END IF;
  ELSE
    _lifetime_cap_amount := NULL;
    _lifetime_headroom := NULL;
  END IF;

  _cycle_baseline := COALESCE(_account.payout_cycle_start_balance, _account.starting_balance);
  _cycle_started_at := COALESCE(_account.payout_cycle_started_at, _account.created_at);
  _realized_profit := _account.current_balance - _cycle_baseline;

  SELECT COALESCE(SUM(amount), 0), COUNT(*)
  INTO _paid_since_cycle, _paid_count_since_cycle
  FROM payouts WHERE account_id = _account_id AND status = 'paid' AND paid_at >= _cycle_started_at;

  _realized_profit := _realized_profit - _paid_since_cycle;
  _is_first_payout_in_cycle := (_paid_count_since_cycle = 0);

  IF _realized_profit <= 0 THEN
    _profit_buffer_required := _cohort.min_profit_buffer;
    IF _profit_buffer_required IS NOT NULL AND _has_prior_payout THEN
      _profit_buffer_remaining := GREATEST(_profit_buffer_required - _realized_profit, 0);
      _profit_buffer_met := false;
      _profit_buffer_progress_pct :=
        CASE
          WHEN _profit_buffer_required IS NULL OR _profit_buffer_required <= 0 THEN 100
          ELSE LEAST(100, GREATEST(0, (_realized_profit / _profit_buffer_required) * 100))
        END;
    END IF;
    RETURN jsonb_build_object(
      'eligible', false, 'reason', 'No realized profit available for payout',
      'reason_code', 'NO_PROFIT',
      'realized_profit', _realized_profit, 'cycle_baseline', _cycle_baseline,
      'cycle_started_at', _cycle_started_at, 'paid_since_cycle', _paid_since_cycle,
      'payout_window_opened', true,
      'has_prior_payout', _has_prior_payout,
      'profit_buffer_required', _profit_buffer_required,
      'profit_buffer_remaining', ROUND(COALESCE(_profit_buffer_remaining, 0), 2),
      'profit_buffer_met', _profit_buffer_met,
      'profit_buffer_progress_pct', ROUND(COALESCE(_profit_buffer_progress_pct, 0), 1)
    );
  END IF;

  _profit_buffer_required := _cohort.min_profit_buffer;
  IF _profit_buffer_required IS NOT NULL AND _has_prior_payout THEN
    _profit_buffer_remaining := GREATEST(_profit_buffer_required - _realized_profit, 0);
    _profit_buffer_met := (_realized_profit >= _profit_buffer_required);
    _profit_buffer_progress_pct :=
      CASE
        WHEN _profit_buffer_required IS NULL OR _profit_buffer_required <= 0 THEN 100
        ELSE LEAST(100, GREATEST(0, (_realized_profit / _profit_buffer_required) * 100))
      END;
    IF NOT _profit_buffer_met THEN
      RETURN jsonb_build_object(
        'eligible', false, 'reason', 'Profit buffer not yet met since last payout',
        'reason_code', 'PROFIT_BUFFER',
        'profit_buffer_required', _profit_buffer_required,
        'realized_profit', ROUND(_realized_profit, 2),
        'profit_buffer_remaining', ROUND(_profit_buffer_remaining, 2),
        'profit_buffer_met', false,
        'profit_buffer_progress_pct', ROUND(_profit_buffer_progress_pct, 1),
        'has_prior_payout', _has_prior_payout,
        'payout_window_opened', true,
        'hint', 'You need $' || ROUND(_profit_buffer_remaining, 2) || ' more in profit before your next payout request'
      );
    END IF;
  ELSE
    _profit_buffer_remaining := 0;
    _profit_buffer_progress_pct := 100;
  END IF;

  _eligible_by_split := _realized_profit * (_cohort.payout_split_percent / 100.0);
  _max_eligible := _eligible_by_split * (_cohort.max_payout_percent / 100.0);

  IF _cohort.max_payout_absolute IS NOT NULL THEN
    _max_eligible := LEAST(_max_eligible, _cohort.max_payout_absolute);
  END IF;

  _max_eligible_before_cap := _max_eligible;
  _first_payout_cap := _cohort.first_payout_cap_amount;

  IF _is_first_payout_in_cycle AND _first_payout_cap IS NOT NULL THEN
    _max_eligible := LEAST(_max_eligible, _first_payout_cap);
  END IF;

  IF _lifetime_headroom IS NOT NULL AND _max_eligible > _lifetime_headroom THEN
    _max_eligible := _lifetime_headroom;
    _lifetime_cap_applied := true;
  END IF;

  IF _account.passed_at IS NOT NULL THEN
    _now_ny := (now() AT TIME ZONE 'America/New_York')::date;
    _passed_at_ny := (_account.passed_at AT TIME ZONE 'America/New_York')::date;
    _days_since_pass := (_now_ny - _passed_at_ny);
    _payout_window_opens_at := (_passed_at_ny + _cooling_period_days);
  END IF;

  -- For eligible response: compute winning days progress if has prior payout
  IF _has_prior_payout AND _last_payout IS NOT NULL THEN
    _winning_days_progress_pct := 100;
    _winning_days_remaining := 0;
  END IF;

  RETURN jsonb_build_object(
    'eligible', true,
    'reason_code', 'ELIGIBLE',
    'max_eligible_amount', ROUND(_max_eligible, 2),
    'max_eligible_before_first_cap', ROUND(_max_eligible_before_cap, 2),
    'total_eligible_by_split', ROUND(_eligible_by_split, 2),
    'realized_profit', ROUND(_realized_profit, 2),
    'cycle_baseline', _cycle_baseline,
    'cycle_started_at', _cycle_started_at,
    'paid_since_cycle', _paid_since_cycle,
    'paid_count_since_cycle', _paid_count_since_cycle,
    'is_first_payout_in_cycle', _is_first_payout_in_cycle,
    'first_payout_cap_amount', _first_payout_cap,
    'first_payout_cap_applied', (_is_first_payout_in_cycle AND _first_payout_cap IS NOT NULL AND _max_eligible_before_cap > _first_payout_cap),
    'lifetime_cap_amount', _lifetime_cap_amount,
    'lifetime_paid_total', _lifetime_paid_total,
    'lifetime_headroom', GREATEST(_lifetime_headroom, 0),
    'lifetime_cap_applied', _lifetime_cap_applied,
    'cohort_id', _account.cohort_id,
    'payout_split_percent', _cohort.payout_split_percent,
    'max_payout_percent_of_eligible', _cohort.max_payout_percent,
    'max_payout_absolute', _cohort.max_payout_absolute,
    'account_status', _account.status,
    'days_since_last_payout', _days_since_last_payout,
    'trading_days_since_payout', _trading_days_since_payout,
    'required_trading_days', _required_trading_days,
    'winning_days_remaining', COALESCE(_winning_days_remaining, 0),
    'winning_days_progress_pct', ROUND(COALESCE(_winning_days_progress_pct, 100), 1),
    'kyc_status', _kyc_status,
    'payout_window_opened', true,
    'cooling_period_days', _cooling_period_days,
    'days_since_pass', _days_since_pass,
    'payout_window_opens_at', _payout_window_opens_at,
    'has_prior_payout', _has_prior_payout,
    'profit_buffer_required', _profit_buffer_required,
    'profit_buffer_remaining', ROUND(COALESCE(_profit_buffer_remaining, 0), 2),
    'profit_buffer_met', _profit_buffer_met,
    'profit_buffer_progress_pct', ROUND(COALESCE(_profit_buffer_progress_pct, 100), 1)
  );
END;
$$;
