
-- Add facts_used, needs_human, and safety_notes columns to support_emails
ALTER TABLE public.support_emails
  ADD COLUMN IF NOT EXISTS facts_used jsonb DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS needs_human boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS safety_notes text DEFAULT NULL;

COMMENT ON COLUMN public.support_emails.facts_used IS 'Array of account-context facts the AI cited in its draft reply';
COMMENT ON COLUMN public.support_emails.needs_human IS 'AI flagged this email as requiring human review';
COMMENT ON COLUMN public.support_emails.safety_notes IS 'AI notes on data it refused to include or escalation reasons';
