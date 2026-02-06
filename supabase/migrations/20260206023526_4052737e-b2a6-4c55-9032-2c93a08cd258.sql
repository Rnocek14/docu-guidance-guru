-- Add charset constraint to account_events.idempotency_key (matches audit_logs pattern)
-- Only allow alphanumeric + common safe delimiters to prevent injection/encoding issues
ALTER TABLE public.account_events 
  ADD CONSTRAINT account_events_idempotency_key_charset
  CHECK (idempotency_key ~ '^[a-zA-Z0-9:_\-\.]+$');

-- Also add the same charset constraint to audit_logs for consistency
ALTER TABLE public.audit_logs 
  ADD CONSTRAINT audit_idempotency_key_charset
  CHECK (idempotency_key ~ '^[a-zA-Z0-9:_\-\.]+$');