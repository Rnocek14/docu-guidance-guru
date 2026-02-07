
-- =============================================
-- 1. account_daily_stats table
-- =============================================
CREATE TABLE public.account_daily_stats (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id),
  trading_day date NOT NULL,
  net_pnl numeric NOT NULL DEFAULT 0,
  gross_pnl numeric NOT NULL DEFAULT 0,
  commissions numeric NOT NULL DEFAULT 0,
  trade_count integer NOT NULL DEFAULT 0,
  winning_trades integer NOT NULL DEFAULT 0,
  losing_trades integer NOT NULL DEFAULT 0,
  is_winning_day boolean NOT NULL GENERATED ALWAYS AS (net_pnl > 0) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One row per account per trading day
CREATE UNIQUE INDEX account_daily_stats_unique
  ON account_daily_stats(account_id, trading_day);

-- Fast lookups for consistency checks
CREATE INDEX account_daily_stats_account_id_idx
  ON account_daily_stats(account_id);

-- Enable RLS
ALTER TABLE public.account_daily_stats ENABLE ROW LEVEL SECURITY;

-- Traders can view own stats
CREATE POLICY "Traders can view own daily stats"
  ON public.account_daily_stats FOR SELECT
  USING (account_id IN (
    SELECT id FROM accounts WHERE user_id = auth.uid()
  ));

-- Staff can view all stats
CREATE POLICY "Staff can view all daily stats"
  ON public.account_daily_stats FOR SELECT
  USING (has_any_role(auth.uid(), ARRAY['risk_officer'::app_role, 'support'::app_role, 'admin'::app_role]));

-- No client writes (service role only via edge functions)
CREATE POLICY "No client inserts on daily stats"
  ON public.account_daily_stats FOR INSERT
  WITH CHECK (false);

CREATE POLICY "No client updates on daily stats"
  ON public.account_daily_stats FOR UPDATE
  USING (false);

CREATE POLICY "No client deletes on daily stats"
  ON public.account_daily_stats FOR DELETE
  USING (false);

-- =============================================
-- 2. Consistency rule columns on cohorts
-- =============================================
ALTER TABLE public.cohorts
  ADD COLUMN max_daily_profit_cap_percent numeric DEFAULT NULL,
  ADD COLUMN min_profitable_days integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.cohorts.max_daily_profit_cap_percent IS 'Best-day cap: max % of profit target any single day can contribute (e.g. 40)';
COMMENT ON COLUMN public.cohorts.min_profitable_days IS 'Minimum profitable trading days required for pass eligibility';

-- =============================================
-- 3. Upsert daily stats RPC (service_role only)
-- =============================================
CREATE OR REPLACE FUNCTION public.upsert_daily_stat(
  _account_id uuid,
  _trading_day date,
  _pnl numeric,
  _commission numeric
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO account_daily_stats (account_id, trading_day, net_pnl, gross_pnl, commissions, trade_count, winning_trades, losing_trades)
  VALUES (
    _account_id,
    _trading_day,
    _pnl,
    _pnl + _commission,
    _commission,
    1,
    CASE WHEN _pnl > 0 THEN 1 ELSE 0 END,
    CASE WHEN _pnl < 0 THEN 1 ELSE 0 END
  )
  ON CONFLICT (account_id, trading_day) DO UPDATE SET
    net_pnl = account_daily_stats.net_pnl + EXCLUDED.net_pnl,
    gross_pnl = account_daily_stats.gross_pnl + EXCLUDED.gross_pnl,
    commissions = account_daily_stats.commissions + EXCLUDED.commissions,
    trade_count = account_daily_stats.trade_count + 1,
    winning_trades = account_daily_stats.winning_trades + EXCLUDED.winning_trades,
    losing_trades = account_daily_stats.losing_trades + EXCLUDED.losing_trades,
    updated_at = now();
END;
$$;

-- Service role only
REVOKE EXECUTE ON FUNCTION public.upsert_daily_stat FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.upsert_daily_stat TO service_role;

-- =============================================
-- 4. Consistency check RPC (used by pass eligibility)
-- =============================================
CREATE OR REPLACE FUNCTION public.check_consistency_rules(
  _account_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _account RECORD;
  _cohort RECORD;
  _rules RECORD;
  _best_day_pnl numeric;
  _profit_target_amount numeric;
  _best_day_pct numeric;
  _profitable_days integer;
  _total_pnl numeric;
  _result jsonb;
BEGIN
  -- Load account + cohort
  SELECT a.*, c.max_daily_profit_cap_percent, c.min_profitable_days,
         c.profit_target_percent, c.cohort_phase
  INTO _rules
  FROM accounts a
  JOIN cohorts c ON c.id = a.cohort_id
  WHERE a.id = _account_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'account_not_found');
  END IF;

  -- Get best single day PnL
  SELECT COALESCE(MAX(net_pnl), 0)
  INTO _best_day_pnl
  FROM account_daily_stats
  WHERE account_id = _account_id;

  -- Count profitable days (net_pnl > 0)
  SELECT COUNT(*)
  INTO _profitable_days
  FROM account_daily_stats
  WHERE account_id = _account_id AND net_pnl > 0;

  -- Total PnL from account
  _total_pnl := _rules.total_pnl;
  _profit_target_amount := _rules.starting_balance * (_rules.profit_target_percent / 100.0);

  -- Best day as % of profit target
  _best_day_pct := CASE WHEN _profit_target_amount > 0
    THEN (_best_day_pnl / _profit_target_amount) * 100
    ELSE 0 END;

  -- Build result
  _result := jsonb_build_object(
    'best_day_pnl', _best_day_pnl,
    'best_day_pct_of_target', round(_best_day_pct, 2),
    'max_daily_profit_cap_percent', _rules.max_daily_profit_cap_percent,
    'best_day_cap_met', CASE
      WHEN _rules.max_daily_profit_cap_percent IS NULL THEN true
      WHEN _best_day_pct <= _rules.max_daily_profit_cap_percent THEN true
      ELSE false END,
    'profitable_days', _profitable_days,
    'min_profitable_days', _rules.min_profitable_days,
    'profitable_days_met', (_profitable_days >= _rules.min_profitable_days),
    'all_consistency_met', (
      (_rules.max_daily_profit_cap_percent IS NULL OR _best_day_pct <= _rules.max_daily_profit_cap_percent)
      AND (_profitable_days >= _rules.min_profitable_days)
    )
  );

  RETURN _result;
END;
$$;

-- Allow authenticated (for UI display) and service_role
REVOKE EXECUTE ON FUNCTION public.check_consistency_rules FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.check_consistency_rules TO authenticated;
GRANT EXECUTE ON FUNCTION public.check_consistency_rules TO service_role;
