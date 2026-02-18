
-- Seed trades + daily stats for 3 priority DEMO accounts
-- is_winning_day is GENERATED, omit it

-- 1. DEMO-EVAL-BREACH
DELETE FROM account_daily_stats WHERE account_id = '0683c6e0-aec5-4e6d-86b1-d27dc36fbeb3';
DELETE FROM trades WHERE account_id = '0683c6e0-aec5-4e6d-86b1-d27dc36fbeb3';

INSERT INTO trades (account_id, symbol, side, quantity, pnl, commission, opened_at, closed_at, status) VALUES
  ('0683c6e0-aec5-4e6d-86b1-d27dc36fbeb3', 'ES', 'buy', 2, 1500, 9, '2026-01-20 14:00+00', '2026-01-20 15:00+00', 'closed'),
  ('0683c6e0-aec5-4e6d-86b1-d27dc36fbeb3', 'NQ', 'sell', 1, -800, 4.5, '2026-01-21 14:00+00', '2026-01-21 15:00+00', 'closed'),
  ('0683c6e0-aec5-4e6d-86b1-d27dc36fbeb3', 'ES', 'buy', 2, -2200, 9, '2026-01-22 14:00+00', '2026-01-22 16:00+00', 'closed'),
  ('0683c6e0-aec5-4e6d-86b1-d27dc36fbeb3', 'NQ', 'sell', 2, -1500, 9, '2026-01-23 14:00+00', '2026-01-23 15:00+00', 'closed'),
  ('0683c6e0-aec5-4e6d-86b1-d27dc36fbeb3', 'ES', 'sell', 1, -1800, 4.5, '2026-01-24 14:00+00', '2026-01-24 15:00+00', 'closed'),
  ('0683c6e0-aec5-4e6d-86b1-d27dc36fbeb3', 'NQ', 'buy', 1, -1000, 4.5, '2026-01-27 14:00+00', '2026-01-27 15:00+00', 'closed');

INSERT INTO account_daily_stats (account_id, trading_day, net_pnl, gross_pnl, commissions, trade_count, winning_trades, losing_trades) VALUES
  ('0683c6e0-aec5-4e6d-86b1-d27dc36fbeb3', '2026-01-20', 1500, 1509, 9, 1, 1, 0),
  ('0683c6e0-aec5-4e6d-86b1-d27dc36fbeb3', '2026-01-21', -800, -795.5, 4.5, 1, 0, 1),
  ('0683c6e0-aec5-4e6d-86b1-d27dc36fbeb3', '2026-01-22', -2200, -2191, 9, 1, 0, 1),
  ('0683c6e0-aec5-4e6d-86b1-d27dc36fbeb3', '2026-01-23', -1500, -1491, 9, 1, 0, 1),
  ('0683c6e0-aec5-4e6d-86b1-d27dc36fbeb3', '2026-01-24', -1800, -1795.5, 4.5, 1, 0, 1),
  ('0683c6e0-aec5-4e6d-86b1-d27dc36fbeb3', '2026-01-27', -1000, -995.5, 4.5, 1, 0, 1);

-- 2. DEMO-EVAL-FAILED
DELETE FROM account_daily_stats WHERE account_id = '232302e8-95d8-47e2-91bd-14ebbe58205e';
DELETE FROM trades WHERE account_id = '232302e8-95d8-47e2-91bd-14ebbe58205e';

INSERT INTO trades (account_id, symbol, side, quantity, pnl, commission, opened_at, closed_at, status) VALUES
  ('232302e8-95d8-47e2-91bd-14ebbe58205e', 'ES', 'buy', 2, 2000, 9, '2026-01-20 14:00+00', '2026-01-20 15:00+00', 'closed'),
  ('232302e8-95d8-47e2-91bd-14ebbe58205e', 'NQ', 'buy', 1, 500, 4.5, '2026-01-21 14:00+00', '2026-01-21 15:00+00', 'closed'),
  ('232302e8-95d8-47e2-91bd-14ebbe58205e', 'ES', 'sell', 1, -1500, 4.5, '2026-01-22 14:00+00', '2026-01-22 15:00+00', 'closed'),
  ('232302e8-95d8-47e2-91bd-14ebbe58205e', 'NQ', 'sell', 2, -2000, 9, '2026-01-23 14:00+00', '2026-01-23 15:00+00', 'closed'),
  ('232302e8-95d8-47e2-91bd-14ebbe58205e', 'ES', 'buy', 1, -800, 4.5, '2026-01-24 14:00+00', '2026-01-24 15:00+00', 'closed'),
  ('232302e8-95d8-47e2-91bd-14ebbe58205e', 'NQ', 'sell', 1, -1200, 4.5, '2026-01-27 14:00+00', '2026-01-27 15:00+00', 'closed'),
  ('232302e8-95d8-47e2-91bd-14ebbe58205e', 'ES', 'buy', 2, -1500, 9, '2026-01-28 14:00+00', '2026-01-28 15:00+00', 'closed'),
  ('232302e8-95d8-47e2-91bd-14ebbe58205e', 'NQ', 'sell', 1, -2000, 4.5, '2026-01-29 14:00+00', '2026-01-29 15:00+00', 'closed'),
  ('232302e8-95d8-47e2-91bd-14ebbe58205e', 'ES', 'sell', 2, -1500, 9, '2026-01-30 14:00+00', '2026-01-30 15:00+00', 'closed'),
  ('232302e8-95d8-47e2-91bd-14ebbe58205e', 'NQ', 'buy', 1, -1000, 4.5, '2026-01-31 14:00+00', '2026-01-31 15:00+00', 'closed'),
  ('232302e8-95d8-47e2-91bd-14ebbe58205e', 'ES', 'sell', 1, -1500, 4.5, '2026-02-03 14:00+00', '2026-02-03 15:00+00', 'closed');

INSERT INTO account_daily_stats (account_id, trading_day, net_pnl, gross_pnl, commissions, trade_count, winning_trades, losing_trades) VALUES
  ('232302e8-95d8-47e2-91bd-14ebbe58205e', '2026-01-20', 2000, 2009, 9, 1, 1, 0),
  ('232302e8-95d8-47e2-91bd-14ebbe58205e', '2026-01-21', 500, 504.5, 4.5, 1, 1, 0),
  ('232302e8-95d8-47e2-91bd-14ebbe58205e', '2026-01-22', -1500, -1495.5, 4.5, 1, 0, 1),
  ('232302e8-95d8-47e2-91bd-14ebbe58205e', '2026-01-23', -2000, -1991, 9, 1, 0, 1),
  ('232302e8-95d8-47e2-91bd-14ebbe58205e', '2026-01-24', -800, -795.5, 4.5, 1, 0, 1),
  ('232302e8-95d8-47e2-91bd-14ebbe58205e', '2026-01-27', -1200, -1195.5, 4.5, 1, 0, 1),
  ('232302e8-95d8-47e2-91bd-14ebbe58205e', '2026-01-28', -1500, -1491, 9, 1, 0, 1),
  ('232302e8-95d8-47e2-91bd-14ebbe58205e', '2026-01-29', -2000, -1995.5, 4.5, 1, 0, 1),
  ('232302e8-95d8-47e2-91bd-14ebbe58205e', '2026-01-30', -1500, -1491, 9, 1, 0, 1),
  ('232302e8-95d8-47e2-91bd-14ebbe58205e', '2026-01-31', -1000, -995.5, 4.5, 1, 0, 1),
  ('232302e8-95d8-47e2-91bd-14ebbe58205e', '2026-02-03', -1500, -1495.5, 4.5, 1, 0, 1);

-- 3. DEMO-EVAL-PASSED-COOLING
DELETE FROM account_daily_stats WHERE account_id = '33ba4f7b-859c-4e74-b9a7-5c2ae61491d9';
DELETE FROM trades WHERE account_id = '33ba4f7b-859c-4e74-b9a7-5c2ae61491d9';

INSERT INTO trades (account_id, symbol, side, quantity, pnl, commission, opened_at, closed_at, status) VALUES
  ('33ba4f7b-859c-4e74-b9a7-5c2ae61491d9', 'ES', 'buy', 2, 1800, 9, '2026-01-20 14:00+00', '2026-01-20 15:00+00', 'closed'),
  ('33ba4f7b-859c-4e74-b9a7-5c2ae61491d9', 'NQ', 'buy', 1, 1200, 4.5, '2026-01-21 14:00+00', '2026-01-21 15:00+00', 'closed'),
  ('33ba4f7b-859c-4e74-b9a7-5c2ae61491d9', 'ES', 'buy', 2, 2000, 9, '2026-01-22 14:00+00', '2026-01-22 16:00+00', 'closed'),
  ('33ba4f7b-859c-4e74-b9a7-5c2ae61491d9', 'NQ', 'sell', 1, -500, 4.5, '2026-01-23 14:00+00', '2026-01-23 15:00+00', 'closed'),
  ('33ba4f7b-859c-4e74-b9a7-5c2ae61491d9', 'ES', 'buy', 2, 1500, 9, '2026-01-24 14:00+00', '2026-01-24 15:00+00', 'closed'),
  ('33ba4f7b-859c-4e74-b9a7-5c2ae61491d9', 'NQ', 'buy', 1, 1000, 4.5, '2026-01-27 14:00+00', '2026-01-27 15:00+00', 'closed'),
  ('33ba4f7b-859c-4e74-b9a7-5c2ae61491d9', 'ES', 'buy', 2, 1800, 9, '2026-01-28 14:00+00', '2026-01-28 15:00+00', 'closed'),
  ('33ba4f7b-859c-4e74-b9a7-5c2ae61491d9', 'NQ', 'buy', 1, 2400, 4.5, '2026-01-29 14:00+00', '2026-01-29 15:00+00', 'closed'),
  ('33ba4f7b-859c-4e74-b9a7-5c2ae61491d9', 'ES', 'sell', 1, -700, 4.5, '2026-01-30 14:00+00', '2026-01-30 15:00+00', 'closed');

INSERT INTO account_daily_stats (account_id, trading_day, net_pnl, gross_pnl, commissions, trade_count, winning_trades, losing_trades) VALUES
  ('33ba4f7b-859c-4e74-b9a7-5c2ae61491d9', '2026-01-20', 1800, 1809, 9, 1, 1, 0),
  ('33ba4f7b-859c-4e74-b9a7-5c2ae61491d9', '2026-01-21', 1200, 1204.5, 4.5, 1, 1, 0),
  ('33ba4f7b-859c-4e74-b9a7-5c2ae61491d9', '2026-01-22', 2000, 2009, 9, 1, 1, 0),
  ('33ba4f7b-859c-4e74-b9a7-5c2ae61491d9', '2026-01-23', -500, -495.5, 4.5, 1, 0, 1),
  ('33ba4f7b-859c-4e74-b9a7-5c2ae61491d9', '2026-01-24', 1500, 1509, 9, 1, 1, 0),
  ('33ba4f7b-859c-4e74-b9a7-5c2ae61491d9', '2026-01-27', 1000, 1004.5, 4.5, 1, 1, 0),
  ('33ba4f7b-859c-4e74-b9a7-5c2ae61491d9', '2026-01-28', 1800, 1809, 9, 1, 1, 0),
  ('33ba4f7b-859c-4e74-b9a7-5c2ae61491d9', '2026-01-29', 2400, 2404.5, 4.5, 1, 1, 0),
  ('33ba4f7b-859c-4e74-b9a7-5c2ae61491d9', '2026-01-30', -700, -695.5, 4.5, 1, 0, 1);
