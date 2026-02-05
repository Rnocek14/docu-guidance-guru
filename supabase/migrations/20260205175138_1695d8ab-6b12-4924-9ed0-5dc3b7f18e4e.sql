-- Add staff gate to get_cohort_account_stats for security (prevent unauthorized access)
CREATE OR REPLACE FUNCTION public.get_cohort_account_stats()
RETURNS TABLE (
  cohort_id uuid,
  total_accounts bigint,
  passed_accounts bigint,
  passed_no_paid_payout bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Staff gate: only risk_officer, support, admin can access
  IF NOT has_any_role(auth.uid(), ARRAY['risk_officer'::app_role, 'support'::app_role, 'admin'::app_role]) THEN
    -- Return empty result for non-staff (silent fail, no leak)
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    a.cohort_id,
    COUNT(*) AS total_accounts,
    COUNT(*) FILTER (
      WHERE a.status IN ('passed', 'payout_requested', 'payout_under_review', 'payout_approved')
    ) AS passed_accounts,
    COUNT(*) FILTER (
      WHERE a.status IN ('passed', 'payout_requested', 'payout_under_review', 'payout_approved')
        AND NOT EXISTS (
          SELECT 1 FROM payouts p
          WHERE p.account_id = a.id AND p.status = 'paid'
        )
    ) AS passed_no_paid_payout
  FROM accounts a
  GROUP BY a.cohort_id;
END;
$$;