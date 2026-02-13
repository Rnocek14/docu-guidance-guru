
ALTER TABLE public.support_emails
  ADD COLUMN IF NOT EXISTS prompt_version text DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS context_hash text DEFAULT NULL;

COMMENT ON COLUMN public.support_emails.prompt_version IS 'Version tag of the AI system prompt used for this email';
COMMENT ON COLUMN public.support_emails.context_hash IS 'SHA-256 of the account context string provided to the AI';
