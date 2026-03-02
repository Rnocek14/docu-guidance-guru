
-- Update Starter Evaluation cohort: first_payout_cap $300→$500, lifetime_cap 7×→10×, cooldown 30→14, eligibility delay 14→7
UPDATE public.cohorts 
SET first_payout_cap_amount = 500,
    lifetime_cap_multiple = 10,
    payout_cooldown_days = 14,
    payout_eligibility_delay_days = 7
WHERE id = '30c85b00-c613-4d33-83e5-c5af8a8ea6d5';

-- Update Standard Verification: cooldown and delay not directly relevant but keep consistent
UPDATE public.cohorts 
SET payout_cooldown_days = 14,
    payout_eligibility_delay_days = 7
WHERE id = '1d28f164-3219-4c05-879d-a2642c15a57e';

-- Update Standard Performance: first_payout_cap $300→$500, lifetime_cap 7×→10×, cooldown 30→14, eligibility delay 14→7
UPDATE public.cohorts 
SET first_payout_cap_amount = 500,
    lifetime_cap_multiple = 10,
    payout_cooldown_days = 14,
    payout_eligibility_delay_days = 7
WHERE id = 'e2965581-ada0-4895-be32-4e6d984ea362';
