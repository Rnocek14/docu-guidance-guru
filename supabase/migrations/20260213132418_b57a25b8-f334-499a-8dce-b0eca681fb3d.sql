-- Add message_id column for reply threading
ALTER TABLE public.support_emails
ADD COLUMN IF NOT EXISTS inbound_message_id text,
ADD COLUMN IF NOT EXISTS resend_message_id text;