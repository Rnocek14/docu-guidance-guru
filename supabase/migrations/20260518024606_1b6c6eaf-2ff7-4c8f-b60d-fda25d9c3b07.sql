DO $$
DECLARE
  r record;
  keep text[] := ARRAY[
    'get_econ_breaker_state',
    'simulate_compound_config_impact',
    'get_dispute_rate_snapshot',
    'manual_risk_throttle_override',
    'get_cohort_account_stats',
    'get_liability_buffer_settings',
    'get_liability_snapshot',
    'upsert_liability_buffer_settings',
    'get_support_ops_metrics',
    'check_consistency_rules',
    'get_user_roles',
    'calculate_payout_eligibility',
    'submit_payout_request'
  ];
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig, p.proname
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prosecdef = true
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM authenticated', r.sig);
    IF r.proname = ANY(keep) THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', r.sig);
    END IF;
  END LOOP;
END$$;