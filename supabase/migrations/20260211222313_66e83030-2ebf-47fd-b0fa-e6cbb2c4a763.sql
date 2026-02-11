
-- AI State Tracking columns
ALTER TABLE public.support_emails
  ADD COLUMN IF NOT EXISTS ai_status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS ai_model text,
  ADD COLUMN IF NOT EXISTS ai_tokens_used integer,
  ADD COLUMN IF NOT EXISTS ai_latency_ms integer,
  ADD COLUMN IF NOT EXISTS ai_attempted_at timestamptz,
  ADD COLUMN IF NOT EXISTS ai_error text;

-- Human Override Tracking columns
ALTER TABLE public.support_emails
  ADD COLUMN IF NOT EXISTS human_override boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS override_reason text,
  ADD COLUMN IF NOT EXISTS overridden_by uuid,
  ADD COLUMN IF NOT EXISTS overridden_at timestamptz,
  ADD COLUMN IF NOT EXISTS original_tag text,
  ADD COLUMN IF NOT EXISTS original_draft_reply text;

-- Auto-send safety columns
ALTER TABLE public.support_emails
  ADD COLUMN IF NOT EXISTS auto_sendable boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS auto_send_blocked_reason text,
  ADD COLUMN IF NOT EXISTS assigned_to uuid,
  ADD COLUMN IF NOT EXISTS assigned_at timestamptz;

-- AI cost tracking table for daily caps
CREATE TABLE IF NOT EXISTS public.ai_usage_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  function_name text NOT NULL,
  model text NOT NULL,
  prompt_tokens integer NOT NULL DEFAULT 0,
  completion_tokens integer NOT NULL DEFAULT 0,
  total_tokens integer NOT NULL DEFAULT 0,
  latency_ms integer,
  estimated_cost_cents numeric NOT NULL DEFAULT 0,
  support_email_id uuid REFERENCES public.support_emails(id),
  error text
);

ALTER TABLE public.ai_usage_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "No client writes on ai_usage_log"
  ON public.ai_usage_log FOR INSERT
  WITH CHECK (false);

CREATE POLICY "No client updates on ai_usage_log"
  ON public.ai_usage_log FOR UPDATE
  USING (false);

CREATE POLICY "No client deletes on ai_usage_log"
  ON public.ai_usage_log FOR DELETE
  USING (false);

CREATE POLICY "Staff can view ai usage logs"
  ON public.ai_usage_log FOR SELECT
  USING (has_any_role(auth.uid(), ARRAY['admin'::app_role, 'risk_officer'::app_role]));

-- Daily cost summary view
CREATE OR REPLACE VIEW public.ai_daily_cost AS
SELECT
  date_trunc('day', created_at) AS day,
  function_name,
  model,
  COUNT(*) AS call_count,
  SUM(total_tokens) AS total_tokens,
  SUM(estimated_cost_cents) AS total_cost_cents,
  AVG(latency_ms)::integer AS avg_latency_ms
FROM public.ai_usage_log
GROUP BY 1, 2, 3
ORDER BY 1 DESC;

-- Index for efficient daily cost lookups
CREATE INDEX IF NOT EXISTS idx_ai_usage_log_created_at ON public.ai_usage_log (created_at);
CREATE INDEX IF NOT EXISTS idx_support_emails_ai_status ON public.support_emails (ai_status);
CREATE INDEX IF NOT EXISTS idx_support_emails_auto_sendable ON public.support_emails (auto_sendable);
