-- Replace partial unique indexes with normal unique indexes
-- (Postgres allows multiple NULLs in unique constraints, so this still works with historical null rows)

DROP INDEX IF EXISTS public.uq_audit_logs_account_request;
DROP INDEX IF EXISTS public.uq_account_events_account_request;

CREATE UNIQUE INDEX IF NOT EXISTS uq_audit_logs_account_request
ON public.audit_logs (account_id, request_id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_account_events_account_request
ON public.account_events (account_id, request_id);