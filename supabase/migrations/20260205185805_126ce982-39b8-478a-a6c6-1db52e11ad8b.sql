-- Fix by-cohort CTE to aggregate payouts per account first, then roll up to cohort
-- Also ensure _approved_unpaid uses consistent scope

CREATE OR REPLACE FUNCTION public.get_liability_snapshot(_days_forward integer DEFAULT 7)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  -- MUST-FIX #1: Explicit access denied for unauthenticated
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object('error', 'unauthenticated');
  END IF;
  
  -- Explicit access denied for non-staff
  IF NOT has_any_role(auth.uid(), ARRAY['risk_officer'::app_role, 'support'::app_role, 'admin'::app_role]) THEN
    RETURN jsonb_build_object('error', 'unauthorized');
  END IF;
  
  _now_ny := (now() AT TIME ZONE 'America/New_York')::date;
  
  -- MUST-FIX #2: Explicit status filtering with guaranteed JSON shape
  SELECT jsonb_build_object(
    'pending', COALESCE(COUNT(*) FILTER (WHERE status = 'pending'), 0),
    'under_review', COALESCE(COUNT(*) FILTER (WHERE status = 'under_review'), 0),
    'approved', COALESCE(COUNT(*) FILTER (WHERE status = 'approved'), 0)
  )
  INTO _pending_counts
  FROM payouts
  WHERE status IN ('pending', 'under_review', 'approved');
  
  SELECT jsonb_build_object(
    'pending', COALESCE(SUM(amount) FILTER (WHERE status = 'pending'), 0),
    'under_review', COALESCE(SUM(amount) FILTER (WHERE status = 'under_review'), 0),
    'approved', COALESCE(SUM(amount) FILTER (WHERE status = 'approved'), 0)
  )
  INTO _pending_amounts
  FROM payouts
  WHERE status IN ('pending', 'under_review', 'approved');
  
  -- Approved but unpaid (critical operational metric) - same scope as pending_amounts.approved
  SELECT COALESCE(SUM(amount), 0)
  INTO _approved_unpaid
  FROM payouts
  WHERE status = 'approved';
  
  -- MUST-FIX #4: Opening soon - only 'passed' status (predict upcoming requests)
  -- Accounts that haven't requested yet but will become eligible soon
  SELECT COUNT(*)
  INTO _opening_soon_count
  FROM accounts a
  JOIN cohorts c ON c.id = a.cohort_id
  WHERE a.status = 'passed'  -- Only those who haven't requested yet
    AND a.passed_at IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM payouts p
      WHERE p.account_id = a.id AND p.status = 'paid'
    )
    -- Cooling not yet opened, but will open within _days_forward days
    AND (a.passed_at AT TIME ZONE 'America/New_York')::date + COALESCE(c.payout_eligibility_delay_days, 7) > _now_ny
    AND (a.passed_at AT TIME ZONE 'America/New_York')::date + COALESCE(c.payout_eligibility_delay_days, 7) <= _now_ny + _days_forward;
  
  -- Opening soon by day breakdown (same filter)
  SELECT COALESCE(jsonb_agg(row_to_json(d) ORDER BY d.opens_on), '[]'::jsonb)
  INTO _opening_soon_by_day
  FROM (
    SELECT 
      ((a.passed_at AT TIME ZONE 'America/New_York')::date + COALESCE(c.payout_eligibility_delay_days, 7))::text as opens_on,
      COUNT(*) as count
    FROM accounts a
    JOIN cohorts c ON c.id = a.cohort_id
    WHERE a.status = 'passed'
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
  
  -- MUST-FIX #5: By-cohort query with proper aggregation to prevent double-counting
  -- Step 1: Aggregate payouts per account first
  -- Step 2: Roll up to cohort level
  WITH payout_per_account AS (
    SELECT
      account_id,
      COALESCE(SUM(amount) FILTER (WHERE status = 'approved'), 0) AS approved_unpaid,
      COALESCE(SUM(amount) FILTER (WHERE status IN ('pending', 'under_review')), 0) AS pending_amount,
      COUNT(*) FILTER (WHERE status = 'approved') AS approved_count,
      COUNT(*) FILTER (WHERE status IN ('pending', 'under_review')) AS pending_count
    FROM payouts
    WHERE status IN ('pending', 'under_review', 'approved')
    GROUP BY account_id
  ),
  payout_agg AS (
    SELECT
      a.cohort_id,
      COALESCE(SUM(p.approved_unpaid), 0) AS approved_unpaid,
      COALESCE(SUM(p.pending_amount), 0) AS pending_amount,
      COALESCE(SUM(p.approved_count), 0) AS approved_count,
      COALESCE(SUM(p.pending_count), 0) AS pending_count
    FROM accounts a
    LEFT JOIN payout_per_account p ON p.account_id = a.id
    GROUP BY a.cohort_id
  )
  SELECT COALESCE(jsonb_agg(row_to_json(cb) ORDER BY cb.approved_unpaid DESC), '[]'::jsonb)
  INTO _by_cohort
  FROM (
    SELECT 
      c.id as cohort_id,
      c.name as cohort_name,
      COALESCE(pa.approved_unpaid, 0) as approved_unpaid,
      COALESCE(pa.pending_amount, 0) as pending_amount,
      COALESCE(pa.approved_count, 0) as approved_count,
      COALESCE(pa.pending_count, 0) as pending_count
    FROM cohorts c
    LEFT JOIN payout_agg pa ON pa.cohort_id = c.id
    WHERE c.is_active = true
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
    'pending_counts', _pending_counts,
    'pending_amounts', _pending_amounts,
    'approved_unpaid', _approved_unpaid,
    'opening_soon_count', _opening_soon_count,
    'opening_soon_by_day', _opening_soon_by_day,
    'by_cohort', _by_cohort,
    'velocity', _velocity_14d,
    'days_forward', _days_forward
  );
END;
$function$;