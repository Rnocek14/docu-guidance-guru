-- Add idempotency_key to account_events for proper deduplication
-- (account_id, request_id) is not deterministic when request_id is random

-- 1. Add idempotency_key column (nullable initially for backfill)
ALTER TABLE public.account_events 
  ADD COLUMN IF NOT EXISTS idempotency_key text;

-- 2. Backfill existing rows with deterministic key from stable columns
UPDATE public.account_events 
SET idempotency_key = 'backfill:' || id::text 
WHERE idempotency_key IS NULL;

-- 3. Make it NOT NULL after backfill
ALTER TABLE public.account_events 
  ALTER COLUMN idempotency_key SET NOT NULL;

-- 4. Add unique index for ON CONFLICT deduplication
CREATE UNIQUE INDEX IF NOT EXISTS account_events_idempotency_key_uniq 
  ON public.account_events (idempotency_key);

-- 5. Add length constraint to prevent abuse (10-200 chars like audit_logs)
ALTER TABLE public.account_events 
  ADD CONSTRAINT account_events_idempotency_key_len 
  CHECK (char_length(idempotency_key) BETWEEN 10 AND 200);