-- Liability alert configuration + state tracking
CREATE TABLE IF NOT EXISTS public.liability_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_type text NOT NULL DEFAULT 'negative_net_buffer',
  is_active boolean NOT NULL DEFAULT true,
  last_state text NOT NULL DEFAULT 'ok', -- 'ok' | 'negative'
  last_triggered_at timestamptz,
  cooldown_minutes integer NOT NULL DEFAULT 60,
  threshold numeric NOT NULL DEFAULT 0, -- Alert if net_buffer < threshold
  channels jsonb NOT NULL DEFAULT '["email", "in_app"]'::jsonb,
  recipients jsonb NOT NULL DEFAULT '[]'::jsonb, -- Array of emails
  cash_reserve numeric NOT NULL DEFAULT 0,
  assumed_avg_first_payout numeric NOT NULL DEFAULT 300,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(alert_type)
);

-- Staff notifications table for in-app alerts
CREATE TABLE IF NOT EXISTS public.staff_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  notification_type text NOT NULL,
  title text NOT NULL,
  body text,
  data jsonb DEFAULT '{}'::jsonb,
  is_read boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- RLS for liability_alerts (admin-only management, staff read)
ALTER TABLE public.liability_alerts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can manage liability alerts"
ON public.liability_alerts FOR ALL
TO authenticated
USING (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Staff can view liability alerts"
ON public.liability_alerts FOR SELECT
TO authenticated
USING (has_any_role(auth.uid(), ARRAY['risk_officer'::app_role, 'support'::app_role, 'admin'::app_role]));

-- RLS for staff_notifications
ALTER TABLE public.staff_notifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can view own notifications"
ON public.staff_notifications FOR SELECT
TO authenticated
USING (user_id = auth.uid() AND has_any_role(auth.uid(), ARRAY['risk_officer'::app_role, 'support'::app_role, 'admin'::app_role]));

CREATE POLICY "Staff can update own notifications"
ON public.staff_notifications FOR UPDATE
TO authenticated
USING (user_id = auth.uid())
WITH CHECK (user_id = auth.uid());

-- No client inserts (service role only)
CREATE POLICY "No client inserts on staff_notifications"
ON public.staff_notifications FOR INSERT
TO authenticated
WITH CHECK (false);

-- Insert default alert config
INSERT INTO public.liability_alerts (alert_type, is_active, cooldown_minutes, threshold, channels, recipients)
VALUES ('negative_net_buffer', true, 60, 0, '["email", "in_app"]'::jsonb, '[]'::jsonb)
ON CONFLICT (alert_type) DO NOTHING;

-- Function to check liability alerts and fire if needed (called by cron edge function)
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
BEGIN
  -- Get alert config
  SELECT * INTO _config
  FROM public.liability_alerts
  WHERE alert_type = 'negative_net_buffer'
  FOR UPDATE;
  
  IF NOT FOUND OR NOT _config.is_active THEN
    RETURN jsonb_build_object('fired', false, 'reason', 'Alert not active or not found');
  END IF;
  
  -- Get current liability snapshot (bypass RLS via service role context)
  _snapshot := get_liability_snapshot(
    7,
    _config.cash_reserve,
    _config.assumed_avg_first_payout
  );
  
  -- Check for errors in snapshot
  IF _snapshot ? 'error' THEN
    RETURN jsonb_build_object('fired', false, 'reason', _snapshot->>'error');
  END IF;
  
  _net_buffer := COALESCE((_snapshot->>'net_buffer')::numeric, 0);
  _new_state := CASE WHEN _net_buffer < _config.threshold THEN 'negative' ELSE 'ok' END;
  
  -- Determine if we should fire
  IF _new_state = 'negative' THEN
    -- Fire on flip from ok -> negative
    IF _config.last_state = 'ok' THEN
      _should_fire := true;
    -- Or if cooldown elapsed while still negative
    ELSIF _config.last_triggered_at IS NULL 
       OR (_now - _config.last_triggered_at) >= (_config.cooldown_minutes || ' minutes')::interval THEN
      _should_fire := true;
    END IF;
  END IF;
  
  -- Update state regardless
  UPDATE public.liability_alerts
  SET 
    last_state = _new_state,
    last_triggered_at = CASE WHEN _should_fire THEN _now ELSE last_triggered_at END,
    updated_at = _now
  WHERE id = _config.id;
  
  IF NOT _should_fire THEN
    RETURN jsonb_build_object(
      'fired', false,
      'reason', CASE 
        WHEN _new_state = 'ok' THEN 'Buffer is OK'
        ELSE 'Cooldown not elapsed'
      END,
      'net_buffer', _net_buffer,
      'state', _new_state,
      'last_triggered_at', _config.last_triggered_at
    );
  END IF;
  
  -- Fire alert: create in-app notifications for all staff
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
          'Cash reserve is insufficient to cover pending + projected liability. Shortfall: $' || ABS(_net_buffer)::text,
          jsonb_build_object(
            'net_buffer', _net_buffer,
            'threshold', _config.threshold,
            'snapshot', _snapshot
          )
        );
      END LOOP;
    END IF;
  END IF;
  
  -- Log to audit_logs
  INSERT INTO public.audit_logs (user_id, action, details, reason)
  VALUES (
    NULL, -- System-triggered
    'intake_paused', -- Reusing existing enum (closest match for system alert)
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