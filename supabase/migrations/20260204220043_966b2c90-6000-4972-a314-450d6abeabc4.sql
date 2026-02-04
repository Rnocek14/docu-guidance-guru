-- Add lifetime payout tracking to profiles (per-user, never resets)
ALTER TABLE public.profiles
ADD COLUMN IF NOT EXISTS lifetime_paid_total numeric NOT NULL DEFAULT 0;

-- Add CHECK constraint to ensure lifetime_paid_total is never negative
ALTER TABLE public.profiles
ADD CONSTRAINT profiles_lifetime_paid_total_non_negative CHECK (lifetime_paid_total >= 0);

-- Add lifetime cap configuration to cohorts
-- lifetime_cap_multiple: e.g., 7 means cap = entry_fee × 7
-- entry_fee: the price paid for this cohort's account
ALTER TABLE public.cohorts
ADD COLUMN IF NOT EXISTS lifetime_cap_multiple numeric NULL,
ADD COLUMN IF NOT EXISTS entry_fee numeric NULL;

-- Set initial values for existing cohorts (Starter tier: $149, 7x cap)
UPDATE public.cohorts
SET 
  entry_fee = 149,
  lifetime_cap_multiple = 7
WHERE entry_fee IS NULL;

-- Add comment for documentation
COMMENT ON COLUMN public.profiles.lifetime_paid_total IS 'Total amount paid out to this user across all accounts and resets. Never resets.';
COMMENT ON COLUMN public.cohorts.lifetime_cap_multiple IS 'Lifetime payout cap as multiple of entry_fee (e.g., 7 = 7x entry fee).';
COMMENT ON COLUMN public.cohorts.entry_fee IS 'Entry fee for this cohort tier (e.g., 149 for Starter).';