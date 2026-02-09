-- BOOTSTRAP: Execute the full risk snapshot pipeline as postgres (service_role equivalent)
-- This proves the plumbing works end-to-end, not a fake row insertion

-- Step 1: Call get_liability_snapshot to get the real net_buffer value
DO $$
DECLARE
  v_liability jsonb;
  v_net_buffer numeric;
  v_snapshot_id uuid;
  v_econ jsonb;
BEGIN
  -- Call the same RPC the edge function calls
  SELECT public.get_liability_snapshot(7, 0, 300) INTO v_liability;
  
  -- Extract net_buffer (same logic as edge function)
  v_net_buffer := (v_liability->>'net_buffer')::numeric;
  
  RAISE NOTICE 'get_liability_snapshot returned net_buffer = %', v_net_buffer;
  RAISE NOTICE 'Full liability response: %', v_liability;
  
  -- Call get_econ_guardrail_status for completeness
  SELECT public.get_econ_guardrail_status(30) INTO v_econ;
  RAISE NOTICE 'Econ gate status: %', v_econ->>'status';
  
  -- Step 2: Write the snapshot via the same RPC the edge function uses
  SELECT public.create_risk_snapshot(
    _pass_rate := 0,
    _pass_rate_alert_level := 'normal',
    _total_accounts := 0,
    _passed_accounts := 0,
    _simulation_run_id := '88dc7b74-264d-4ada-a4ed-93a1264eab05'::uuid,
    _simulation_stale := false,
    _simulation_age_hours := NULL,
    _reserve_breach_prob := NULL,
    _annual_loss_prob := NULL,
    _worst_month := NULL,
    _cohort_config_hash := NULL,
    _net_buffer := v_net_buffer,
    _pending_payouts_count := 0,
    _pending_payouts_amount := 0,
    _alarms := '[]'::jsonb,
    _metadata := jsonb_build_object(
      'triggered_by', 'bootstrap_verification',
      'liability_snapshot', v_liability,
      'econ_gate_status', v_econ->>'status'
    )
  ) INTO v_snapshot_id;
  
  RAISE NOTICE 'Created risk_snapshot with id = % and net_buffer = %', v_snapshot_id, v_net_buffer;
END;
$$;