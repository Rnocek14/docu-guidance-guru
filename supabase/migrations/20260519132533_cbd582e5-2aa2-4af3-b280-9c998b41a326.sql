
-- Pre-existing bug: trigger compute_audit_hash passes NEW.ip_address (text)
-- to audit_row_canonical(_ip inet, ...), which fails function resolution
-- and prevents ANY audit_logs INSERT from succeeding. The audit_logs table
-- currently has 0 rows confirming this has never worked since the column
-- type drift. Fix by aligning the canonical function signature with the
-- actual column type. Output is byte-identical since the function only
-- ever uses _ip via coalesce(_ip::text,'') — and a text-typed text cast is
-- a no-op equivalent to the original inet→text cast for any value
-- (including NULL).

CREATE OR REPLACE FUNCTION public.audit_row_canonical(
  _id uuid, _user_id uuid, _account_id uuid, _action text, _details jsonb,
  _created_at timestamp with time zone, _request_id uuid, _reason text,
  _ip text, _ua text, _idempotency text, _prev_hash text
)
RETURNS text
LANGUAGE sql
IMMUTABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT concat_ws('|',
    _id::text,
    coalesce(_user_id::text, ''),
    coalesce(_account_id::text, ''),
    coalesce(_action, ''),
    coalesce(_details::text, '{}'),
    to_char(_created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    coalesce(_request_id::text, ''),
    coalesce(_reason, ''),
    coalesce(_ip, ''),
    coalesce(_ua, ''),
    coalesce(_idempotency, ''),
    coalesce(_prev_hash, 'GENESIS')
  );
$$;

-- Drop the orphaned inet overload so resolution is unambiguous.
DROP FUNCTION IF EXISTS public.audit_row_canonical(
  uuid, uuid, uuid, text, jsonb, timestamptz, uuid, text, inet, text, text, text
);
