
UPDATE public.cohorts
SET first_payout_cap_amount = NULL,
    lifetime_cap_multiple = NULL
WHERE id IN ('30c85b00-c613-4d33-83e5-c5af8a8ea6d5', '1d28f164-3219-4c05-879d-a2642c15a57e');
