-- 1. Add unique constraint on flags for ON CONFLICT DO NOTHING to work
ALTER TABLE public.flags
  ADD CONSTRAINT flags_account_id_flag_type_uq UNIQUE (account_id, flag_type);

-- 2. Harden evaluate_cluster_risk for full idempotency + structured rationale
CREATE OR REPLACE FUNCTION public.evaluate_cluster_risk(
  _cluster_id uuid,
  _request_id uuid DEFAULT gen_random_uuid()
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _cluster_users uuid[];
  _cluster_accounts uuid[];
  _user_count int;
  _account_count int;
  _existing_review_count int;
  _existing_flag_count int;
  _correlation_result jsonb;
  _has_correlations boolean := false;
  _total_correlation_matches int := 0;
  _fraud_review_id uuid;
  _flags_created int := 0;
  _severity text;
  _action text := 'none';
  _rationale text;
BEGIN
  SELECT array_agg(DISTINCT user_id)
  INTO _cluster_users
  FROM device_fingerprints
  WHERE cluster_id = _cluster_id;

  _user_count := coalesce(array_length(_cluster_users, 1), 0);

  IF _user_count < 2 THEN
    RETURN jsonb_build_object(
      'action', 'none',
      'reason', 'single_user_cluster',
      'user_count', _user_count,
      'cluster_id', _cluster_id,
      'idempotent', true
    );
  END IF;

  SELECT array_agg(DISTINCT a.id)
  INTO _cluster_accounts
  FROM accounts a
  WHERE a.user_id = ANY(_cluster_users)
    AND a.status NOT IN ('failed_confirmed');

  _account_count := coalesce(array_length(_cluster_accounts, 1), 0);

  -- Idempotency gate: check existing pending/in_review fraud reviews
  SELECT count(*)
  INTO _existing_review_count
  FROM fraud_reviews
  WHERE entity_type = 'identity_cluster'
    AND entity_id = _cluster_id
    AND status IN ('pending', 'in_review');

  -- Idempotency gate: check existing pending flags
  SELECT count(*)
  INTO _existing_flag_count
  FROM flags
  WHERE account_id = ANY(_cluster_accounts)
    AND flag_type = 'cluster_abuse'
    AND status = 'pending';

  -- Correlation checks (up to 5 accounts)
  IF _account_count >= 2 THEN
    FOR i IN 1..least(_account_count, 5) LOOP
      SELECT detect_trade_correlations(
        _cluster_accounts[i], 120, 2
      ) INTO _correlation_result;

      IF (_correlation_result->>'has_correlations')::boolean THEN
        _has_correlations := true;
        _total_correlation_matches := _total_correlation_matches +
          coalesce((_correlation_result->>'correlation_count')::int, 0);
      END IF;
    END LOOP;
  END IF;

  _severity := CASE
    WHEN _has_correlations THEN 'critical'
    WHEN _user_count >= 3 THEN 'high'
    ELSE 'medium'
  END;

  -- Structured, human-readable rationale for ops review
  _rationale := format(
    'Cluster %s: %s distinct users, %s active accounts. %s. Severity: %s.',
    _cluster_id, _user_count, _account_count,
    CASE
      WHEN _has_correlations THEN format('%s correlated trade matches detected across cluster accounts', _total_correlation_matches)
      ELSE 'No correlated trades detected, flagged on shared device alone'
    END,
    _severity
  );

  -- Create fraud review ONLY if none pending/in_review
  IF _existing_review_count = 0 THEN
    INSERT INTO fraud_reviews (
      entity_type, entity_id, review_type, severity, status,
      auto_block, request_id, details
    ) VALUES (
      'identity_cluster', _cluster_id, 'cluster_risk_evaluation',
      _severity, 'pending',
      _has_correlations AND _total_correlation_matches >= 5,
      _request_id,
      jsonb_build_object(
        'source', 'evaluate_cluster_risk',
        'cluster_id', _cluster_id,
        'user_count', _user_count,
        'account_count', _account_count,
        'has_trade_correlations', _has_correlations,
        'total_correlation_matches', _total_correlation_matches,
        'severity', _severity,
        'rationale', _rationale,
        'evaluated_at', now(),
        'request_id', _request_id
      )
    )
    RETURNING id INTO _fraud_review_id;
    _action := 'fraud_review_created';
  ELSE
    _action := 'skipped_existing_review';
  END IF;

  -- Create flags with unique constraint guard
  IF _cluster_accounts IS NOT NULL THEN
    INSERT INTO flags (account_id, flag_type, reason, severity, status)
    SELECT
      unnest(_cluster_accounts),
      'cluster_abuse',
      _rationale,
      _severity,
      'pending'
    ON CONFLICT (account_id, flag_type) DO NOTHING;
    GET DIAGNOSTICS _flags_created = ROW_COUNT;
  END IF;

  -- Update cluster metadata (skip updated_at if nothing changed)
  UPDATE identity_clusters
  SET
    risk_score = CASE
      WHEN _has_correlations THEN least(100, 60 + _total_correlation_matches * 5)
      WHEN _user_count >= 3 THEN 50
      ELSE 30
    END,
    is_flagged = true,
    flag_reason = CASE
      WHEN _has_correlations THEN format('Multi-user cluster with %s correlated trade matches', _total_correlation_matches)
      ELSE format('Multi-user device cluster (%s users)', _user_count)
    END,
    updated_at = CASE
      WHEN is_flagged = true
        AND flag_reason IS NOT DISTINCT FROM (
          CASE
            WHEN _has_correlations THEN format('Multi-user cluster with %s correlated trade matches', _total_correlation_matches)
            ELSE format('Multi-user device cluster (%s users)', _user_count)
          END
        )
      THEN updated_at
      ELSE now()
    END
  WHERE id = _cluster_id;

  RETURN jsonb_build_object(
    'action', _action,
    'cluster_id', _cluster_id,
    'user_count', _user_count,
    'account_count', _account_count,
    'has_correlations', _has_correlations,
    'correlation_matches', _total_correlation_matches,
    'severity', _severity,
    'rationale', _rationale,
    'fraud_review_id', _fraud_review_id,
    'flags_created', _flags_created,
    'existing_review_count', _existing_review_count,
    'existing_flag_count', _existing_flag_count,
    'idempotent', _existing_review_count > 0,
    'request_id', _request_id
  );
END;
$$;