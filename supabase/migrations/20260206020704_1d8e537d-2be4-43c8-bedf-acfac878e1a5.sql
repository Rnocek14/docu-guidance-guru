-- Final safeguard: Revoke ALL from PUBLIC on audit_logs
REVOKE ALL ON public.audit_logs FROM PUBLIC;

-- Explicitly grant only SELECT to service_role (INSERT via SECURITY DEFINER functions)
GRANT SELECT ON public.audit_logs TO service_role;
GRANT INSERT ON public.audit_logs TO service_role;

-- Final trigger with forced created_at and confirmed (created_at, id) tie-break
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
  -- Safeguard: Force created_at to now() to prevent historical row insertion attacks
  NEW.created_at := now();
  
  -- Deterministic previous row: strict (created_at, id) tie-break
  -- Matches verifier's ORDER BY created_at ASC, id ASC iteration
  SELECT row_hash
    INTO v_prev_hash
  FROM public.audit_logs
  WHERE (created_at < NEW.created_at)
     OR (created_at = NEW.created_at AND id < NEW.id)
  ORDER BY created_at DESC, id DESC
  LIMIT 1;

  -- Model A: store 'GENESIS' explicitly for first row
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
    NEW.prev_hash
  );

  NEW.row_hash := encode(digest(v_row_data::bytea, 'sha256'), 'hex');
  RETURN NEW;
END;
$$;