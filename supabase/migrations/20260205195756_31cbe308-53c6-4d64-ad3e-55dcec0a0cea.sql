-- 1) Add proper audit action for liability alerts
ALTER TYPE public.audit_action ADD VALUE IF NOT EXISTS 'liability_alert_fired';

-- 2) Add idempotency_key to staff_notifications (unique, nullable for backwards compat)
ALTER TABLE public.staff_notifications 
ADD COLUMN IF NOT EXISTS idempotency_key text UNIQUE;

-- Create partial unique index for non-null idempotency keys (in case column already exists without unique constraint)
-- This handles the case where we want duplicates to be silently ignored
CREATE UNIQUE INDEX IF NOT EXISTS idx_staff_notifications_idempotency 
ON public.staff_notifications (idempotency_key) 
WHERE idempotency_key IS NOT NULL;

-- 3) Update check_liability_alert to use proper audit action + idempotent notifications
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
  _idempotency_key text;
  _notified_count integer := 0;
BEGIN
  -- Get alert config with lock
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
  
  -- Opening soon count (7-day forward window)
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
  
  -- Determine if we should fire (flip detection + cooldown)
  IF _new_state = 'negative' THEN
    -- Fire immediately on flip from ok -> negative
    IF _config.last_state = 'ok' THEN
      _should_fire := true;
    -- Or fire if cooldown elapsed while still negative
    ELSIF _config.last_triggered_at IS NULL 
       OR (_now - _config.last_triggered_at) >= (_config.cooldown_minutes || ' minutes')::interval THEN
      _should_fire := true;
    END IF;
  END IF;
  
  -- Update state (always, even if not firing)
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
      'last_triggered_at', _config.last_triggered_at,
      'cooldown_minutes', _config.cooldown_minutes
    );
  END IF;
  
  -- Build idempotency key: alert_id + trigger timestamp (ISO minute precision)
  _idempotency_key := 'liability_alert:' || _config.id::text || ':' || to_char(_now, 'YYYY-MM-DD"T"HH24:MI');
  
  -- Fire: create in-app notifications for all staff (with idempotency)
  IF _config.channels ? 'in_app' THEN
    SELECT ARRAY_AGG(DISTINCT user_id) INTO _staff_users
    FROM public.user_roles
    WHERE role IN ('risk_officer', 'support', 'admin');
    
    IF _staff_users IS NOT NULL THEN
      FOREACH _staff_user IN ARRAY _staff_users LOOP
        -- Upsert with idempotency key (ignore duplicates)
        INSERT INTO public.staff_notifications (
          user_id, 
          notification_type, 
          title, 
          body, 
          data,
          idempotency_key
        )
        VALUES (
          _staff_user,
          'liability_alert',
          'Net Buffer Negative',
          'Cash reserve is insufficient. Shortfall: $' || ABS(_net_buffer)::text,
          jsonb_build_object('net_buffer', _net_buffer, 'threshold', _config.threshold, 'snapshot', _snapshot),
          _idempotency_key || ':' || _staff_user::text
        )
        ON CONFLICT (idempotency_key) DO NOTHING;
        
        -- Count successful inserts
        IF FOUND THEN
          _notified_count := _notified_count + 1;
        END IF;
      END LOOP;
    END IF;
  END IF;
  
  -- Log to audit_logs with proper action type
  INSERT INTO public.audit_logs (user_id, action, details, reason)
  VALUES (
    NULL, -- System-triggered
    'liability_alert_fired',
    jsonb_build_object(
      'alert_type', 'negative_net_buffer',
      'net_buffer', _net_buffer,
      'threshold', _config.threshold,
      'channels', _config.channels,
      'recipients', _config.recipients,
      'idempotency_key', _idempotency_key,
      'snapshot', _snapshot
    ),
    'Liability alert triggered: net buffer below threshold'
  );
  
  RETURN jsonb_build_object(
    'fired', true,
    'net_buffer', _net_buffer,
    'threshold', _config.threshold,
    'channels', _config.channels,
    'recipients', _config.recipients,
    'state', _new_state,
    'in_app_notified', _notified_count,
    'idempotency_key', _idempotency_key
  );
END;
$$;