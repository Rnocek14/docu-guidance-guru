-- Create a view for efficient last_event lookup per account
CREATE OR REPLACE VIEW public.account_last_event AS
SELECT
  account_id,
  max(created_at) as last_event_at
FROM public.account_events
GROUP BY account_id;

-- Grant access to authenticated users (view inherits base table RLS)
GRANT SELECT ON public.account_last_event TO authenticated;