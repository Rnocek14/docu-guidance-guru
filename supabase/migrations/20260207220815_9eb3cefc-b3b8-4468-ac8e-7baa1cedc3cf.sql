
-- ============================================================================
-- PHASE 4: TWO-KEY SAFETY SETTINGS + RISK SNAPSHOTS
-- ============================================================================

-- 1) Safety setting change proposals (two-key approval workflow)
CREATE TABLE public.safety_setting_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  setting_key text NOT NULL,
  proposed_value jsonb NOT NULL,
  current_value_snapshot jsonb,
  proposed_by uuid NOT NULL,
  proposed_at timestamptz NOT NULL DEFAULT now(),
  approved_by uuid,
  approved_at timestamptz,
  rejected_by uuid,
  rejected_at timestamptz,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
  reason text,
  ticket_ref text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.safety_setting_changes ENABLE ROW LEVEL SECURITY;

-- Only admins can propose/view/manage
CREATE POLICY "Staff can view safety changes"
  ON public.safety_setting_changes FOR SELECT
  USING (has_any_role(auth.uid(), ARRAY['risk_officer'::app_role, 'admin'::app_role]));

CREATE POLICY "Admins can insert safety changes"
  ON public.safety_setting_changes FOR INSERT
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Admins can update safety changes"
  ON public.safety_setting_changes FOR UPDATE
  USING (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "No deletes on safety changes"
  ON public.safety_setting_changes FOR DELETE
  USING (false);

-- Index for quick lookup by setting_key + status
CREATE INDEX idx_safety_setting_changes_key_status 
  ON public.safety_setting_changes (setting_key, status);

-- 2) Risk snapshots table (daily automated health check)
CREATE TABLE public.risk_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  snapshot_type text NOT NULL DEFAULT 'daily',
  pass_rate numeric,
  pass_rate_alert_level text,
  total_accounts_in_window integer,
  passed_accounts_in_window integer,
  simulation_run_id uuid,
  simulation_stale boolean,
  simulation_age_hours numeric,
  reserve_breach_probability numeric,
  annual_loss_probability numeric,
  worst_month numeric,
  cohort_config_hash text,
  net_buffer numeric,
  pending_payouts_count integer,
  pending_payouts_amount numeric,
  alarms jsonb NOT NULL DEFAULT '[]'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

ALTER TABLE public.risk_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can view risk snapshots"
  ON public.risk_snapshots FOR SELECT
  USING (has_any_role(auth.uid(), ARRAY['risk_officer'::app_role, 'admin'::app_role]));

CREATE POLICY "No client inserts on risk_snapshots"
  ON public.risk_snapshots FOR INSERT
  WITH CHECK (false);

CREATE POLICY "No client updates on risk_snapshots"
  ON public.risk_snapshots FOR UPDATE
  USING (false);

CREATE POLICY "No client deletes on risk_snapshots"
  ON public.risk_snapshots FOR DELETE
  USING (false);

CREATE INDEX idx_risk_snapshots_created ON public.risk_snapshots (created_at DESC);

-- 3) RPC: Propose a safety setting change (two-key step 1)
CREATE OR REPLACE FUNCTION public.propose_safety_setting_change(
  _setting_key text,
  _proposed_value jsonb,
  _reason text DEFAULT NULL,
  _ticket_ref text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _current_value jsonb;
  _change_id uuid;
  _user_id uuid := auth.uid();
BEGIN
  -- Must be admin
  IF NOT has_role(_user_id, 'admin') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Admin role required');
  END IF;

  -- Check for existing pending change on this key
  IF EXISTS (
    SELECT 1 FROM safety_setting_changes
    WHERE setting_key = _setting_key AND status = 'pending'
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'A pending change already exists for this setting. Approve or reject it first.');
  END IF;

  -- Snapshot current value
  SELECT value INTO _current_value
  FROM system_settings
  WHERE key = _setting_key;

  INSERT INTO safety_setting_changes (
    setting_key, proposed_value, current_value_snapshot,
    proposed_by, reason, ticket_ref
  ) VALUES (
    _setting_key, _proposed_value, _current_value,
    _user_id, _reason, _ticket_ref
  )
  RETURNING id INTO _change_id;

  RETURN jsonb_build_object(
    'success', true,
    'change_id', _change_id,
    'setting_key', _setting_key,
    'current_value', _current_value,
    'proposed_value', _proposed_value,
    'status', 'pending',
    'hint', 'A different admin must approve this change.'
  );
END;
$$;

-- 4) RPC: Approve a safety setting change (two-key step 2)
-- CRITICAL: approver must be different from proposer
CREATE OR REPLACE FUNCTION public.approve_safety_setting_change(
  _change_id uuid,
  _reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _change record;
  _user_id uuid := auth.uid();
BEGIN
  -- Must be admin
  IF NOT has_role(_user_id, 'admin') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Admin role required');
  END IF;

  SELECT * INTO _change
  FROM safety_setting_changes
  WHERE id = _change_id AND status = 'pending'
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Change not found or not pending');
  END IF;

  -- SEPARATION OF DUTIES: approver != proposer
  IF _change.proposed_by = _user_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'Cannot approve your own proposal. A different admin must approve.');
  END IF;

  -- Apply the change to system_settings
  UPDATE system_settings
  SET value = _change.proposed_value,
      updated_by = _user_id,
      updated_at = now()
  WHERE key = _change.setting_key;

  -- If no row existed, insert it
  IF NOT FOUND THEN
    INSERT INTO system_settings (key, value, updated_by, updated_at)
    VALUES (_change.setting_key, _change.proposed_value, _user_id, now());
  END IF;

  -- Mark change as approved
  UPDATE safety_setting_changes
  SET status = 'approved',
      approved_by = _user_id,
      approved_at = now(),
      reason = COALESCE(_reason, reason)
  WHERE id = _change_id;

  RETURN jsonb_build_object(
    'success', true,
    'change_id', _change_id,
    'setting_key', _change.setting_key,
    'previous_value', _change.current_value_snapshot,
    'new_value', _change.proposed_value,
    'approved_by', _user_id,
    'proposed_by', _change.proposed_by
  );
END;
$$;

-- 5) RPC: Reject a safety setting change
CREATE OR REPLACE FUNCTION public.reject_safety_setting_change(
  _change_id uuid,
  _reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _change record;
  _user_id uuid := auth.uid();
BEGIN
  IF NOT has_role(_user_id, 'admin') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Admin role required');
  END IF;

  SELECT * INTO _change
  FROM safety_setting_changes
  WHERE id = _change_id AND status = 'pending'
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Change not found or not pending');
  END IF;

  UPDATE safety_setting_changes
  SET status = 'rejected',
      rejected_by = _user_id,
      rejected_at = now(),
      reason = COALESCE(_reason, reason)
  WHERE id = _change_id;

  RETURN jsonb_build_object(
    'success', true,
    'change_id', _change_id,
    'setting_key', _change.setting_key,
    'status', 'rejected'
  );
END;
$$;

-- 6) Lock down RPC privileges
REVOKE ALL ON FUNCTION public.propose_safety_setting_change(text, jsonb, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.propose_safety_setting_change(text, jsonb, text, text) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.approve_safety_setting_change(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.approve_safety_setting_change(uuid, text) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.reject_safety_setting_change(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reject_safety_setting_change(uuid, text) TO authenticated, service_role;

-- 7) RPC: Create risk snapshot (service_role only, called by cron/edge function)
CREATE OR REPLACE FUNCTION public.create_risk_snapshot(
  _pass_rate numeric DEFAULT NULL,
  _pass_rate_alert_level text DEFAULT NULL,
  _total_accounts integer DEFAULT NULL,
  _passed_accounts integer DEFAULT NULL,
  _simulation_run_id uuid DEFAULT NULL,
  _simulation_stale boolean DEFAULT NULL,
  _simulation_age_hours numeric DEFAULT NULL,
  _reserve_breach_prob numeric DEFAULT NULL,
  _annual_loss_prob numeric DEFAULT NULL,
  _worst_month numeric DEFAULT NULL,
  _cohort_config_hash text DEFAULT NULL,
  _net_buffer numeric DEFAULT NULL,
  _pending_payouts_count integer DEFAULT NULL,
  _pending_payouts_amount numeric DEFAULT NULL,
  _alarms jsonb DEFAULT '[]'::jsonb,
  _metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _snapshot_id uuid;
BEGIN
  INSERT INTO risk_snapshots (
    pass_rate, pass_rate_alert_level,
    total_accounts_in_window, passed_accounts_in_window,
    simulation_run_id, simulation_stale, simulation_age_hours,
    reserve_breach_probability, annual_loss_probability, worst_month,
    cohort_config_hash, net_buffer,
    pending_payouts_count, pending_payouts_amount,
    alarms, metadata
  ) VALUES (
    _pass_rate, _pass_rate_alert_level,
    _total_accounts, _passed_accounts,
    _simulation_run_id, _simulation_stale, _simulation_age_hours,
    _reserve_breach_prob, _annual_loss_prob, _worst_month,
    _cohort_config_hash, _net_buffer,
    _pending_payouts_count, _pending_payouts_amount,
    _alarms, _metadata
  )
  RETURNING id INTO _snapshot_id;

  RETURN _snapshot_id;
END;
$$;

REVOKE ALL ON FUNCTION public.create_risk_snapshot(numeric, text, integer, integer, uuid, boolean, numeric, numeric, numeric, numeric, text, numeric, integer, numeric, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_risk_snapshot(numeric, text, integer, integer, uuid, boolean, numeric, numeric, numeric, numeric, text, numeric, integer, numeric, jsonb, jsonb) TO service_role;
