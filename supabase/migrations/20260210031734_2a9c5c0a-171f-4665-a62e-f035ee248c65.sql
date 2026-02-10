-- Make entry_price nullable on trades table to support fills where price is unknown
-- (pnl is the authoritative field for breach/pass math, not price)
ALTER TABLE public.trades
  ALTER COLUMN entry_price DROP NOT NULL;