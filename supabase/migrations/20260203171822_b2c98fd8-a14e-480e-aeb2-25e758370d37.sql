-- AUDIT LOGS: prevent duplicate audit entries per account per request
CREATE UNIQUE INDEX IF NOT EXISTS uq_audit_logs_account_request
ON public.audit_logs (account_id, request_id)
WHERE request_id IS NOT NULL;

-- ACCOUNT EVENTS: prevent duplicate timeline events per account per request
CREATE UNIQUE INDEX IF NOT EXISTS uq_account_events_account_request
ON public.account_events (account_id, request_id)
WHERE request_id IS NOT NULL;