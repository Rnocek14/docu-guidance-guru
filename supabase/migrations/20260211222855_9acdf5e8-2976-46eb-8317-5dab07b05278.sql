
-- 1) Add ai_status to ai_usage_log for visibility
ALTER TABLE public.ai_usage_log
  ADD COLUMN IF NOT EXISTS ai_status text NOT NULL DEFAULT 'complete';

-- 2) Idempotency: unique constraint on resend_inbound_id (skip nulls)
CREATE UNIQUE INDEX IF NOT EXISTS idx_support_emails_resend_inbound_id
  ON public.support_emails (resend_inbound_id)
  WHERE resend_inbound_id IS NOT NULL;

-- 3) Auto-send hardening columns
ALTER TABLE public.support_emails
  ADD COLUMN IF NOT EXISTS auto_send_eligible_at timestamptz,
  ADD COLUMN IF NOT EXISTS auto_send_ready boolean NOT NULL DEFAULT false;

-- 4) Support email actions audit trail
CREATE TABLE IF NOT EXISTS public.support_email_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email_id uuid NOT NULL REFERENCES public.support_emails(id),
  action_type text NOT NULL,
  actor_user_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.support_email_actions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "No client writes on support_email_actions"
  ON public.support_email_actions FOR INSERT
  WITH CHECK (false);

CREATE POLICY "No client updates on support_email_actions"
  ON public.support_email_actions FOR UPDATE
  USING (false);

CREATE POLICY "No client deletes on support_email_actions"
  ON public.support_email_actions FOR DELETE
  USING (false);

CREATE POLICY "Staff can view support email actions"
  ON public.support_email_actions FOR SELECT
  USING (has_any_role(auth.uid(), ARRAY['admin'::app_role, 'support'::app_role]));

CREATE INDEX IF NOT EXISTS idx_support_email_actions_email_id
  ON public.support_email_actions (email_id);

-- 5) O(1) daily token sum RPC
CREATE OR REPLACE FUNCTION public.get_ai_daily_token_sum(p_function_name text, p_date date DEFAULT CURRENT_DATE)
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT COALESCE(SUM(total_tokens), 0)::bigint
  FROM public.ai_usage_log
  WHERE function_name = p_function_name
    AND created_at >= p_date::timestamptz
    AND created_at < (p_date + interval '1 day')::timestamptz
$$;

-- Grant to service_role for edge function use
GRANT EXECUTE ON FUNCTION public.get_ai_daily_token_sum(text, date) TO service_role;
