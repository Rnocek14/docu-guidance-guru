-- Production-owned fraud control generation
-- Creates fraud_reviews and flags when cluster risk thresholds are met

-- 1. RPC: evaluate_cluster_risk
CREATE OR REPLACE FUNCTION public.evaluate_cluster_risk(
  _cluster_id uuid,
  _request_id uuid DEFAULT gen_random_uuid()
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _cluster_users uuid[];
  _cluster_accounts uuid[];
  _user_count int;
  _account_count int;
  _existing_review_count int;
  _correlation_result jsonb;
  _has_correlations boolean := false;
  _total_correlation_matches int := 0;
  _fraud_review_id uuid;
  _flags_created int := 0;
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
      'cluster_id', _cluster_id
    );
  END IF;

  SELECT array_agg(DISTINCT a.id)
  INTO _cluster_accounts
  FROM accounts a
  WHERE a.user_id = ANY(_cluster_users)
    AND a.status NOT IN ('failed_confirmed');

  _account_count := coalesce(array_length(_cluster_accounts, 1), 0);

  SELECT count(*)
  INTO _existing_review_count
  FROM fraud_reviews
  WHERE entity_type = 'identity_cluster'
    AND entity_id = _cluster_id
    AND status IN ('pending', 'in_review');

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

  IF _existing_review_count = 0 THEN
    INSERT INTO fraud_reviews (
      entity_type, entity_id, review_type, severity, status,
      auto_block, request_id, details
    ) VALUES (
      'identity_cluster', _cluster_id, 'cluster_risk_evaluation',
      CASE
        WHEN _has_correlations THEN 'critical'
        WHEN _user_count >= 3 THEN 'high'
        ELSE 'medium'
      END,
      'pending',
      _has_correlations AND _total_correlation_matches >= 5,
      _request_id,
      jsonb_build_object(
        'source', 'evaluate_cluster_risk',
        'cluster_id', _cluster_id,
        'user_count', _user_count,
        'account_count', _account_count,
        'has_trade_correlations', _has_correlations,
        'total_correlation_matches', _total_correlation_matches,
        'evaluated_at', now()
      )
    )
    RETURNING id INTO _fraud_review_id;

    IF _cluster_accounts IS NOT NULL THEN
      INSERT INTO flags (account_id, flag_type, reason, severity, status)
      SELECT
        unnest(_cluster_accounts),
        'cluster_abuse',
        format('Account linked to multi-user device cluster %s (%s users, %s accounts)',
          _cluster_id, _user_count, _account_count),
        CASE
          WHEN _has_correlations THEN 'critical'
          WHEN _user_count >= 3 THEN 'high'
          ELSE 'medium'
        END,
        'pending'
      ON CONFLICT DO NOTHING;
      GET DIAGNOSTICS _flags_created = ROW_COUNT;
    END IF;
  END IF;

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
    updated_at = now()
  WHERE id = _cluster_id;

  RETURN jsonb_build_object(
    'action', 'fraud_review_created',
    'cluster_id', _cluster_id,
    'user_count', _user_count,
    'account_count', _account_count,
    'has_correlations', _has_correlations,
    'correlation_matches', _total_correlation_matches,
    'fraud_review_id', _fraud_review_id,
    'flags_created', _flags_created,
    'existing_review', _existing_review_count > 0,
    'request_id', _request_id
  );
END;
$$;

-- 2. Trigger function for auto-evaluation
CREATE OR REPLACE FUNCTION public.trg_fingerprint_cluster_evaluate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _distinct_users int;
BEGIN
  IF NEW.cluster_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT count(DISTINCT user_id)
  INTO _distinct_users
  FROM device_fingerprints
  WHERE cluster_id = NEW.cluster_id;

  IF _distinct_users >= 2 THEN
    PERFORM evaluate_cluster_risk(NEW.cluster_id);
  END IF;

  RETURN NEW;
END;
$$;

-- 3. Trigger on device_fingerprints
DROP TRIGGER IF EXISTS trg_fingerprint_cluster_risk ON device_fingerprints;
CREATE TRIGGER trg_fingerprint_cluster_risk
  AFTER INSERT OR UPDATE OF cluster_id
  ON device_fingerprints
  FOR EACH ROW
  EXECUTE FUNCTION trg_fingerprint_cluster_evaluate();

-- 4. Grants
GRANT EXECUTE ON FUNCTION public.evaluate_cluster_risk(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.evaluate_cluster_risk(uuid, uuid) TO service_role;