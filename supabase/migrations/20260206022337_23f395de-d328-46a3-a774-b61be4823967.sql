-- Backfill existing NULL idempotency_key values with unique generated keys
UPDATE public.audit_logs
SET idempotency_key = 'backfill:' || id::text
WHERE idempotency_key IS NULL;

-- Now make idempotency_key NOT NULL
ALTER TABLE public.audit_logs
  ALTER COLUMN idempotency_key SET NOT NULL;

-- Drop the partial index (doesn't work with ON CONFLICT)
DROP INDEX IF EXISTS public.audit_logs_idempotency_key_uniq;

-- Create full unique index usable by ON CONFLICT
CREATE UNIQUE INDEX audit_logs_idempotency_key_uniq
  ON public.audit_logs (idempotency_key);

-- Optional: length check to prevent abuse
ALTER TABLE public.audit_logs
  ADD CONSTRAINT audit_idempotency_key_len CHECK (length(idempotency_key) BETWEEN 10 AND 200);