
-- Support emails table for AI triage system
CREATE TABLE public.support_emails (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  from_address text NOT NULL,
  to_address text,
  subject text NOT NULL DEFAULT '',
  body_text text NOT NULL DEFAULT '',
  body_html text,
  
  -- AI classification
  tag text NOT NULL DEFAULT 'general_inquiry',
  confidence numeric NOT NULL DEFAULT 0,
  ai_summary text,
  
  -- Draft reply
  draft_reply text,
  draft_approved boolean NOT NULL DEFAULT false,
  
  -- Linked context
  matched_user_id uuid,
  matched_account_id uuid,
  
  -- Processing
  status text NOT NULL DEFAULT 'new',  -- new, drafting, ready, sent, failed, archived
  sent_at timestamp with time zone,
  sent_by uuid,
  error text,
  
  -- Resend metadata
  resend_message_id text,
  resend_inbound_id text,
  
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.support_emails ENABLE ROW LEVEL SECURITY;

-- Only staff can view
CREATE POLICY "Staff can view support emails"
  ON public.support_emails FOR SELECT
  USING (has_any_role(auth.uid(), ARRAY['support'::app_role, 'admin'::app_role]));

-- Only admins can update (approve/edit drafts)
CREATE POLICY "Staff can update support emails"
  ON public.support_emails FOR UPDATE
  USING (has_any_role(auth.uid(), ARRAY['support'::app_role, 'admin'::app_role]));

-- No client inserts (only edge function via service role)
CREATE POLICY "No client inserts on support_emails"
  ON public.support_emails FOR INSERT
  WITH CHECK (false);

-- No client deletes
CREATE POLICY "No client deletes on support_emails"
  ON public.support_emails FOR DELETE
  USING (false);

-- Index for filtering by tag and status
CREATE INDEX idx_support_emails_tag ON public.support_emails (tag);
CREATE INDEX idx_support_emails_status ON public.support_emails (status);
CREATE INDEX idx_support_emails_created ON public.support_emails (created_at DESC);

-- Trigger for updated_at
CREATE TRIGGER update_support_emails_updated_at
  BEFORE UPDATE ON public.support_emails
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();
