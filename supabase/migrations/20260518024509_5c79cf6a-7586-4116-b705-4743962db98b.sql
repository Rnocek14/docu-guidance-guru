DROP POLICY IF EXISTS "Anyone can insert analytics events" ON public.analytics_events;
CREATE POLICY "Anyone can insert analytics events"
ON public.analytics_events
FOR INSERT
TO public
WITH CHECK (event IS NOT NULL AND length(event) > 0 AND length(event) <= 128);

ALTER FUNCTION public.trading_day_et(timestamp with time zone, integer) SET search_path = public, pg_temp;