
-- Guard against oversized event names and session IDs
ALTER TABLE public.analytics_events
  ADD CONSTRAINT chk_event_length CHECK (length(event) <= 64),
  ADD CONSTRAINT chk_session_id_length CHECK (length(session_id) <= 64);
