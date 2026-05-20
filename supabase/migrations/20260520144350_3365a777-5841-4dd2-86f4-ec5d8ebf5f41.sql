-- ─────────────────────────────────────────────────────────────
-- 1. Patch ingest_trade_atomic to write violations + event row
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.ingest_trade_atomic(
  p_account_id uuid, p_platform_trade_id text, p_platform_account_id text,
  p_symbol text, p_side text, p_quantity numeric, p_entry_price numeric,
  p_net_pnl numeric, p_commission numeric, p_opened_at timestamptz,
  p_raw_payload jsonb, p_trading_day date
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
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
  v_existing_viol_id uuid;
BEGIN
  SELECT * INTO v_acct FROM accounts WHERE id = p_account_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ACCOUNT_NOT_FOUND: %', p_account_id; END IF;

  IF v_acct.status IN ('failed_confirmed', 'passed', 'closed') THEN
    RAISE EXCEPTION 'ACCOUNT_TERMINAL: %', v_acct.status;
  END IF;

  IF v_acct.rule_snapshot IS NULL THEN
    RAISE EXCEPTION 'MISSING_RULE_SNAPSHOT: Account % has no rule_snapshot', p_account_id;
  END IF;

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

  v_daily_start := COALESCE(v_acct.daily_pnl_start_balance, v_acct.current_balance);
  IF v_acct.daily_reset_at IS NULL
     OR trading_day_et(now()) <> trading_day_et(v_acct.daily_reset_at) THEN
    v_daily_reset := true;
    v_daily_start := v_acct.current_balance;
  END IF;

  v_new_balance    := v_acct.current_balance + p_net_pnl;
  v_new_total_pnl  := v_acct.total_pnl + p_net_pnl;
  v_new_daily_pnl  := CASE WHEN v_daily_reset THEN p_net_pnl ELSE v_acct.daily_pnl + p_net_pnl END;
  v_new_highest    := GREATEST(v_acct.highest_balance, v_new_balance);

  v_max_daily_loss_pct := COALESCE((v_acct.rule_snapshot->>'max_daily_loss_percent')::numeric, 5);
  v_max_drawdown_pct   := COALESCE((v_acct.rule_snapshot->>'max_total_drawdown_percent')::numeric, 10);
  v_new_status := v_acct.status::text;

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

  -- ── NEW: persist breach evidence ──────────────────────────
  IF v_breach_type IS NOT NULL THEN
    -- Only insert if no open (unconfirmed) violation of same rule_type already exists
    SELECT id INTO v_existing_viol_id
      FROM violations
      WHERE account_id = p_account_id
        AND rule_type = v_breach_type
        AND confirmed_at IS NULL
      LIMIT 1;

    IF v_existing_viol_id IS NULL THEN
      INSERT INTO violations (
        account_id, rule_type, rule_threshold, actual_value,
        description, detected_at, trade_id, platform_trade_id, breach_day
      ) VALUES (
        p_account_id, v_breach_type, v_breach_threshold, v_breach_actual,
        v_breach_desc, now(), v_trade_id, p_platform_trade_id, p_trading_day
      );

      -- Append an account event for the timeline (best-effort, never fail the trade)
      BEGIN
        INSERT INTO account_events (account_id, event_type, event_data, idempotency_key)
        VALUES (
          p_account_id,
          'breach_detected',
          jsonb_build_object(
            'rule_type', v_breach_type,
            'actual_value', v_breach_actual,
            'rule_threshold', v_breach_threshold,
            'description', v_breach_desc,
            'trade_id', v_trade_id
          ),
          'breach:' || p_account_id::text || ':' || v_breach_type || ':' || COALESCE(p_platform_trade_id, v_trade_id::text)
        );
      EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'breach event insert failed: %', SQLERRM;
      END;
    END IF;
  END IF;

  BEGIN
    PERFORM upsert_daily_stat(p_account_id, p_trading_day, p_net_pnl, p_commission);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'upsert_daily_stat failed: %', SQLERRM;
  END;

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
$function$;

-- ─────────────────────────────────────────────────────────────
-- 2. One-time backfill for breached_detected accounts missing
--    an open violation row. Infer rule_type from balances.
-- ─────────────────────────────────────────────────────────────
INSERT INTO violations (account_id, rule_type, rule_threshold, actual_value, description, detected_at)
SELECT
  a.id,
  inferred.rule_type,
  inferred.threshold,
  round(inferred.actual, 4),
  format('%s limit exceeded: %s%% (limit: %s%%) — backfilled from account state',
         inferred.rule_type, round(inferred.actual, 2), inferred.threshold),
  COALESCE(a.updated_at, now())
FROM accounts a
CROSS JOIN LATERAL (
  SELECT
    CASE
      WHEN ((a.starting_balance - a.current_balance) / NULLIF(a.starting_balance, 0)) * 100
           >= COALESCE((a.rule_snapshot->>'max_total_drawdown_percent')::numeric, 10)
        THEN 'max_total_drawdown'
      WHEN a.daily_pnl < 0
       AND (abs(a.daily_pnl) / NULLIF(COALESCE(a.daily_pnl_start_balance, a.starting_balance), 0)) * 100
           >= COALESCE((a.rule_snapshot->>'max_daily_loss_percent')::numeric, 5)
        THEN 'max_daily_loss'
      ELSE NULL
    END AS rule_type,
    CASE
      WHEN ((a.starting_balance - a.current_balance) / NULLIF(a.starting_balance, 0)) * 100
           >= COALESCE((a.rule_snapshot->>'max_total_drawdown_percent')::numeric, 10)
        THEN ((a.starting_balance - a.current_balance) / NULLIF(a.starting_balance, 0)) * 100
      ELSE (abs(a.daily_pnl) / NULLIF(COALESCE(a.daily_pnl_start_balance, a.starting_balance), 0)) * 100
    END AS actual,
    CASE
      WHEN ((a.starting_balance - a.current_balance) / NULLIF(a.starting_balance, 0)) * 100
           >= COALESCE((a.rule_snapshot->>'max_total_drawdown_percent')::numeric, 10)
        THEN COALESCE((a.rule_snapshot->>'max_total_drawdown_percent')::numeric, 10)
      ELSE COALESCE((a.rule_snapshot->>'max_daily_loss_percent')::numeric, 5)
    END AS threshold
) inferred
WHERE a.status = 'breached_detected'
  AND a.rule_snapshot IS NOT NULL
  AND inferred.rule_type IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM violations v
    WHERE v.account_id = a.id AND v.confirmed_at IS NULL
  );