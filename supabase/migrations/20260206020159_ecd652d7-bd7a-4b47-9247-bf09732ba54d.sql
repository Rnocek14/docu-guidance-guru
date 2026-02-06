-- Drop the old text-based canonical function (signature conflict)
DROP FUNCTION IF EXISTS public.audit_row_canonical(uuid, uuid, uuid, text, jsonb, timestamptz, uuid, text, text, text, text, text);

-- Ensure only the inet-based version exists with correct settings
CREATE OR REPLACE FUNCTION public.audit_row_canonical(
  _id uuid,
  _user_id uuid,
  _account_id uuid,
  _action text,
  _details jsonb,
  _created_at timestamptz,
  _request_id uuid,
  _reason text,
  _ip inet,
  _ua text,
  _idempotency text,
  _prev_hash text
) RETURNS text
LANGUAGE sql
IMMUTABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT concat_ws('|',
    _id::text,
    coalesce(_user_id::text, ''),
    coalesce(_account_id::text, ''),
    coalesce(_action, ''),
    coalesce(_details::text, '{}'),
    _created_at::text,
    coalesce(_request_id::text, ''),
    coalesce(_reason, ''),
    coalesce(_ip::text, ''),
    coalesce(_ua, ''),
    coalesce(_idempotency, ''),
    coalesce(_prev_hash, 'GENESIS')
  );
$$;

-- Final aligned trigger with exact GENESIS handling and deterministic ordering
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
  -- This matches verifier's ORDER BY created_at ASC, id ASC iteration
  SELECT row_hash
    INTO v_prev_hash
  FROM public.audit_logs
  WHERE (created_at < NEW.created_at)
     OR (created_at = NEW.created_at AND id < NEW.id)
  ORDER BY created_at DESC, id DESC
  LIMIT 1;

  -- prev_hash is NULL for first row; canonical function coalesces to 'GENESIS'
  NEW.prev_hash := v_prev_hash;

  -- Use canonical function for consistent hashing (inet type matches column)
  v_row_data := public.audit_row_canonical(
    NEW.id,
    NEW.user_id,
    NEW.account_id,
    NEW.action::text,
    NEW.details,
    NEW.created_at,
    NEW.request_id,
    NEW.reason,
    NEW.ip_address,  -- already inet, no cast needed
    NEW.user_agent,
    NEW.idempotency_key,
    NEW.prev_hash
  );

  NEW.row_hash := encode(digest(v_row_data::bytea, 'sha256'), 'hex');
  RETURN NEW;
END;
$$;

-- Final aligned verifier with exact same GENESIS and ordering
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
  v_expected_prev_hash text := NULL;  -- First row expects NULL (canonical handles GENESIS)
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
    
    -- Check prev_hash continuity (first row should have NULL)
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
      v_row.ip_address,  -- already inet from table
      v_row.user_agent,
      v_row.idempotency_key,
      v_row.prev_hash
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

-- Ensure audit_logs INSERT is locked to service role only (RLS already blocks, but belt + suspenders)
REVOKE INSERT ON public.audit_logs FROM authenticated;
REVOKE INSERT ON public.audit_logs FROM anon;