
-- ============================================================
-- PHASE 2: Pass-rate kill switch — automatic monitoring
-- ============================================================

-- Table to track rolling pass-rate metrics and auto-responses
CREATE TABLE public.pass_rate_monitors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  window_start date NOT NULL,
  window_end date NOT NULL,
  total_accounts integer NOT NULL DEFAULT 0,
  passed_accounts integer NOT NULL DEFAULT 0,
  pass_rate numeric NOT NULL DEFAULT 0,
  triggered_action text, -- null if no action taken
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.pass_rate_monitors ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can view pass rate monitors"
  ON public.pass_rate_monitors FOR SELECT
  USING (has_any_role(auth.uid(), ARRAY['risk_officer'::app_role, 'admin'::app_role]));

CREATE POLICY "No client inserts on pass_rate_monitors"
  ON public.pass_rate_monitors FOR INSERT
  WITH CHECK (false);

CREATE POLICY "No client updates on pass_rate_monitors"
  ON public.pass_rate_monitors FOR UPDATE
  USING (false);

CREATE POLICY "No client deletes on pass_rate_monitors"
  ON public.pass_rate_monitors FOR DELETE
  USING (false);

-- ============================================================
-- PHASE 3: Cross-instrument correlation groups
-- ============================================================

-- Correlation group definitions for related instruments
CREATE TABLE public.instrument_correlation_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_name text NOT NULL,
  symbols text[] NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  is_active boolean NOT NULL DEFAULT true
);

ALTER TABLE public.instrument_correlation_groups ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can view correlation groups"
  ON public.instrument_correlation_groups FOR SELECT
  USING (has_any_role(auth.uid(), ARRAY['risk_officer'::app_role, 'admin'::app_role]));

CREATE POLICY "Admins can manage correlation groups"
  ON public.instrument_correlation_groups FOR ALL
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

-- Seed default correlation groups (equity index, energy, metals)
INSERT INTO public.instrument_correlation_groups (group_name, symbols) VALUES
  ('Equity Index Futures', ARRAY['ES', 'NQ', 'YM', 'RTY', 'MES', 'MNQ', 'MYM', 'M2K']),
  ('Energy Futures', ARRAY['CL', 'BZ', 'MCL', 'QM', 'NG', 'QG']),
  ('Metals Futures', ARRAY['GC', 'SI', 'MGC', 'SIL', 'HG', 'PL']),
  ('Treasury Futures', ARRAY['ZB', 'ZN', 'ZF', 'ZT', 'UB']),
  ('Currency Futures', ARRAY['6E', '6J', '6B', '6A', '6C', '6S']);

-- Enhanced correlation detection RPC that checks cross-instrument hedging
CREATE OR REPLACE FUNCTION public.detect_cross_instrument_correlations(
  _account_id uuid,
  _time_window_seconds integer DEFAULT 120,
  _min_match_count integer DEFAULT 2
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _user_id uuid;
  _correlations jsonb := '[]'::jsonb;
  _rec record;
BEGIN
  -- Get account owner
  SELECT user_id INTO _user_id FROM accounts WHERE id = _account_id;
  IF _user_id IS NULL THEN
    RETURN jsonb_build_object('has_correlations', false, 'correlation_count', 0, 'correlations', '[]'::jsonb, 'error', 'account_not_found');
  END IF;

  -- Find trades from OTHER users' accounts where:
  -- 1. The symbol is in the same correlation group as our account's trades
  -- 2. The trades are within the time window
  -- 3. The positions are opposing (hedging)
  FOR _rec IN
    WITH my_trades AS (
      SELECT t.symbol, t.side, t.opened_at, t.account_id
      FROM trades t
      WHERE t.account_id = _account_id
        AND t.status = 'closed'
        AND t.opened_at > now() - interval '90 days'
    ),
    -- Normalize symbols to their correlation group
    my_groups AS (
      SELECT DISTINCT g.id AS group_id, g.group_name, mt.symbol, mt.side, mt.opened_at
      FROM my_trades mt
      JOIN instrument_correlation_groups g ON mt.symbol = ANY(g.symbols) AND g.is_active = true
    ),
    -- Find other accounts' trades in the same groups within time window
    cross_matches AS (
      SELECT 
        mg.group_name,
        mg.symbol AS my_symbol,
        mg.side AS my_side,
        t2.symbol AS other_symbol,
        t2.side AS other_side,
        t2.account_id AS other_account_id,
        a2.account_number AS other_account_number,
        ABS(EXTRACT(EPOCH FROM (t2.opened_at - mg.opened_at))) AS time_delta_seconds
      FROM my_groups mg
      JOIN instrument_correlation_groups g2 ON g2.id = mg.group_id
      JOIN trades t2 ON t2.symbol = ANY(g2.symbols)
        AND t2.status = 'closed'
        AND ABS(EXTRACT(EPOCH FROM (t2.opened_at - mg.opened_at))) <= _time_window_seconds
      JOIN accounts a2 ON a2.id = t2.account_id
      WHERE a2.user_id != _user_id
        AND t2.account_id != _account_id
        -- Opposing sides = hedging across instruments
        AND t2.side != mg.side
        -- Different symbols (same-symbol is caught by existing detect_trade_correlations)
        AND t2.symbol != mg.symbol
    )
    SELECT 
      other_account_id,
      other_account_number,
      group_name,
      COUNT(*) AS match_count,
      jsonb_agg(jsonb_build_object(
        'my_symbol', my_symbol, 'my_side', my_side,
        'other_symbol', other_symbol, 'other_side', other_side,
        'time_delta_seconds', ROUND(time_delta_seconds::numeric, 1)
      ) ORDER BY time_delta_seconds) AS sample_trades
    FROM cross_matches
    GROUP BY other_account_id, other_account_number, group_name
    HAVING COUNT(*) >= _min_match_count
    ORDER BY COUNT(*) DESC
    LIMIT 20
  LOOP
    _correlations := _correlations || jsonb_build_object(
      'other_account_id', _rec.other_account_id,
      'other_account_number', _rec.other_account_number,
      'group_name', _rec.group_name,
      'match_count', _rec.match_count,
      'correlation_type', 'cross_instrument_hedge',
      'sample_trades', _rec.sample_trades
    );
  END LOOP;

  RETURN jsonb_build_object(
    'has_correlations', jsonb_array_length(_correlations) > 0,
    'correlation_count', jsonb_array_length(_correlations),
    'correlations', _correlations
  );
END;
$$;

-- Restrict execution to service_role only (called from edge functions)
REVOKE EXECUTE ON FUNCTION public.detect_cross_instrument_correlations FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.detect_cross_instrument_correlations TO service_role;

-- ============================================================
-- Pass-rate monitoring RPC
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_rolling_pass_rate(_window_days integer DEFAULT 30)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _total integer;
  _passed integer;
  _rate numeric;
BEGIN
  SELECT COUNT(*) INTO _total
  FROM accounts
  WHERE created_at >= now() - (_window_days || ' days')::interval;

  SELECT COUNT(*) INTO _passed
  FROM accounts
  WHERE created_at >= now() - (_window_days || ' days')::interval
    AND passed_at IS NOT NULL;

  IF _total = 0 THEN
    _rate := 0;
  ELSE
    _rate := ROUND(_passed::numeric / _total::numeric, 4);
  END IF;

  RETURN jsonb_build_object(
    'window_days', _window_days,
    'total_accounts', _total,
    'passed_accounts', _passed,
    'pass_rate', _rate,
    'alert_level', CASE
      WHEN _rate > 0.18 THEN 'critical'
      WHEN _rate > 0.17 THEN 'high'
      WHEN _rate > 0.16 THEN 'elevated'
      WHEN _rate > 0.15 THEN 'warning'
      ELSE 'normal'
    END
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.get_rolling_pass_rate FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_rolling_pass_rate TO service_role;
GRANT EXECUTE ON FUNCTION public.get_rolling_pass_rate TO authenticated;
