
CREATE OR REPLACE FUNCTION public.compute_audit_hash()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $$
DECLARE
  v_prev_hash text;
  v_row_data text;
BEGIN
  NEW.created_at := now();

  SELECT row_hash
    INTO v_prev_hash
  FROM public.audit_logs
  WHERE (created_at < NEW.created_at)
     OR (created_at = NEW.created_at AND id < NEW.id)
  ORDER BY created_at DESC, id DESC
  LIMIT 1;

  NEW.prev_hash := coalesce(v_prev_hash, 'GENESIS');

  v_row_data := public.audit_row_canonical(
    NEW.id, NEW.user_id, NEW.account_id, NEW.action::text, NEW.details,
    NEW.created_at, NEW.request_id, NEW.reason,
    NEW.ip_address, NEW.user_agent, NEW.idempotency_key, NEW.prev_hash
  );

  NEW.row_hash := encode(extensions.digest(v_row_data::bytea, 'sha256'), 'hex');
  RETURN NEW;
END;
$$;
