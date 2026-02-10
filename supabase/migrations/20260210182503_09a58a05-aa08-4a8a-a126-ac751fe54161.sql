
-- Seed mock trading data for rnocek14@gmail.com (user_id: 65c43a0a-7182-448f-9753-ed9818030602)
DO $$
DECLARE
  v_user_id uuid := '65c43a0a-7182-448f-9753-ed9818030602';
  v_cohort_id uuid := '30c85b00-c613-4d33-83e5-c5af8a8ea6d5';
  v_account_id uuid := 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
  v_now timestamptz := now();
BEGIN

INSERT INTO public.accounts (
  id, user_id, cohort_id, account_number, status, phase_index,
  starting_balance, current_balance, highest_balance, total_pnl,
  daily_pnl, daily_pnl_start_balance, daily_reset_at,
  trading_days_count, last_trade_at,
  rule_snapshot, created_at, updated_at
) VALUES (
  v_account_id, v_user_id, v_cohort_id, 'SC-100K-0001', 'active', 0,
  100000, 107450, 108200, 7450,
  320, 107130, (v_now - interval '2 hours'),
  12, v_now,
  jsonb_build_object(
    'profit_target_percent', 10, 'max_daily_loss_percent', 5,
    'max_total_drawdown_percent', 10, 'min_trading_days', 5,
    'max_position_size_percent', 20, 'payout_split_percent', 80,
    'max_payout_percent', 5, 'payout_cooldown_days', 14,
    'min_trading_days_between_payouts', 5, 'min_profitable_days', 3,
    'payout_eligibility_delay_days', 14
  ),
  v_now - interval '21 days', v_now
);

-- Day 1 (21 days ago)
INSERT INTO public.trades (account_id, symbol, side, quantity, entry_price, exit_price, pnl, commission, opened_at, closed_at, status, platform_trade_id) VALUES
  (v_account_id, 'ES', 'buy', 2, 5425.50, 5432.75, 725.00, 9.40, v_now - interval '21 days' + interval '9h', v_now - interval '21 days' + interval '10h15m', 'closed', 'TV-001'),
  (v_account_id, 'NQ', 'sell', 1, 18950.00, 18925.50, 490.00, 4.70, v_now - interval '21 days' + interval '11h', v_now - interval '21 days' + interval '12h30m', 'closed', 'TV-002');

-- Day 2 (20 days ago)
INSERT INTO public.trades (account_id, symbol, side, quantity, entry_price, exit_price, pnl, commission, opened_at, closed_at, status, platform_trade_id) VALUES
  (v_account_id, 'CL', 'buy', 3, 72.45, 72.80, 1050.00, 7.05, v_now - interval '20 days' + interval '9h30m', v_now - interval '20 days' + interval '11h', 'closed', 'TV-003'),
  (v_account_id, 'ES', 'sell', 1, 5440.00, 5445.25, -262.50, 4.70, v_now - interval '20 days' + interval '13h', v_now - interval '20 days' + interval '14h', 'closed', 'TV-004');

-- Day 3 (19 days ago)
INSERT INTO public.trades (account_id, symbol, side, quantity, entry_price, exit_price, pnl, commission, opened_at, closed_at, status, platform_trade_id) VALUES
  (v_account_id, 'ES', 'buy', 2, 5438.25, 5444.00, 575.00, 9.40, v_now - interval '19 days' + interval '9h', v_now - interval '19 days' + interval '10h', 'closed', 'TV-005'),
  (v_account_id, 'NQ', 'buy', 1, 18880.00, 18910.75, 615.00, 4.70, v_now - interval '19 days' + interval '11h', v_now - interval '19 days' + interval '12h45m', 'closed', 'TV-006'),
  (v_account_id, 'ES', 'sell', 1, 5448.50, 5451.00, -125.00, 4.70, v_now - interval '19 days' + interval '14h', v_now - interval '19 days' + interval '14h30m', 'closed', 'TV-007');

-- Day 4 (17 days ago)
INSERT INTO public.trades (account_id, symbol, side, quantity, entry_price, exit_price, pnl, commission, opened_at, closed_at, status, platform_trade_id) VALUES
  (v_account_id, 'CL', 'sell', 2, 73.15, 72.85, 600.00, 4.70, v_now - interval '17 days' + interval '9h', v_now - interval '17 days' + interval '10h30m', 'closed', 'TV-008'),
  (v_account_id, 'ES', 'buy', 1, 5452.00, 5449.50, -125.00, 4.70, v_now - interval '17 days' + interval '12h', v_now - interval '17 days' + interval '13h', 'closed', 'TV-009');

-- Day 5 (16 days ago)
INSERT INTO public.trades (account_id, symbol, side, quantity, entry_price, exit_price, pnl, commission, opened_at, closed_at, status, platform_trade_id) VALUES
  (v_account_id, 'NQ', 'buy', 2, 18975.00, 19010.50, 1420.00, 9.40, v_now - interval '16 days' + interval '9h15m', v_now - interval '16 days' + interval '11h', 'closed', 'TV-010'),
  (v_account_id, 'ES', 'sell', 1, 5460.75, 5463.00, -112.50, 4.70, v_now - interval '16 days' + interval '13h', v_now - interval '16 days' + interval '13h45m', 'closed', 'TV-011');

-- Day 6 (14 days ago)
INSERT INTO public.trades (account_id, symbol, side, quantity, entry_price, exit_price, pnl, commission, opened_at, closed_at, status, platform_trade_id) VALUES
  (v_account_id, 'ES', 'buy', 3, 5455.00, 5461.25, 937.50, 14.10, v_now - interval '14 days' + interval '9h', v_now - interval '14 days' + interval '10h30m', 'closed', 'TV-012'),
  (v_account_id, 'CL', 'buy', 1, 73.40, 73.10, -300.00, 2.35, v_now - interval '14 days' + interval '12h', v_now - interval '14 days' + interval '13h', 'closed', 'TV-013');

-- Day 7 (13 days ago) — losing day
INSERT INTO public.trades (account_id, symbol, side, quantity, entry_price, exit_price, pnl, commission, opened_at, closed_at, status, platform_trade_id) VALUES
  (v_account_id, 'ES', 'sell', 2, 5470.00, 5475.50, -550.00, 9.40, v_now - interval '13 days' + interval '9h', v_now - interval '13 days' + interval '10h', 'closed', 'TV-014'),
  (v_account_id, 'NQ', 'sell', 1, 19050.00, 19075.00, -500.00, 4.70, v_now - interval '13 days' + interval '11h', v_now - interval '13 days' + interval '12h', 'closed', 'TV-015');

-- Day 8 (11 days ago) — bounce back
INSERT INTO public.trades (account_id, symbol, side, quantity, entry_price, exit_price, pnl, commission, opened_at, closed_at, status, platform_trade_id) VALUES
  (v_account_id, 'ES', 'buy', 2, 5462.00, 5470.50, 850.00, 9.40, v_now - interval '11 days' + interval '9h', v_now - interval '11 days' + interval '10h30m', 'closed', 'TV-016'),
  (v_account_id, 'CL', 'buy', 2, 72.90, 73.25, 700.00, 4.70, v_now - interval '11 days' + interval '11h', v_now - interval '11 days' + interval '12h', 'closed', 'TV-017'),
  (v_account_id, 'NQ', 'buy', 1, 19020.00, 19005.00, -300.00, 4.70, v_now - interval '11 days' + interval '13h', v_now - interval '11 days' + interval '13h30m', 'closed', 'TV-018');

-- Day 9 (9 days ago)
INSERT INTO public.trades (account_id, symbol, side, quantity, entry_price, exit_price, pnl, commission, opened_at, closed_at, status, platform_trade_id) VALUES
  (v_account_id, 'ES', 'buy', 1, 5475.50, 5482.25, 337.50, 4.70, v_now - interval '9 days' + interval '9h', v_now - interval '9 days' + interval '10h', 'closed', 'TV-019'),
  (v_account_id, 'ES', 'sell', 2, 5485.00, 5480.75, 425.00, 9.40, v_now - interval '9 days' + interval '12h', v_now - interval '9 days' + interval '13h', 'closed', 'TV-020');

-- Day 10 (7 days ago) — small loss day
INSERT INTO public.trades (account_id, symbol, side, quantity, entry_price, exit_price, pnl, commission, opened_at, closed_at, status, platform_trade_id) VALUES
  (v_account_id, 'NQ', 'buy', 1, 19100.00, 19085.00, -300.00, 4.70, v_now - interval '7 days' + interval '9h', v_now - interval '7 days' + interval '10h', 'closed', 'TV-021'),
  (v_account_id, 'CL', 'sell', 1, 73.50, 73.65, -150.00, 2.35, v_now - interval '7 days' + interval '11h', v_now - interval '7 days' + interval '12h', 'closed', 'TV-022');

-- Day 11 (4 days ago)
INSERT INTO public.trades (account_id, symbol, side, quantity, entry_price, exit_price, pnl, commission, opened_at, closed_at, status, platform_trade_id) VALUES
  (v_account_id, 'ES', 'buy', 2, 5490.00, 5497.75, 775.00, 9.40, v_now - interval '4 days' + interval '9h', v_now - interval '4 days' + interval '11h', 'closed', 'TV-023'),
  (v_account_id, 'NQ', 'sell', 1, 19150.00, 19135.00, 300.00, 4.70, v_now - interval '4 days' + interval '13h', v_now - interval '4 days' + interval '14h', 'closed', 'TV-024');

-- Day 12 (yesterday)
INSERT INTO public.trades (account_id, symbol, side, quantity, entry_price, exit_price, pnl, commission, opened_at, closed_at, status, platform_trade_id) VALUES
  (v_account_id, 'ES', 'buy', 1, 5500.00, 5506.50, 325.00, 4.70, v_now - interval '1 day' + interval '9h', v_now - interval '1 day' + interval '10h30m', 'closed', 'TV-025');

-- 1 open position (today)
INSERT INTO public.trades (account_id, symbol, side, quantity, entry_price, exit_price, pnl, commission, opened_at, closed_at, status, platform_trade_id) VALUES
  (v_account_id, 'ES', 'buy', 2, 5508.25, NULL, NULL, NULL, v_now - interval '1 hour', NULL, 'open', 'TV-026');

END $$;
