-- Fix search_path on audit_row_canonical (SQL function)
CREATE OR REPLACE FUNCTION public.audit_row_canonical(
  _id uuid,
  _user_id uuid,
  _account_id uuid,
  _action text,
  _details jsonb,
  _created_at timestamptz,
  _request_id uuid,
  _reason text,
  _ip text,
  _ua text,
  _idempotency text,
  _prev_hash text
) RETURNS text
LANGUAGE sql IMMUTABLE
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
    coalesce(_ip, ''),
    coalesce(_ua, ''),
    coalesce(_idempotency, ''),
    coalesce(_prev_hash, 'GENESIS')
  );
$$;