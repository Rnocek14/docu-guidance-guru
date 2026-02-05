-- Liability dashboard RPC - returns payout exposure metrics for staff
CREATE OR REPLACE FUNCTION public.get_liability_snapshot(_days_forward integer DEFAULT 7)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _result jsonb;
  _pending_counts jsonb;
  _pending_amounts jsonb;
  _approved_unpaid numeric;
  _opening_soon_count bigint;
  _opening_soon_by_day jsonb;
  _by_cohort jsonb;
  _velocity_14d jsonb;
  _now_ny date;
BEGIN
  -- Staff gate: only risk_officer, support, admin can access
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object('error', 'unauthenticated');
  END IF;
  
  IF NOT has_any_role(auth.uid(), ARRAY['risk_officer'::app_role, 'support'::app_role, 'admin'::app_role]) THEN
    RETURN jsonb_build_object('error', 'unauthorized');
  END IF;
  
  _now_ny := (now() AT TIME ZONE 'America/New_York')::date;
  
  -- Pending liability counts by status
  SELECT jsonb_object_agg(status, cnt)
  INTO _pending_counts
  FROM (
    SELECT status::text, COUNT(*) as cnt
    FROM payouts
    WHERE status IN ('pending', 'under_review', 'approved')
    GROUP BY status
  ) s;
  
  -- Pending liability amounts by status
  SELECT jsonb_object_agg(status, amt)
  INTO _pending_amounts
  FROM (
    SELECT status::text, COALESCE(SUM(amount), 0) as amt
    FROM payouts
    WHERE status IN ('pending', 'under_review', 'approved')
    GROUP BY status
  ) s;
  
  -- Approved but unpaid (critical operational metric)
  SELECT COALESCE(SUM(amount), 0)
  INTO _approved_unpaid
  FROM payouts
  WHERE status = 'approved';
  
  -- Accounts opening soon (cooling window ends within _days_forward days)
  SELECT COUNT(*)
  INTO _opening_soon_count
  FROM accounts a
  JOIN cohorts c ON c.id = a.cohort_id
  WHERE a.status IN ('passed', 'payout_requested', 'payout_under_review', 'payout_approved')
    AND a.passed_at IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM payouts p
      WHERE p.account_id = a.id AND p.status = 'paid'
    )
    -- Cooling not yet opened, but will open within _days_forward days
    AND (a.passed_at AT TIME ZONE 'America/New_York')::date + COALESCE(c.payout_eligibility_delay_days, 7) > _now_ny
    AND (a.passed_at AT TIME ZONE 'America/New_York')::date + COALESCE(c.payout_eligibility_delay_days, 7) <= _now_ny + _days_forward;
  
  -- Opening soon by day breakdown
  SELECT COALESCE(jsonb_agg(row_to_json(d)), '[]'::jsonb)
  INTO _opening_soon_by_day
  FROM (
    SELECT 
      ((a.passed_at AT TIME ZONE 'America/New_York')::date + COALESCE(c.payout_eligibility_delay_days, 7))::text as opens_on,
      COUNT(*) as count
    FROM accounts a
    JOIN cohorts c ON c.id = a.cohort_id
    WHERE a.status IN ('passed', 'payout_requested', 'payout_under_review', 'payout_approved')
      AND a.passed_at IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM payouts p
        WHERE p.account_id = a.id AND p.status = 'paid'
      )
      AND (a.passed_at AT TIME ZONE 'America/New_York')::date + COALESCE(c.payout_eligibility_delay_days, 7) > _now_ny
      AND (a.passed_at AT TIME ZONE 'America/New_York')::date + COALESCE(c.payout_eligibility_delay_days, 7) <= _now_ny + _days_forward
    GROUP BY opens_on
    ORDER BY opens_on
  ) d;
  
  -- Breakdown by cohort (approved unpaid + pending amounts)
  SELECT COALESCE(jsonb_agg(row_to_json(cb)), '[]'::jsonb)
  INTO _by_cohort
  FROM (
    SELECT 
      c.id as cohort_id,
      c.name as cohort_name,
      COALESCE(SUM(p.amount) FILTER (WHERE p.status = 'approved'), 0) as approved_unpaid,
      COALESCE(SUM(p.amount) FILTER (WHERE p.status IN ('pending', 'under_review')), 0) as pending_amount,
      COUNT(*) FILTER (WHERE p.status = 'approved') as approved_count,
      COUNT(*) FILTER (WHERE p.status IN ('pending', 'under_review')) as pending_count
    FROM cohorts c
    LEFT JOIN accounts a ON a.cohort_id = c.id
    LEFT JOIN payouts p ON p.account_id = a.id AND p.status IN ('pending', 'under_review', 'approved')
    WHERE c.is_active = true
    GROUP BY c.id, c.name
    ORDER BY approved_unpaid DESC
  ) cb;
  
  -- Velocity: last 14 days of requests and paid
  SELECT jsonb_build_object(
    'requested_14d', (
      SELECT COUNT(*) FROM payouts
      WHERE requested_at >= now() - interval '14 days'
    ),
    'paid_14d', (
      SELECT COUNT(*) FROM payouts
      WHERE status = 'paid' AND paid_at >= now() - interval '14 days'
    ),
    'paid_amount_14d', (
      SELECT COALESCE(SUM(amount), 0) FROM payouts
      WHERE status = 'paid' AND paid_at >= now() - interval '14 days'
    )
  ) INTO _velocity_14d;
  
  RETURN jsonb_build_object(
    'as_of', _now_ny,
    'pending_counts', COALESCE(_pending_counts, '{}'::jsonb),
    'pending_amounts', COALESCE(_pending_amounts, '{}'::jsonb),
    'approved_unpaid', _approved_unpaid,
    'opening_soon_count', _opening_soon_count,
    'opening_soon_by_day', _opening_soon_by_day,
    'by_cohort', _by_cohort,
    'velocity', _velocity_14d,
    'days_forward', _days_forward
  );
END;
$$;