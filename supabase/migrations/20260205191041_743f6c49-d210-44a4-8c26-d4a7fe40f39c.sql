-- Drop and recreate get_liability_snapshot with net buffer calculation
CREATE OR REPLACE FUNCTION public.get_liability_snapshot(
  _days_forward integer DEFAULT 7,
  _assumed_avg_first_payout numeric DEFAULT 300,
  _cash_reserve numeric DEFAULT 0
)
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
  -- Net buffer calculation
  _total_pending_amount numeric;
  _expected_opening_soon_liability numeric;
  _net_buffer numeric;
BEGIN
  -- Explicit access denied for unauthenticated
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object('error', 'unauthenticated');
  END IF;
  
  -- Explicit access denied for non-staff
  IF NOT has_any_role(auth.uid(), ARRAY['risk_officer'::app_role, 'support'::app_role, 'admin'::app_role]) THEN
    RETURN jsonb_build_object('error', 'unauthorized');
  END IF;
  
  _now_ny := (now() AT TIME ZONE 'America/New_York')::date;
  
  -- Pending counts with guaranteed JSON shape
  SELECT jsonb_build_object(
    'pending', COALESCE(COUNT(*) FILTER (WHERE status = 'pending'), 0),
    'under_review', COALESCE(COUNT(*) FILTER (WHERE status = 'under_review'), 0),
    'approved', COALESCE(COUNT(*) FILTER (WHERE status = 'approved'), 0)
  )
  INTO _pending_counts
  FROM payouts
  WHERE status IN ('pending', 'under_review', 'approved');
  
  -- Pending amounts with guaranteed JSON shape
  SELECT jsonb_build_object(
    'pending', COALESCE(SUM(amount) FILTER (WHERE status = 'pending'), 0),
    'under_review', COALESCE(SUM(amount) FILTER (WHERE status = 'under_review'), 0),
    'approved', COALESCE(SUM(amount) FILTER (WHERE status = 'approved'), 0)
  )
  INTO _pending_amounts
  FROM payouts
  WHERE status IN ('pending', 'under_review', 'approved');
  
  -- Approved but unpaid (same scope as pending_amounts.approved)
  SELECT COALESCE(SUM(amount), 0)
  INTO _approved_unpaid
  FROM payouts
  WHERE status = 'approved';
  
  -- Opening soon - only 'passed' status (predict upcoming requests)
  SELECT COUNT(*)
  INTO _opening_soon_count
  FROM accounts a
  JOIN cohorts c ON c.id = a.cohort_id
  WHERE a.status = 'passed'
    AND a.passed_at IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM payouts p
      WHERE p.account_id = a.id AND p.status = 'paid'
    )
    AND (a.passed_at AT TIME ZONE 'America/New_York')::date + COALESCE(c.payout_eligibility_delay_days, 7) > _now_ny
    AND (a.passed_at AT TIME ZONE 'America/New_York')::date + COALESCE(c.payout_eligibility_delay_days, 7) <= _now_ny + _days_forward;
  
  -- Opening soon by day breakdown
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
  
  -- By-cohort with proper aggregation to prevent double-counting
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
  
  -- Velocity: last 14 days
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
  
  -- Net buffer calculation
  _total_pending_amount := COALESCE((_pending_amounts->>'pending')::numeric, 0)
                         + COALESCE((_pending_amounts->>'under_review')::numeric, 0)
                         + COALESCE((_pending_amounts->>'approved')::numeric, 0);
  
  _expected_opening_soon_liability := _opening_soon_count * _assumed_avg_first_payout;
  
  _net_buffer := _cash_reserve - _total_pending_amount - _expected_opening_soon_liability;
  
  RETURN jsonb_build_object(
    'as_of', _now_ny,
    'pending_counts', _pending_counts,
    'pending_amounts', _pending_amounts,
    'approved_unpaid', _approved_unpaid,
    'opening_soon_count', _opening_soon_count,
    'opening_soon_by_day', _opening_soon_by_day,
    'by_cohort', _by_cohort,
    'velocity', _velocity_14d,
    'days_forward', _days_forward,
    -- Net buffer fields
    'total_pending_amount', _total_pending_amount,
    'expected_opening_soon_liability', _expected_opening_soon_liability,
    'cash_reserve', _cash_reserve,
    'assumed_avg_first_payout', _assumed_avg_first_payout,
    'net_buffer', _net_buffer
  );
END;
$function$;