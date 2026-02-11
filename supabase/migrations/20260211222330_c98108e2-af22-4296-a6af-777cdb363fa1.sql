
-- Fix: recreate view with security_invoker = true
DROP VIEW IF EXISTS public.ai_daily_cost;

CREATE VIEW public.ai_daily_cost
WITH (security_invoker = true)
AS
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
