-- Fix check_liability_alert to work with service role (no auth.uid() in get_liability_snapshot call)
-- The RPC needs to bypass the auth check when called from service role context

CREATE OR REPLACE FUNCTION public.check_liability_alert()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _config public.liability_alerts%rowtype;
  _snapshot jsonb;
  _net_buffer numeric;
  _new_state text;
  _should_fire boolean := false;
  _staff_users uuid[];
  _staff_user uuid;
  _now timestamptz := now();
  _now_ny date;
  _pending_counts jsonb;
  _pending_amounts jsonb;
  _approved_unpaid numeric;
  _opening_soon_count bigint;
  _total_pending_amount numeric;
  _expected_opening_soon_liability numeric;
BEGIN
  -- Get alert config
  SELECT * INTO _config
  FROM public.liability_alerts
  WHERE alert_type = 'negative_net_buffer'
  FOR UPDATE;
  
  IF NOT FOUND OR NOT _config.is_active THEN
    RETURN jsonb_build_object('fired', false, 'reason', 'Alert not active or not found');
  END IF;
  
  -- Compute liability snapshot inline (bypass auth checks for service role context)
  _now_ny := (now() AT TIME ZONE 'America/New_York')::date;
  
  -- Pending counts
  SELECT jsonb_build_object(
    'pending', COALESCE(COUNT(*) FILTER (WHERE status = 'pending'), 0),
    'under_review', COALESCE(COUNT(*) FILTER (WHERE status = 'under_review'), 0),
    'approved', COALESCE(COUNT(*) FILTER (WHERE status = 'approved'), 0)
  )
  INTO _pending_counts
  FROM payouts
  WHERE status IN ('pending', 'under_review', 'approved');
  
  -- Pending amounts
  SELECT jsonb_build_object(
    'pending', COALESCE(SUM(amount) FILTER (WHERE status = 'pending'), 0),
    'under_review', COALESCE(SUM(amount) FILTER (WHERE status = 'under_review'), 0),
    'approved', COALESCE(SUM(amount) FILTER (WHERE status = 'approved'), 0)
  )
  INTO _pending_amounts
  FROM payouts
  WHERE status IN ('pending', 'under_review', 'approved');
  
  -- Approved unpaid
  SELECT COALESCE(SUM(amount), 0) INTO _approved_unpaid
  FROM payouts WHERE status = 'approved';
  
  -- Opening soon count
  SELECT COUNT(*) INTO _opening_soon_count
  FROM accounts a
  JOIN cohorts c ON c.id = a.cohort_id
  WHERE a.status = 'passed'
    AND a.passed_at IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM payouts p WHERE p.account_id = a.id AND p.status = 'paid')
    AND (a.passed_at AT TIME ZONE 'America/New_York')::date + COALESCE(c.payout_eligibility_delay_days, 7) > _now_ny
    AND (a.passed_at AT TIME ZONE 'America/New_York')::date + COALESCE(c.payout_eligibility_delay_days, 7) <= _now_ny + 7;
  
  -- Calculate net buffer
  _total_pending_amount := 
    COALESCE(NULLIF(_pending_amounts->>'pending', '')::numeric, 0)
    + COALESCE(NULLIF(_pending_amounts->>'under_review', '')::numeric, 0)
    + COALESCE(NULLIF(_pending_amounts->>'approved', '')::numeric, 0);
  
  _expected_opening_soon_liability := COALESCE(_opening_soon_count, 0) * _config.assumed_avg_first_payout;
  
  _net_buffer := _config.cash_reserve - _total_pending_amount - _expected_opening_soon_liability;
  
  _snapshot := jsonb_build_object(
    'as_of', _now_ny,
    'pending_counts', _pending_counts,
    'pending_amounts', _pending_amounts,
    'approved_unpaid', _approved_unpaid,
    'opening_soon_count', _opening_soon_count,
    'total_pending_amount', _total_pending_amount,
    'expected_opening_soon_liability', _expected_opening_soon_liability,
    'cash_reserve', _config.cash_reserve,
    'assumed_avg_first_payout', _config.assumed_avg_first_payout,
    'net_buffer', _net_buffer
  );
  
  _new_state := CASE WHEN _net_buffer < _config.threshold THEN 'negative' ELSE 'ok' END;
  
  -- Determine if we should fire
  IF _new_state = 'negative' THEN
    IF _config.last_state = 'ok' THEN
      _should_fire := true;
    ELSIF _config.last_triggered_at IS NULL 
       OR (_now - _config.last_triggered_at) >= (_config.cooldown_minutes || ' minutes')::interval THEN
      _should_fire := true;
    END IF;
  END IF;
  
  -- Update state
  UPDATE public.liability_alerts
  SET 
    last_state = _new_state,
    last_triggered_at = CASE WHEN _should_fire THEN _now ELSE last_triggered_at END,
    updated_at = _now
  WHERE id = _config.id;
  
  IF NOT _should_fire THEN
    RETURN jsonb_build_object(
      'fired', false,
      'reason', CASE WHEN _new_state = 'ok' THEN 'Buffer is OK' ELSE 'Cooldown not elapsed' END,
      'net_buffer', _net_buffer,
      'state', _new_state,
      'last_triggered_at', _config.last_triggered_at
    );
  END IF;
  
  -- Fire: create in-app notifications for all staff
  IF _config.channels ? 'in_app' THEN
    SELECT ARRAY_AGG(DISTINCT user_id) INTO _staff_users
    FROM public.user_roles
    WHERE role IN ('risk_officer', 'support', 'admin');
    
    IF _staff_users IS NOT NULL THEN
      FOREACH _staff_user IN ARRAY _staff_users LOOP
        INSERT INTO public.staff_notifications (user_id, notification_type, title, body, data)
        VALUES (
          _staff_user,
          'liability_alert',
          'Net Buffer Negative',
          'Cash reserve is insufficient. Shortfall: $' || ABS(_net_buffer)::text,
          jsonb_build_object('net_buffer', _net_buffer, 'threshold', _config.threshold, 'snapshot', _snapshot)
        );
      END LOOP;
    END IF;
  END IF;
  
  -- Log to audit_logs
  INSERT INTO public.audit_logs (user_id, action, details, reason)
  VALUES (
    NULL,
    'intake_paused',
    jsonb_build_object(
      'alert_type', 'negative_net_buffer',
      'net_buffer', _net_buffer,
      'threshold', _config.threshold,
      'channels', _config.channels,
      'recipients', _config.recipients,
      'snapshot', _snapshot
    ),
    'Liability alert triggered: net buffer negative'
  );
  
  RETURN jsonb_build_object(
    'fired', true,
    'net_buffer', _net_buffer,
    'threshold', _config.threshold,
    'channels', _config.channels,
    'recipients', _config.recipients,
    'state', _new_state,
    'in_app_notified', COALESCE(array_length(_staff_users, 1), 0)
  );
END;
$$;