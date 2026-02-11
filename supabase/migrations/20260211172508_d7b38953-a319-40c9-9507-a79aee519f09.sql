-- Fix trading_days_count for SEEDV2 accounts to match actual daily_stats rows
UPDATE accounts a
SET trading_days_count = (
  SELECT count(DISTINCT ds.trading_day) 
  FROM account_daily_stats ds 
  WHERE ds.account_id = a.id
)
WHERE a.account_number LIKE 'SEEDV2-%';