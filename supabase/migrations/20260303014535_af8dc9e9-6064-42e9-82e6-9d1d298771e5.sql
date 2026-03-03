-- Add clean payout tracking for ladder progression
ALTER TABLE public.payouts
  ADD COLUMN is_clean_payout boolean DEFAULT null,
  ADD COLUMN clean_disqualify_reason text DEFAULT null;

-- Index for efficient clean payout counting per account lineage
CREATE INDEX idx_payouts_clean_count 
  ON public.payouts (account_id, is_clean_payout) 
  WHERE is_clean_payout = true;

COMMENT ON COLUMN public.payouts.is_clean_payout IS 
  'Set at PAID time. true = clean (counts toward ladder), false = disqualified, null = not yet evaluated (pending/in-progress).';
COMMENT ON COLUMN public.payouts.clean_disqualify_reason IS 
  'If is_clean_payout = false, why. E.g. "active_compliance_flag", "breaker_l2". Null if clean or not yet evaluated.';