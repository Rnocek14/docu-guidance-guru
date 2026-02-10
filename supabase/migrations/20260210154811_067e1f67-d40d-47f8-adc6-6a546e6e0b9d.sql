
-- Conversion tracking events table
CREATE TABLE public.analytics_events (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  user_id uuid NULL,
  session_id text NOT NULL,
  event text NOT NULL,
  path text NULL,
  props jsonb NOT NULL DEFAULT '{}'::jsonb,
  utm_source text NULL,
  utm_medium text NULL,
  utm_campaign text NULL,
  utm_content text NULL
);

-- Indexes for the 3 key reports
CREATE INDEX idx_analytics_events_event ON public.analytics_events (event);
CREATE INDEX idx_analytics_events_created_at ON public.analytics_events (created_at);
CREATE INDEX idx_analytics_events_session ON public.analytics_events (session_id);

-- Enable RLS
ALTER TABLE public.analytics_events ENABLE ROW LEVEL SECURITY;

-- Anyone (anon or auth) can insert events
CREATE POLICY "Anyone can insert analytics events"
  ON public.analytics_events
  FOR INSERT
  WITH CHECK (true);

-- Only staff can read events
CREATE POLICY "Staff can view analytics events"
  ON public.analytics_events
  FOR SELECT
  USING (has_any_role(auth.uid(), ARRAY['risk_officer'::app_role, 'admin'::app_role]));

-- No client updates
CREATE POLICY "No client updates on analytics events"
  ON public.analytics_events
  FOR UPDATE
  USING (false);

-- No client deletes
CREATE POLICY "No client deletes on analytics events"
  ON public.analytics_events
  FOR DELETE
  USING (false);
