
-- ============================================================
-- B2: Chargeback / Dispute Rate Monitoring System
-- RPC + supporting indexes for processor threshold defense
-- ============================================================

-- 1. Performance indexes for the ratio query
CREATE INDEX IF NOT EXISTS idx_payment_txn_inbound_created
  ON public.payment_transactions (created_at DESC)
  WHERE direction = 'inbound' AND status IN ('completed', 'refunded');

CREATE INDEX IF NOT EXISTS idx_chargeback_events_created
  ON public.chargeback_events (created_at DESC);

-- 2. RPC: get_dispute_rate_snapshot
-- Returns rolling dispute ratio + alert level for processor threshold monitoring.
-- Uses SECURITY DEFINER so staff can see cross-user aggregates.
-- Alert thresholds (dispute_rate_percent):
--   < 0.20%  = ok
--   >= 0.20% = warn
--   >= 0.30% = high       (Visa VAMP non-compliant territory)
--   >= 0.40% = severe     (add friction, freeze riskier traffic)
--   >= 0.50% = emergency  (auto-pause inbound payments)
CREATE OR REPLACE FUNCTION public.get_dispute_rate_snapshot(window_days integer DEFAULT 30)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result jsonb;
  w_start timestamptz;
  w_end timestamptz;
  pay_count bigint;
  dispute_count bigint;
  pay_amount numeric;
  dispute_amount numeric;
  ratio numeric;
  disputes_won bigint;
  disputes_lost bigint;
  disputes_pending bigint;
BEGIN
  w_start := now() - (window_days || ' days')::interval;
  w_end := now();

  -- Count successful inbound payments in window
  -- Include refunded because they were processed charges (count in denominator)
  SELECT COUNT(*), COALESCE(SUM(amount), 0)
  INTO pay_count, pay_amount
  FROM payment_transactions
  WHERE direction = 'inbound'
    AND status IN ('completed', 'refunded')
    AND created_at >= w_start
    AND created_at <= w_end;

  -- Count all disputes opened in window
  SELECT COUNT(*), COALESCE(SUM(amount), 0)
  INTO dispute_count, dispute_amount
  FROM chargeback_events
  WHERE created_at >= w_start
    AND created_at <= w_end;

  -- Dispute outcome breakdown
  SELECT
    COUNT(*) FILTER (WHERE stage = 'won'),
    COUNT(*) FILTER (WHERE stage = 'lost'),
    COUNT(*) FILTER (WHERE stage NOT IN ('won', 'lost'))
  INTO disputes_won, disputes_lost, disputes_pending
  FROM chargeback_events
  WHERE created_at >= w_start
    AND created_at <= w_end;

  -- Calculate ratio as percentage (e.g., 0.35 = 0.35%)
  IF pay_count > 0 THEN
    ratio := ROUND((dispute_count::numeric / pay_count::numeric) * 100, 4);
  ELSE
    ratio := 0;
  END IF;

  result := jsonb_build_object(
    'window_days', window_days,
    'window_start', w_start,
    'window_end', w_end,
    'payments_count', pay_count,
    'payments_amount', pay_amount,
    'disputes_count', dispute_count,
    'disputes_amount', dispute_amount,
    'disputes_won', disputes_won,
    'disputes_lost', disputes_lost,
    'disputes_pending', disputes_pending,
    'dispute_rate_percent', ratio,
    'alert_level', CASE
      WHEN ratio >= 0.50 THEN 'emergency'
      WHEN ratio >= 0.40 THEN 'severe'
      WHEN ratio >= 0.30 THEN 'high'
      WHEN ratio >= 0.20 THEN 'warn'
      ELSE 'ok'
    END,
    'thresholds', jsonb_build_object(
      'warn', 0.20,
      'high', 0.30,
      'severe', 0.40,
      'emergency', 0.50
    ),
    'calculated_at', now()
  );

  RETURN result;
END;
$$;

-- Grant to authenticated (admin/risk dashboards) and service_role (cron edge functions)
GRANT EXECUTE ON FUNCTION public.get_dispute_rate_snapshot(integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_dispute_rate_snapshot(integer) TO service_role;
