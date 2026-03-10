
INSERT INTO public.cohorts (
  name, cohort_phase, tier_id, entry_fee,
  profit_target_percent, min_trading_days, min_profitable_days,
  max_daily_loss_percent, max_total_drawdown_percent,
  max_position_size_percent, max_payout_percent,
  payout_split_percent, payout_cooldown_days,
  payout_eligibility_delay_days, min_trading_days_between_payouts,
  first_payout_cap_amount, lifetime_cap_multiple,
  is_active, intake_active, version, description
) VALUES
('Founder''s Edition Evaluation', 'evaluation', 'founders', 199,
  10, 5, 0, 5, 10, 20, 80, 80, 14, 7, 5,
  NULL, NULL, true, true, 1, 'Founder''s Edition — Evaluation phase'),
('Founder''s Edition Verification', 'verification', 'founders', 199,
  5, 10, 0, 5, 10, 20, 80, 80, 14, 7, 5,
  NULL, NULL, true, false, 1, 'Founder''s Edition — Verification phase'),
('Founder''s Edition Performance', 'performance', 'founders', 199,
  10, 5, 0, 5, 10, 20, 80, 80, 14, 7, 5,
  300, 7, true, false, 1, 'Founder''s Edition — Performance phase. $300 cap, 7x lifetime.');

-- Wire phase chain: Eval → Verification → Performance
UPDATE public.cohorts
SET next_cohort_id = (SELECT id FROM public.cohorts WHERE name = 'Founder''s Edition Verification' AND tier_id = 'founders')
WHERE name = 'Founder''s Edition Evaluation' AND tier_id = 'founders';

UPDATE public.cohorts
SET next_cohort_id = (SELECT id FROM public.cohorts WHERE name = 'Founder''s Edition Performance' AND tier_id = 'founders')
WHERE name = 'Founder''s Edition Verification' AND tier_id = 'founders';
