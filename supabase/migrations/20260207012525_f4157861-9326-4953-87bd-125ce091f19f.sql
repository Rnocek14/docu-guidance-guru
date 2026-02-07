
-- Fix #1: Remove SECURITY DEFINER from check_consistency_rules (let RLS enforce access)
-- Fix #2: Remove dead _total_pnl variable
-- Fix #3: Rename _profit_target_amount for clarity

CREATE OR REPLACE FUNCTION public.check_consistency_rules(_account_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  _rules record;
  _best_day_pnl numeric;
  _profit_target_amount_from_starting_balance numeric;
  _best_day_pct numeric;
  _profitable_days integer;
  _max_cap numeric;
  _min_profitable integer;
  _best_day_cap_met boolean;
  _profitable_days_met boolean;
BEGIN
  -- Load account + rule snapshot
  SELECT
    a.starting_balance,
    (a.rule_snapshot->>'profit_target_percent')::numeric AS profit_target_percent,
    (a.rule_snapshot->>'max_daily_profit_cap_percent')::numeric AS max_daily_profit_cap_percent,
    (a.rule_snapshot->>'min_profitable_days')::integer AS min_profitable_days
  INTO _rules
  FROM accounts a
  WHERE a.id = _account_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'account_not_found');
  END IF;

  _max_cap := COALESCE(_rules.max_daily_profit_cap_percent, 100);
  _min_profitable := COALESCE(_rules.min_profitable_days, 0);

  -- Best single-day net PnL
  SELECT COALESCE(MAX(net_pnl), 0)
  INTO _best_day_pnl
  FROM account_daily_stats
  WHERE account_id = _account_id;

  -- Profit target in dollar terms (from starting balance)
  _profit_target_amount_from_starting_balance := _rules.starting_balance * (_rules.profit_target_percent / 100.0);

  -- Best day as % of profit target
  IF _profit_target_amount_from_starting_balance > 0 THEN
    _best_day_pct := (_best_day_pnl / _profit_target_amount_from_starting_balance) * 100;
  ELSE
    _best_day_pct := 0;
  END IF;

  _best_day_cap_met := (_best_day_pct <= _max_cap);

  -- Count profitable days
  SELECT COUNT(*)
  INTO _profitable_days
  FROM account_daily_stats
  WHERE account_id = _account_id
    AND is_winning_day = true;

  _profitable_days_met := (_profitable_days >= _min_profitable);

  RETURN jsonb_build_object(
    'best_day_pnl', _best_day_pnl,
    'best_day_pct_of_target', ROUND(_best_day_pct, 2),
    'max_daily_profit_cap_percent', _rules.max_daily_profit_cap_percent,
    'best_day_cap_met', _best_day_cap_met,
    'profitable_days', _profitable_days,
    'min_profitable_days', _min_profitable,
    'profitable_days_met', _profitable_days_met,
    'all_consistency_met', (_best_day_cap_met AND _profitable_days_met)
  );
END;
$$;

-- Keep EXECUTE granted to authenticated (RLS now enforces access via SECURITY INVOKER default)
REVOKE ALL ON FUNCTION public.check_consistency_rules(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.check_consistency_rules(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.check_consistency_rules(uuid) TO service_role;
