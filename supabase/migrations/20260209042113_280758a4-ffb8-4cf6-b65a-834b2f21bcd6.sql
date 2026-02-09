
-- ============================================================
-- P0 PATCH: Atomic trade ingestion + Internal secrets table
-- ============================================================

-- 1. DST-safe trading day helper (Postgres AT TIME ZONE is DST-aware)
CREATE OR REPLACE FUNCTION public.trading_day_et(
  ts timestamptz,
  reset_hour int DEFAULT 17
)
RETURNS date
LANGUAGE sql STABLE
AS $$
  SELECT CASE 
    WHEN EXTRACT(HOUR FROM ts AT TIME ZONE 'America/New_York') < reset_hour 
    THEN (ts AT TIME ZONE 'America/New_York')::date - 1
    ELSE (ts AT TIME ZONE 'America/New_York')::date
  END;
$$;

-- 2. Atomic trade ingestion RPC
-- Wraps: lock account → insert trade → compute metrics → breach detect → update account
-- Eliminates the non-atomic gap where trade INSERT succeeds but account UPDATE fails
CREATE OR REPLACE FUNCTION public.ingest_trade_atomic(
  p_account_id uuid,
  p_platform_trade_id text,
  p_platform_account_id text,
  p_symbol text,
  p_side text,
  p_quantity numeric,
  p_entry_price numeric,
  p_net_pnl numeric,
  p_commission numeric,
  p_opened_at timestamptz,
  p_raw_payload jsonb,
  p_trading_day date
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_acct RECORD;
  v_trade_id uuid;
  v_new_balance numeric;
  v_new_total_pnl numeric;
  v_new_daily_pnl numeric;
  v_new_highest numeric;
  v_daily_start numeric;
  v_daily_reset boolean := false;
  v_breach_type text := null;
  v_breach_actual numeric;
  v_breach_threshold numeric;
  v_breach_desc text;
  v_new_status text;
  v_max_daily_loss_pct numeric;
  v_max_drawdown_pct numeric;
  v_daily_loss_pct numeric;
  v_drawdown_pct numeric;
BEGIN
  -- ── 1. Lock account row ────────────────────────────────────
  SELECT * INTO v_acct FROM accounts WHERE id = p_account_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ACCOUNT_NOT_FOUND: %', p_account_id;
  END IF;

  -- Terminal state guard
  IF v_acct.status IN ('failed_confirmed', 'passed', 'closed') THEN
    RAISE EXCEPTION 'ACCOUNT_TERMINAL: %', v_acct.status;
  END IF;

  -- Rule snapshot guard (fail-closed)
  IF v_acct.rule_snapshot IS NULL THEN
    RAISE EXCEPTION 'MISSING_RULE_SNAPSHOT: Account % has no rule_snapshot', p_account_id;
  END IF;

  -- ── 2. Insert trade (idempotent via unique constraint) ─────
  BEGIN
    INSERT INTO trades (
      account_id, platform_trade_id, platform_account_id,
      symbol, side, quantity, entry_price,
      pnl, commission, opened_at, status, raw_payload
    ) VALUES (
      p_account_id, p_platform_trade_id, p_platform_account_id,
      p_symbol, p_side, p_quantity, p_entry_price,
      p_net_pnl, p_commission, p_opened_at, 'closed', p_raw_payload
    ) RETURNING id INTO v_trade_id;
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('duplicate', true);
  END;

  -- ── 3. Daily reset check (DST-safe) ───────────────────────
  v_daily_start := COALESCE(v_acct.daily_pnl_start_balance, v_acct.current_balance);

  IF v_acct.daily_reset_at IS NULL
     OR trading_day_et(now()) <> trading_day_et(v_acct.daily_reset_at) THEN
    v_daily_reset := true;
    v_daily_start := v_acct.current_balance;
  END IF;

  -- ── 4. Compute new metrics ────────────────────────────────
  v_new_balance    := v_acct.current_balance + p_net_pnl;
  v_new_total_pnl  := v_acct.total_pnl + p_net_pnl;
  v_new_daily_pnl  := CASE WHEN v_daily_reset THEN p_net_pnl
                            ELSE v_acct.daily_pnl + p_net_pnl END;
  v_new_highest    := GREATEST(v_acct.highest_balance, v_new_balance);

  -- ── 5. Breach detection (rule_snapshot) ───────────────────
  v_max_daily_loss_pct := COALESCE((v_acct.rule_snapshot->>'max_daily_loss_percent')::numeric, 5);
  v_max_drawdown_pct   := COALESCE((v_acct.rule_snapshot->>'max_total_drawdown_percent')::numeric, 10);
  v_new_status := v_acct.status::text;

  -- Daily loss check
  IF v_new_daily_pnl < 0 AND NULLIF(v_daily_start, 0) IS NOT NULL THEN
    v_daily_loss_pct := (abs(v_new_daily_pnl) / v_daily_start) * 100;
    IF v_daily_loss_pct >= v_max_daily_loss_pct THEN
      v_breach_type      := 'max_daily_loss';
      v_breach_actual    := round(v_daily_loss_pct, 4);
      v_breach_threshold := v_max_daily_loss_pct;
      v_breach_desc      := format('Daily loss limit exceeded: %s%% (limit: %s%%)',
                                   round(v_daily_loss_pct, 2), v_max_daily_loss_pct);
      v_new_status := 'breached_detected';
    END IF;
  END IF;

  -- Total drawdown check
  IF v_breach_type IS NULL AND v_new_balance < v_acct.starting_balance THEN
    v_drawdown_pct := ((v_acct.starting_balance - v_new_balance) / v_acct.starting_balance) * 100;
    IF v_drawdown_pct >= v_max_drawdown_pct THEN
      v_breach_type      := 'max_total_drawdown';
      v_breach_actual    := round(v_drawdown_pct, 4);
      v_breach_threshold := v_max_drawdown_pct;
      v_breach_desc      := format('Total drawdown limit exceeded: %s%% (limit: %s%%)',
                                   round(v_drawdown_pct, 2), v_max_drawdown_pct);
      v_new_status := 'breached_detected';
    END IF;
  END IF;

  -- ── 6. Atomic account update ──────────────────────────────
  UPDATE accounts SET
    current_balance        = v_new_balance,
    total_pnl              = v_new_total_pnl,
    daily_pnl              = v_new_daily_pnl,
    highest_balance        = v_new_highest,
    daily_pnl_start_balance = v_daily_start,
    daily_reset_at         = CASE WHEN v_daily_reset THEN now() ELSE daily_reset_at END,
    last_trade_at          = p_opened_at,
    status                 = v_new_status::account_status,
    updated_at             = now()
  WHERE id = p_account_id;

  -- ── 7. Upsert daily stats (non-fatal) ─────────────────────
  BEGIN
    PERFORM upsert_daily_stat(p_account_id, p_trading_day, p_net_pnl, p_commission);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'upsert_daily_stat failed: %', SQLERRM;
  END;

  -- ── 8. Return comprehensive result ────────────────────────
  RETURN jsonb_build_object(
    'duplicate',               false,
    'trade_id',                v_trade_id,
    'new_balance',             v_new_balance,
    'new_total_pnl',           v_new_total_pnl,
    'new_daily_pnl',           v_new_daily_pnl,
    'new_highest_balance',     v_new_highest,
    'daily_reset_occurred',    v_daily_reset,
    'daily_pnl_start_balance', v_daily_start,
    'starting_balance',        v_acct.starting_balance,
    'previous_status',         v_acct.status,
    'new_status',              v_new_status,
    'trading_days_count',      v_acct.trading_days_count,
    'rule_snapshot',           v_acct.rule_snapshot,
    'user_id',                 v_acct.user_id,
    'breach_detected',         v_breach_type IS NOT NULL,
    'breach_type',             v_breach_type,
    'breach_actual',           v_breach_actual,
    'breach_threshold',        v_breach_threshold,
    'breach_description',      v_breach_desc
  );
END;
$$;

-- Permissions: service_role only (edge function calls this)
REVOKE EXECUTE ON FUNCTION public.ingest_trade_atomic FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.ingest_trade_atomic FROM authenticated;
GRANT EXECUTE ON FUNCTION public.ingest_trade_atomic TO service_role;

REVOKE EXECUTE ON FUNCTION public.trading_day_et FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.trading_day_et TO service_role;
GRANT EXECUTE ON FUNCTION public.trading_day_et TO authenticated;

-- ============================================================
-- 3. Internal secrets table (cron secret rotation)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.internal_secrets (
  key text PRIMARY KEY,
  value text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.internal_secrets ENABLE ROW LEVEL SECURITY;

-- Deny ALL client access; service_role and postgres bypass RLS
CREATE POLICY "deny_all_client_access" ON public.internal_secrets
  FOR ALL USING (false) WITH CHECK (false);

COMMENT ON TABLE public.internal_secrets IS 
  'Runtime secrets for cron jobs. Only accessible by service_role and postgres (RLS bypass). Never expose via API.';
