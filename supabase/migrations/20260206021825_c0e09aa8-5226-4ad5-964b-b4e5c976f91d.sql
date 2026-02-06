-- Add unique index on idempotency_key for audit deduplication
CREATE UNIQUE INDEX IF NOT EXISTS audit_logs_idempotency_key_uniq
ON public.audit_logs (idempotency_key)
WHERE idempotency_key IS NOT NULL;