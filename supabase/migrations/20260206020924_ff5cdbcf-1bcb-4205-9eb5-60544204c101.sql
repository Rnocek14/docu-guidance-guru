-- 1) UTC-normalized canonical function for stable timestamp rendering
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
    to_char(_created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    coalesce(_request_id::text, ''),
    coalesce(_reason, ''),
    coalesce(_ip::text, ''),
    coalesce(_ua, ''),
    coalesce(_idempotency, ''),
    coalesce(_prev_hash, 'GENESIS')
  );
$$;

-- 3) Tighten audit_logs table-level constraints
-- First update any existing NULL values to prevent constraint violations
UPDATE public.audit_logs SET prev_hash = 'GENESIS' WHERE prev_hash IS NULL;
UPDATE public.audit_logs SET row_hash = 'PLACEHOLDER' WHERE row_hash IS NULL;

-- Add NOT NULL constraints
ALTER TABLE public.audit_logs
  ALTER COLUMN prev_hash SET NOT NULL,
  ALTER COLUMN row_hash SET NOT NULL;

-- Add CHECK constraints for defense in depth
ALTER TABLE public.audit_logs
  ADD CONSTRAINT audit_prev_hash_not_empty CHECK (length(prev_hash) > 0),
  ADD CONSTRAINT audit_row_hash_len CHECK (length(row_hash) = 64);