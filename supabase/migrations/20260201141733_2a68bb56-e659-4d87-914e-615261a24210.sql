-- ============================================
-- Add raw_payload storage for audit trail (PnL source-of-truth)
-- ============================================

ALTER TABLE public.trades
ADD COLUMN IF NOT EXISTS raw_payload jsonb;

-- ============================================
-- Add request_id correlation to audit_logs and account_events
-- ============================================

ALTER TABLE public.audit_logs
ADD COLUMN IF NOT EXISTS request_id uuid;

ALTER TABLE public.account_events
ADD COLUMN IF NOT EXISTS request_id uuid;

-- Index for correlation lookup
CREATE INDEX IF NOT EXISTS idx_audit_logs_request_id ON public.audit_logs(request_id);
CREATE INDEX IF NOT EXISTS idx_account_events_request_id ON public.account_events(request_id);

-- ============================================
-- Define daily reset configuration
-- ============================================

-- Add trading day boundary config (5:00 PM ET = 21:00 or 22:00 UTC depending on DST)
-- Store as system setting for flexibility
INSERT INTO public.system_settings (key, value)
VALUES ('daily_reset_timezone', '"America/New_York"'::jsonb)
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.system_settings (key, value)
VALUES ('daily_reset_hour', '17'::jsonb)  -- 5:00 PM ET (CME close)
ON CONFLICT (key) DO NOTHING;

-- ============================================
-- Add unique constraint on system_settings.key
-- ============================================

CREATE UNIQUE INDEX IF NOT EXISTS idx_system_settings_key ON public.system_settings(key);