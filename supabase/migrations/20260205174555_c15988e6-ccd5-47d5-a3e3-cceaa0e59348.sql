-- Add 'cohort_updated' to audit_action enum for accurate logging
ALTER TYPE public.audit_action ADD VALUE IF NOT EXISTS 'cohort_updated';

-- Create efficient RPC for cohort account statistics (avoids client-side full table scan)
CREATE OR REPLACE FUNCTION public.get_cohort_account_stats()
RETURNS TABLE (
  cohort_id uuid,
  total_accounts bigint,
  passed_accounts bigint,
  passed_no_paid_payout bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT 
    a.cohort_id,
    COUNT(*) as total_accounts,
    COUNT(*) FILTER (WHERE a.status IN ('passed', 'payout_requested', 'payout_under_review', 'payout_approved')) as passed_accounts,
    COUNT(*) FILTER (
      WHERE a.status IN ('passed', 'payout_requested', 'payout_under_review', 'payout_approved')
      AND NOT EXISTS (
        SELECT 1 FROM payouts p 
        WHERE p.account_id = a.id AND p.status = 'paid'
      )
    ) as passed_no_paid_payout
  FROM accounts a
  GROUP BY a.cohort_id;
$$;