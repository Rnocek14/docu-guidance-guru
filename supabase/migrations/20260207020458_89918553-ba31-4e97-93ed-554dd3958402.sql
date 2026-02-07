
-- ============================================================
-- Create Verification + Performance cohorts for Standard Challenge
-- Mirrors competitive firms (Apex, Tradify, Alpha Futures)
-- ============================================================

-- 1. Verification phase cohort (eval graduates land here first)
INSERT INTO public.cohorts (
  name, cohort_phase, description,
  entry_fee,
  profit_target_percent, max_daily_loss_percent, max_total_drawdown_percent,
  min_trading_days, min_profitable_days,
  max_daily_profit_cap_percent,
  payout_split_percent, max_payout_percent,
  first_payout_cap_amount, lifetime_cap_multiple,
  max_payout_absolute,
  payout_cooldown_days, payout_eligibility_delay_days,
  min_trading_days_between_payouts, min_winning_days_between_payouts,
  min_profit_buffer,
  is_active, intake_active
) VALUES (
  'Standard Verification', 'verification', 'Consistency check phase — traders must demonstrate steady performance before unlocking payouts.',
  NULL,                    -- no additional fee
  5.00,                    -- reduced profit target (5%) to prove consistency
  5.00,                    -- same daily loss limit
  10.00,                   -- same max drawdown
  10,                      -- 10 min trading days (forces ~2 weeks minimum)
  5,                       -- 5 profitable days required
  40.00,                   -- best-day rule: no single day > 40% of profits
  80.00, 80.00,            -- split/max payout (not used in verification, but set)
  NULL, NULL,              -- no payout caps (no payouts in verification)
  NULL,                    -- no payout absolute cap
  0, 0,                    -- no payout cooldown (no payouts here)
  0, NULL,                 -- no winning days gate (no payouts here)
  NULL,                    -- no profit buffer (no payouts here)
  true, false              -- active but not accepting direct intake
);

-- 2. Performance phase cohort (payout-eligible, with competitive gates)
INSERT INTO public.cohorts (
  name, cohort_phase, description,
  entry_fee,
  profit_target_percent, max_daily_loss_percent, max_total_drawdown_percent,
  min_trading_days, min_profitable_days,
  max_daily_profit_cap_percent,
  payout_split_percent, max_payout_percent,
  first_payout_cap_amount, lifetime_cap_multiple,
  max_payout_absolute,
  payout_cooldown_days, payout_eligibility_delay_days,
  min_trading_days_between_payouts, min_winning_days_between_payouts,
  min_profit_buffer,
  is_active, intake_active
) VALUES (
  'Standard Performance', 'performance', 'Payout-eligible funded account with velocity gates matching industry standards.',
  NULL,                    -- no additional fee (inherited from eval)
  0,                       -- no profit target to "pass" (already passed)
  5.00,                    -- same daily loss limit
  10.00,                   -- same max drawdown
  0,                       -- no minimum trading days to "complete"
  0,                       -- no min profitable days to "complete"
  40.00,                   -- best-day rule: 40% cap on daily profit
  80.00,                   -- 80% payout split
  80.00,                   -- max 80% of profit as payout
  300.00,                  -- $300 first payout cap
  7.00,                    -- 7x lifetime cap ($1,043)
  NULL,                    -- no absolute payout cap
  30,                      -- 30-day cooldown between payouts
  14,                      -- 14-day eligibility delay after entering PA
  5,                       -- 5 trading days between payouts
  3,                       -- 3 winning days required between payouts
  200.00,                  -- $200 profit buffer since last payout
  true, false              -- active but not accepting direct intake
);

-- 3. Wire the cohort chain: eval → verification → performance
-- First, set verification's next_cohort_id to performance
UPDATE public.cohorts
SET next_cohort_id = (SELECT id FROM public.cohorts WHERE name = 'Standard Performance' AND cohort_phase = 'performance' LIMIT 1)
WHERE name = 'Standard Verification' AND cohort_phase = 'verification';

-- Then, set eval's next_cohort_id to verification
UPDATE public.cohorts
SET next_cohort_id = (SELECT id FROM public.cohorts WHERE name = 'Standard Verification' AND cohort_phase = 'verification' LIMIT 1)
WHERE name = 'Standard Challenge' AND cohort_phase = 'evaluation';
