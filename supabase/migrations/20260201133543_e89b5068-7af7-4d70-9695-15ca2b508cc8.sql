-- ============================================
-- FIX 1: Update bootstrap function to use user_id instead of email
-- ============================================

CREATE OR REPLACE FUNCTION public.bootstrap_first_admin(_user_id uuid, _secret text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _admin_count int;
BEGIN
  -- Check the bootstrap secret
  IF _secret != 'BOOTSTRAP_ADMIN_SECRET_CHANGE_ME' THEN
    RAISE EXCEPTION 'Invalid bootstrap secret';
  END IF;
  
  -- Check if any admin already exists
  SELECT COUNT(*) INTO _admin_count
  FROM public.user_roles
  WHERE role = 'admin';
  
  IF _admin_count > 0 THEN
    RAISE EXCEPTION 'Admin already exists - bootstrap not allowed';
  END IF;
  
  -- Grant admin role (user_id must exist in profiles already)
  INSERT INTO public.user_roles (user_id, role)
  VALUES (_user_id, 'admin')
  ON CONFLICT (user_id, role) DO NOTHING;
  
  RETURN true;
END;
$$;

-- Drop the old email-based function signature if it exists
DROP FUNCTION IF EXISTS public.bootstrap_first_admin(text, text);

-- ============================================
-- FIX 2: Add account_events table for transparent trader timeline
-- ============================================

CREATE TABLE IF NOT EXISTS public.account_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  event_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

-- Index for fast timeline queries
CREATE INDEX IF NOT EXISTS idx_account_events_account_id ON public.account_events(account_id);
CREATE INDEX IF NOT EXISTS idx_account_events_created_at ON public.account_events(created_at DESC);

-- Enable RLS
ALTER TABLE public.account_events ENABLE ROW LEVEL SECURITY;

-- Traders can view their own account events (transparency)
CREATE POLICY "Traders can view own account events"
ON public.account_events
FOR SELECT
USING (account_id IN (
  SELECT id FROM public.accounts WHERE user_id = auth.uid()
));

-- Staff can view all account events
CREATE POLICY "Staff can view all account events"
ON public.account_events
FOR SELECT
USING (has_any_role(auth.uid(), ARRAY['risk_officer'::app_role, 'support'::app_role, 'admin'::app_role]));

-- No client inserts - server only
CREATE POLICY "No client inserts on account_events"
ON public.account_events
FOR INSERT
TO authenticated
WITH CHECK (false);

-- No client updates or deletes
CREATE POLICY "No client updates on account_events"
ON public.account_events
FOR UPDATE
TO authenticated
USING (false);

CREATE POLICY "No client deletes on account_events"
ON public.account_events
FOR DELETE
TO authenticated
USING (false);