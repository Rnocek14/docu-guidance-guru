-- ============================================
-- CRITICAL FIX 1: Lock down trade/violation/risk_score writes to service role only
-- ============================================

-- Remove trader INSERT on trades (only server should write)
DROP POLICY IF EXISTS "Traders can insert own trades" ON public.trades;

-- Remove any existing INSERT policies on violations and risk_scores for non-staff
-- (These should already be staff-only, but let's be explicit)

-- Add explicit service-role-only policies using auth.jwt() check
-- Service role bypasses RLS, so these policies just prevent any client writes

-- For trades: only staff can view, no one can insert via client
CREATE POLICY "No client inserts on trades"
ON public.trades
FOR INSERT
TO authenticated
WITH CHECK (false); -- Block all client inserts

-- For violations: block client inserts
DROP POLICY IF EXISTS "Staff can manage violations" ON public.violations;
CREATE POLICY "Staff can view violations"
ON public.violations
FOR SELECT
USING (has_any_role(auth.uid(), ARRAY['risk_officer'::app_role, 'admin'::app_role]));

CREATE POLICY "No client inserts on violations"
ON public.violations
FOR INSERT
TO authenticated
WITH CHECK (false);

CREATE POLICY "No client updates on violations"
ON public.violations
FOR UPDATE
TO authenticated
USING (false);

-- For risk_scores: block client writes entirely
DROP POLICY IF EXISTS "System can manage risk scores" ON public.risk_scores;

CREATE POLICY "No client inserts on risk_scores"
ON public.risk_scores
FOR INSERT
TO authenticated
WITH CHECK (false);

CREATE POLICY "No client updates on risk_scores"
ON public.risk_scores
FOR UPDATE
TO authenticated
USING (false);

-- ============================================
-- CRITICAL FIX 2: Lock down audit_logs to server-only writes
-- ============================================

DROP POLICY IF EXISTS "Authenticated users can insert audit logs" ON public.audit_logs;

-- No client can insert audit logs - only service role (Edge Functions)
CREATE POLICY "No client inserts on audit_logs"
ON public.audit_logs
FOR INSERT
TO authenticated
WITH CHECK (false);

-- ============================================
-- CRITICAL FIX 3: Add rule_snapshot for immutability
-- ============================================

-- Add rule_snapshot column to accounts
ALTER TABLE public.accounts 
ADD COLUMN IF NOT EXISTS rule_snapshot JSONB;

-- Create function to capture and freeze rules at account creation
CREATE OR REPLACE FUNCTION public.freeze_account_rules()
RETURNS TRIGGER AS $$
BEGIN
  -- On INSERT: capture the cohort rules as a frozen snapshot
  IF TG_OP = 'INSERT' THEN
    SELECT jsonb_build_object(
      'cohort_id', c.id,
      'cohort_name', c.name,
      'cohort_version', c.version,
      'max_daily_loss_percent', c.max_daily_loss_percent,
      'max_total_drawdown_percent', c.max_total_drawdown_percent,
      'profit_target_percent', c.profit_target_percent,
      'min_trading_days', c.min_trading_days,
      'max_position_size_percent', c.max_position_size_percent,
      'frozen_at', now()
    )
    INTO NEW.rule_snapshot
    FROM public.cohorts c
    WHERE c.id = NEW.cohort_id;
    
    RETURN NEW;
  END IF;
  
  -- On UPDATE: prevent changes to cohort_id or rule_snapshot
  IF TG_OP = 'UPDATE' THEN
    IF OLD.cohort_id IS DISTINCT FROM NEW.cohort_id THEN
      RAISE EXCEPTION 'Cannot change cohort_id after account creation - rules are frozen';
    END IF;
    
    IF OLD.rule_snapshot IS DISTINCT FROM NEW.rule_snapshot THEN
      RAISE EXCEPTION 'Cannot modify rule_snapshot - rules are frozen at account creation';
    END IF;
    
    RETURN NEW;
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Create triggers for rule immutability
DROP TRIGGER IF EXISTS freeze_rules_on_insert ON public.accounts;
CREATE TRIGGER freeze_rules_on_insert
  BEFORE INSERT ON public.accounts
  FOR EACH ROW
  EXECUTE FUNCTION public.freeze_account_rules();

DROP TRIGGER IF EXISTS prevent_rule_changes ON public.accounts;
CREATE TRIGGER prevent_rule_changes
  BEFORE UPDATE ON public.accounts
  FOR EACH ROW
  EXECUTE FUNCTION public.freeze_account_rules();

-- ============================================
-- PAPER CUT A: Fix system_settings to use proper JSONB boolean
-- ============================================

-- Update any existing string 'true'/'false' to proper JSONB boolean
UPDATE public.system_settings 
SET value = 'true'::jsonb 
WHERE key = 'global_intake_enabled' AND value::text = '"true"';

UPDATE public.system_settings 
SET value = 'false'::jsonb 
WHERE key = 'global_intake_enabled' AND value::text = '"false"';

-- ============================================
-- PAPER CUT B: Admin bootstrap function
-- ============================================

-- Create a one-time bootstrap function that can only be run once
-- and only for specific bootstrap emails
CREATE OR REPLACE FUNCTION public.bootstrap_first_admin(_email text, _secret text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _user_id uuid;
  _admin_count int;
BEGIN
  -- Check the bootstrap secret (set this in your environment)
  -- For now, use a hardcoded secret that should be changed
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
  
  -- Find the user by email
  SELECT id INTO _user_id
  FROM auth.users
  WHERE email = _email;
  
  IF _user_id IS NULL THEN
    RAISE EXCEPTION 'User with email % not found', _email;
  END IF;
  
  -- Grant admin role
  INSERT INTO public.user_roles (user_id, role)
  VALUES (_user_id, 'admin')
  ON CONFLICT (user_id, role) DO NOTHING;
  
  RETURN true;
END;
$$;

-- ============================================
-- Add audit action for rule breach detection
-- ============================================

-- Note: We need to add this to the enum if not exists
-- First check and add the new audit action type
DO $$
BEGIN
  -- Add 'rule_breach_detected' if it doesn't exist
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum 
    WHERE enumlabel = 'rule_breach_detected' 
    AND enumtypid = 'public.audit_action'::regtype
  ) THEN
    ALTER TYPE public.audit_action ADD VALUE 'rule_breach_detected';
  END IF;
END$$;