-- ============================================
-- FIX 4: Remove bootstrap secret (rely on SQL access only)
-- ============================================

CREATE OR REPLACE FUNCTION public.bootstrap_first_admin(_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _admin_count int;
BEGIN
  -- Check if any admin already exists
  SELECT COUNT(*) INTO _admin_count
  FROM public.user_roles
  WHERE role = 'admin';
  
  IF _admin_count > 0 THEN
    RAISE EXCEPTION 'Admin already exists - bootstrap not allowed';
  END IF;
  
  -- Grant admin role
  INSERT INTO public.user_roles (user_id, role)
  VALUES (_user_id, 'admin')
  ON CONFLICT (user_id, role) DO NOTHING;
  
  RETURN true;
END;
$$;

-- Drop old signature
DROP FUNCTION IF EXISTS public.bootstrap_first_admin(uuid, text);

-- ============================================
-- FIX 5: Update account_events policies with TO authenticated
-- ============================================

DROP POLICY IF EXISTS "No client inserts on account_events" ON public.account_events;
DROP POLICY IF EXISTS "No client updates on account_events" ON public.account_events;
DROP POLICY IF EXISTS "No client deletes on account_events" ON public.account_events;

CREATE POLICY "No client inserts on account_events"
ON public.account_events
FOR INSERT
TO authenticated
WITH CHECK (false);

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

-- ============================================
-- FIX 6: Create account_event_type enum
-- ============================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'account_event_type') THEN
    CREATE TYPE public.account_event_type AS ENUM (
      'account_created',
      'trade_ingested',
      'daily_reset',
      'breach_detected',
      'breach_confirmed',
      'failure_confirmed',
      'passed',
      'payout_requested',
      'payout_under_review',
      'payout_approved',
      'payout_rejected',
      'payout_paid',
      'status_changed'
    );
  END IF;
END$$;

-- Alter the event_type column to use the enum
-- First, drop the column and recreate with enum type
ALTER TABLE public.account_events 
  ALTER COLUMN event_type TYPE public.account_event_type 
  USING event_type::public.account_event_type;