-- Add tier_id to cohorts for resilient tier-cohort matching
ALTER TABLE public.cohorts
ADD COLUMN tier_id text;

-- Index for fast lookups
CREATE INDEX idx_cohorts_tier_id ON public.cohorts (tier_id) WHERE tier_id IS NOT NULL;

-- Update existing cohorts if they match known entry fees
UPDATE public.cohorts SET tier_id = 'starter' WHERE entry_fee = 149 AND tier_id IS NULL;
UPDATE public.cohorts SET tier_id = 'pro' WHERE entry_fee = 199 AND tier_id IS NULL;
UPDATE public.cohorts SET tier_id = 'elite' WHERE entry_fee = 349 AND tier_id IS NULL;