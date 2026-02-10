
-- ============================================================
-- B1: Atomic auto-pass RPC with FOR UPDATE locking
-- Prevents race conditions from concurrent trade ingestion
-- ============================================================

CREATE OR REPLACE FUNCTION public.try_auto_pass(
  _account_id uuid,
  _request_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _account record;
  _updated boolean := false;
  _already_passed boolean := false;
BEGIN
  -- Acquire row-level lock to prevent concurrent pass transitions
  SELECT id, status, passed_at
  INTO _account
  FROM accounts
  WHERE id = _account_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'reason', 'ACCOUNT_NOT_FOUND');
  END IF;

  -- Already passed — idempotent success
  IF _account.status = 'passed' THEN
    RETURN jsonb_build_object(
      'success', true,
      'updated', false,
      'already_passed', true,
      'reason', 'ALREADY_PASSED'
    );
  END IF;

  -- Only active accounts can pass
  IF _account.status != 'active' THEN
    RETURN jsonb_build_object(
      'success', false,
      'reason', 'NOT_ACTIVE',
      'current_status', _account.status
    );
  END IF;

  -- Atomic transition
  UPDATE accounts
  SET status = 'passed',
      passed_at = now(),
      updated_at = now()
  WHERE id = _account_id
    AND status = 'active';

  IF NOT FOUND THEN
    -- Race lost (another transaction got here first)
    RETURN jsonb_build_object('success', true, 'updated', false, 'already_passed', true, 'reason', 'RACE_LOST');
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'updated', true,
    'already_passed', false,
    'reason', 'PASSED'
  );
END;
$$;

-- Restrict access: only service_role can call this
REVOKE EXECUTE ON FUNCTION public.try_auto_pass(uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.try_auto_pass(uuid, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.try_auto_pass(uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.try_auto_pass(uuid, text) TO service_role;


-- ============================================================
-- B3: Pending-pass velocity metric
-- Counts accounts meeting all pass conditions NOW
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_pending_pass_velocity(
  _window_hours integer DEFAULT 48
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _near_pass_count integer;
  _total_active integer;
  _result jsonb;
BEGIN
  -- Count active accounts that meet profit target AND min trading days
  -- These are "pending passes" — one good day away from triggering
  SELECT count(*)
  INTO _near_pass_count
  FROM accounts a
  JOIN cohorts c ON c.id = a.cohort_id
  WHERE a.status = 'active'
    AND a.trading_days_count >= c.min_trading_days
    AND ((a.current_balance - a.starting_balance) / a.starting_balance) * 100 >= c.profit_target_percent * 0.85;

  -- Total active for context
  SELECT count(*) INTO _total_active
  FROM accounts WHERE status = 'active';

  -- Build result
  _result := jsonb_build_object(
    'near_pass_count', _near_pass_count,
    'total_active', _total_active,
    'near_pass_ratio', CASE WHEN _total_active > 0 
      THEN round((_near_pass_count::numeric / _total_active) * 100, 1) 
      ELSE 0 END,
    'measured_at', now()
  );

  RETURN _result;
END;
$$;

-- Restrict access
REVOKE EXECUTE ON FUNCTION public.get_pending_pass_velocity(integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_pending_pass_velocity(integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_pending_pass_velocity(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_pending_pass_velocity(integer) TO authenticated;
