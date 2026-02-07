
-- spawn_next_phase_account: idempotent account creation on phase graduation
-- Returns JSON: { spawned: bool, to_account_id: uuid|null, to_cohort_id: uuid|null, already_existed: bool }
CREATE OR REPLACE FUNCTION public.spawn_next_phase_account(
  _from_account_id uuid,
  _request_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _from_account RECORD;
  _from_cohort RECORD;
  _to_cohort RECORD;
  _new_account_id uuid;
  _new_account_number text;
  _transition_id uuid;
  _already_existed boolean := false;
  _existing_transition RECORD;
BEGIN
  -- Load source account
  SELECT * INTO _from_account FROM accounts WHERE id = _from_account_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('spawned', false, 'reason', 'Source account not found');
  END IF;

  -- Must be in passed status
  IF _from_account.status <> 'passed' THEN
    RETURN jsonb_build_object('spawned', false, 'reason', 'Source account is not in passed status');
  END IF;

  -- Load source cohort
  SELECT * INTO _from_cohort FROM cohorts WHERE id = _from_account.cohort_id;

  -- Check if there's a next cohort
  IF _from_cohort.next_cohort_id IS NULL THEN
    RETURN jsonb_build_object('spawned', false, 'reason', 'No next phase cohort configured');
  END IF;

  -- Load target cohort
  SELECT * INTO _to_cohort FROM cohorts WHERE id = _from_cohort.next_cohort_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('spawned', false, 'reason', 'Target cohort not found');
  END IF;

  -- Check if transition already exists (idempotency)
  SELECT * INTO _existing_transition
  FROM account_phase_transitions
  WHERE from_account_id = _from_account_id AND to_cohort_id = _to_cohort.id;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'spawned', true,
      'to_account_id', _existing_transition.to_account_id,
      'to_cohort_id', _existing_transition.to_cohort_id,
      'already_existed', true
    );
  END IF;

  -- Generate account number
  _new_account_number := 'ACC-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));

  -- Determine root_account_id (propagate from source or use source as root)
  -- Create the new account with reset balance
  INSERT INTO accounts (
    user_id, cohort_id, account_number, status,
    starting_balance, current_balance, highest_balance,
    parent_account_id, root_account_id, phase_index,
    rule_snapshot
  ) VALUES (
    _from_account.user_id,
    _to_cohort.id,
    _new_account_number,
    'active',
    _to_cohort.starting_balance,
    _to_cohort.starting_balance,
    _to_cohort.starting_balance,
    _from_account_id,
    COALESCE(_from_account.root_account_id, _from_account_id),
    _from_account.phase_index + 1,
    -- Snapshot the target cohort rules
    jsonb_build_object(
      'max_daily_loss_percent', _to_cohort.max_daily_loss_percent,
      'max_total_drawdown_percent', _to_cohort.max_total_drawdown_percent,
      'profit_target_percent', _to_cohort.profit_target_percent,
      'min_trading_days', _to_cohort.min_trading_days,
      'max_position_size_percent', _to_cohort.max_position_size_percent,
      'cohort_phase', _to_cohort.cohort_phase
    )
  ) RETURNING id INTO _new_account_id;

  -- Record the transition (unique constraint prevents duplicates)
  INSERT INTO account_phase_transitions (
    from_account_id, to_account_id, from_cohort_id, to_cohort_id
  ) VALUES (
    _from_account_id, _new_account_id, _from_cohort.id, _to_cohort.id
  ) RETURNING id INTO _transition_id;

  -- Emit account events
  INSERT INTO account_events (account_id, event_type, event_data, idempotency_key, request_id)
  VALUES (
    _from_account_id,
    'phase_graduated',
    jsonb_build_object(
      'from_phase', _from_cohort.cohort_phase,
      'to_phase', _to_cohort.cohort_phase,
      'to_account_id', _new_account_id,
      'to_cohort_id', _to_cohort.id
    ),
    'phase_grad:' || _from_account_id::text || ':' || _to_cohort.id::text,
    _request_id
  ) ON CONFLICT DO NOTHING;

  INSERT INTO account_events (account_id, event_type, event_data, idempotency_key, request_id)
  VALUES (
    _new_account_id,
    'account_created',
    jsonb_build_object(
      'from_phase', _from_cohort.cohort_phase,
      'phase', _to_cohort.cohort_phase,
      'parent_account_id', _from_account_id,
      'root_account_id', COALESCE(_from_account.root_account_id, _from_account_id)
    ),
    'phase_create:' || _new_account_id::text,
    _request_id
  ) ON CONFLICT DO NOTHING;

  RETURN jsonb_build_object(
    'spawned', true,
    'to_account_id', _new_account_id,
    'to_cohort_id', _to_cohort.id,
    'already_existed', false,
    'transition_id', _transition_id
  );
END;
$$;

-- Restrict to service_role only (called from ingestion edge functions)
REVOKE EXECUTE ON FUNCTION public.spawn_next_phase_account(uuid, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.spawn_next_phase_account(uuid, uuid) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.spawn_next_phase_account(uuid, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.spawn_next_phase_account(uuid, uuid) TO service_role;
