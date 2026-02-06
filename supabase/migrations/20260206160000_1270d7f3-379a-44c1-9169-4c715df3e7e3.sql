
-- =====================================================
-- P0 FIX: Lock profiles table to cosmetic fields only
-- Prevents users from self-modifying security-critical fields
-- =====================================================

-- Step 1: Drop the overly permissive UPDATE policy
DROP POLICY IF EXISTS "Users can update own profile" ON profiles;

-- Step 2: Create a restrictive UPDATE policy (still allows updates, but trigger guards fields)
CREATE POLICY "Users can update own profile" 
ON profiles 
FOR UPDATE 
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

-- Step 3: Create BEFORE UPDATE trigger to block sensitive field modifications
-- This is the actual enforcement — RLS can't do column-level restrictions
CREATE OR REPLACE FUNCTION public.guard_profile_sensitive_fields()
RETURNS TRIGGER AS $$
BEGIN
  -- If called by service role (SECURITY DEFINER RPCs, edge functions), allow all changes
  -- current_setting('role') = 'rls_none' when service_role bypasses RLS
  -- We check if the session role is the API caller (authenticated user)
  IF current_setting('request.jwt.claims', true) IS NULL THEN
    -- No JWT = service role or internal call, allow everything
    RETURN NEW;
  END IF;

  -- For authenticated users: block changes to security-critical fields
  IF NEW.kyc_status IS DISTINCT FROM OLD.kyc_status THEN
    RAISE EXCEPTION 'Cannot modify kyc_status directly. Use KYC verification flow.';
  END IF;

  IF NEW.kyc_verified_at IS DISTINCT FROM OLD.kyc_verified_at THEN
    RAISE EXCEPTION 'Cannot modify kyc_verified_at directly.';
  END IF;

  IF NEW.kyc_legal_name IS DISTINCT FROM OLD.kyc_legal_name THEN
    RAISE EXCEPTION 'Cannot modify kyc_legal_name directly. Use KYC verification flow.';
  END IF;

  IF NEW.lifetime_paid_total IS DISTINCT FROM OLD.lifetime_paid_total THEN
    RAISE EXCEPTION 'Cannot modify lifetime_paid_total directly.';
  END IF;

  IF NEW.payouts_frozen IS DISTINCT FROM OLD.payouts_frozen THEN
    RAISE EXCEPTION 'Cannot modify payouts_frozen directly.';
  END IF;

  IF NEW.payouts_frozen_at IS DISTINCT FROM OLD.payouts_frozen_at THEN
    RAISE EXCEPTION 'Cannot modify payouts_frozen_at directly.';
  END IF;

  IF NEW.payouts_frozen_reason IS DISTINCT FROM OLD.payouts_frozen_reason THEN
    RAISE EXCEPTION 'Cannot modify payouts_frozen_reason directly.';
  END IF;

  IF NEW.payouts_hold IS DISTINCT FROM OLD.payouts_hold THEN
    RAISE EXCEPTION 'Cannot modify payouts_hold directly.';
  END IF;

  IF NEW.payouts_hold_at IS DISTINCT FROM OLD.payouts_hold_at THEN
    RAISE EXCEPTION 'Cannot modify payouts_hold_at directly.';
  END IF;

  IF NEW.payouts_hold_reason IS DISTINCT FROM OLD.payouts_hold_reason THEN
    RAISE EXCEPTION 'Cannot modify payouts_hold_reason directly.';
  END IF;

  IF NEW.chargeback_count_90d IS DISTINCT FROM OLD.chargeback_count_90d THEN
    RAISE EXCEPTION 'Cannot modify chargeback_count_90d directly.';
  END IF;

  IF NEW.chargeback_count_365d IS DISTINCT FROM OLD.chargeback_count_365d THEN
    RAISE EXCEPTION 'Cannot modify chargeback_count_365d directly.';
  END IF;

  IF NEW.chargeback_count_lifetime IS DISTINCT FROM OLD.chargeback_count_lifetime THEN
    RAISE EXCEPTION 'Cannot modify chargeback_count_lifetime directly.';
  END IF;

  IF NEW.last_chargeback_at IS DISTINCT FROM OLD.last_chargeback_at THEN
    RAISE EXCEPTION 'Cannot modify last_chargeback_at directly.';
  END IF;

  IF NEW.card_payments_blocked IS DISTINCT FROM OLD.card_payments_blocked THEN
    RAISE EXCEPTION 'Cannot modify card_payments_blocked directly.';
  END IF;

  -- Also prevent changing user_id or email (identity fields)
  IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'Cannot modify user_id.';
  END IF;

  IF NEW.email IS DISTINCT FROM OLD.email THEN
    RAISE EXCEPTION 'Cannot modify email directly. Use auth provider.';
  END IF;

  -- Allowed fields: full_name, avatar_url (cosmetic only)
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Step 4: Attach trigger
DROP TRIGGER IF EXISTS guard_profile_fields ON profiles;

CREATE TRIGGER guard_profile_fields
  BEFORE UPDATE ON profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_profile_sensitive_fields();
