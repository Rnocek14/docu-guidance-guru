-- Drop the old partial index (redundant and confusing)
DROP INDEX IF EXISTS public.idx_audit_logs_idempotency;