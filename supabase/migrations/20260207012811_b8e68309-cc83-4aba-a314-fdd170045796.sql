
-- Tweak A: Treat null cap as "rule disabled" instead of defaulting to 100
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

  _max_cap := _rules.max_daily_profit_cap_percent;  -- NULL means disabled
  _min_profitable := COALESCE(_rules.min_profitable_days, 0);

  -- Best single-day net PnL
  SELECT COALESCE(MAX(net_pnl), 0)
  INTO _best_day_pnl
  FROM account_daily_stats
  WHERE account_id = _account_id;

  _profit_target_amount_from_starting_balance := _rules.starting_balance * (_rules.profit_target_percent / 100.0);

  IF _profit_target_amount_from_starting_balance > 0 THEN
    _best_day_pct := (_best_day_pnl / _profit_target_amount_from_starting_balance) * 100;
  ELSE
    _best_day_pct := 0;
  END IF;

  -- NULL cap = rule disabled = always met
  IF _max_cap IS NULL THEN
    _best_day_cap_met := true;
  ELSE
    _best_day_cap_met := (_best_day_pct <= _max_cap);
  END IF;

  SELECT COUNT(*)
  INTO _profitable_days
  FROM account_daily_stats
  WHERE account_id = _account_id
    AND is_winning_day = true;

  _profitable_days_met := (_profitable_days >= _min_profitable);

  RETURN jsonb_build_object(
    'best_day_pnl', _best_day_pnl,
    'best_day_pct_of_target', ROUND(_best_day_pct, 2),
    'max_daily_profit_cap_percent', _max_cap,
    'best_day_cap_met', _best_day_cap_met,
    'profitable_days', _profitable_days,
    'min_profitable_days', _min_profitable,
    'profitable_days_met', _profitable_days_met,
    'all_consistency_met', (_best_day_cap_met AND _profitable_days_met)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.check_consistency_rules(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.check_consistency_rules(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.check_consistency_rules(uuid) TO service_role;
