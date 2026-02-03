-- Fix the view to use SECURITY INVOKER (respects caller's RLS)
DROP VIEW IF EXISTS public.account_last_event;

CREATE VIEW public.account_last_event 
WITH (security_invoker = on) AS
SELECT
  account_id,
  max(created_at) as last_event_at
FROM public.account_events
GROUP BY account_id;

-- Grant access
GRANT SELECT ON public.account_last_event TO authenticated;