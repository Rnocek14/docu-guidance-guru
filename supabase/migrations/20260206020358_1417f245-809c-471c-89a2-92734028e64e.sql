-- Model A: Store 'GENESIS' in prev_hash, verifier starts with 'GENESIS'
-- This eliminates NULL edge cases entirely

-- Final aligned trigger: stores 'GENESIS' for first row
CREATE OR REPLACE FUNCTION public.compute_audit_hash()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_prev_hash text;
  v_row_data text;
BEGIN
  -- Deterministic previous row: max(created_at, id) strictly less than (NEW.created_at, NEW.id)
  -- Matches verifier's ORDER BY created_at ASC, id ASC iteration
  SELECT row_hash
    INTO v_prev_hash
  FROM public.audit_logs
  WHERE (created_at < NEW.created_at)
     OR (created_at = NEW.created_at AND id < NEW.id)
  ORDER BY created_at DESC, id DESC
  LIMIT 1;

  -- Model A: store 'GENESIS' explicitly for first row (not NULL)
  NEW.prev_hash := coalesce(v_prev_hash, 'GENESIS');

  -- Use canonical function for consistent hashing
  v_row_data := public.audit_row_canonical(
    NEW.id,
    NEW.user_id,
    NEW.account_id,
    NEW.action::text,
    NEW.details,
    NEW.created_at,
    NEW.request_id,
    NEW.reason,
    NEW.ip_address,
    NEW.user_agent,
    NEW.idempotency_key,
    NEW.prev_hash  -- Now always non-NULL ('GENESIS' or previous hash)
  );

  NEW.row_hash := encode(digest(v_row_data::bytea, 'sha256'), 'hex');
  RETURN NEW;
END;
$$;

-- Final aligned verifier: starts with 'GENESIS' to match trigger
CREATE OR REPLACE FUNCTION public.verify_audit_chain(
  _from_date timestamptz DEFAULT NULL,
  _to_date timestamptz DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row record;
  v_expected_prev_hash text := 'GENESIS';  -- Model A: first row expects 'GENESIS'
  v_computed_hash text;
  v_row_data text;
  v_rows_checked integer := 0;
  v_breaks jsonb := '[]'::jsonb;
  v_prev_mismatch boolean;
  v_hash_mismatch boolean;
BEGIN
  FOR v_row IN
    SELECT *
    FROM public.audit_logs
    WHERE (_from_date IS NULL OR created_at >= _from_date)
      AND (_to_date IS NULL OR created_at <= _to_date)
    ORDER BY created_at ASC, id ASC  -- Same ordering as trigger's "previous" lookup
  LOOP
    v_rows_checked := v_rows_checked + 1;
    v_prev_mismatch := false;
    v_hash_mismatch := false;
    
    -- Check prev_hash continuity (first row should have 'GENESIS')
    IF v_row.prev_hash IS DISTINCT FROM v_expected_prev_hash THEN
      v_prev_mismatch := true;
      v_breaks := v_breaks || jsonb_build_object(
        'id', v_row.id,
        'created_at', v_row.created_at,
        'issue', 'prev_hash_mismatch',
        'expected', v_expected_prev_hash,
        'actual', v_row.prev_hash
      );
    END IF;
    
    -- Recompute row_hash using same canonical function
    v_row_data := public.audit_row_canonical(
      v_row.id,
      v_row.user_id,
      v_row.account_id,
      v_row.action::text,
      v_row.details,
      v_row.created_at,
      v_row.request_id,
      v_row.reason,
      v_row.ip_address,
      v_row.user_agent,
      v_row.idempotency_key,
      v_row.prev_hash  -- Now always 'GENESIS' or previous hash
    );
    
    v_computed_hash := encode(digest(v_row_data::bytea, 'sha256'), 'hex');
    
    IF v_row.row_hash IS DISTINCT FROM v_computed_hash THEN
      v_hash_mismatch := true;
      v_breaks := v_breaks || jsonb_build_object(
        'id', v_row.id,
        'created_at', v_row.created_at,
        'issue', 'row_hash_mismatch',
        'expected', v_computed_hash,
        'actual', v_row.row_hash
      );
    END IF;
    
    -- Only advance expected hash if BOTH checks passed
    IF NOT v_prev_mismatch AND NOT v_hash_mismatch THEN
      v_expected_prev_hash := v_row.row_hash;
    END IF;
  END LOOP;
  
  RETURN jsonb_build_object(
    'valid', jsonb_array_length(v_breaks) = 0,
    'rows_checked', v_rows_checked,
    'breaks', v_breaks,
    'checked_at', now()
  );
END;
$$;

-- Lock audit_logs mutations at privilege layer (belt + suspenders with RLS)
REVOKE UPDATE, DELETE, TRUNCATE ON public.audit_logs FROM authenticated;
REVOKE UPDATE, DELETE, TRUNCATE ON public.audit_logs FROM anon;