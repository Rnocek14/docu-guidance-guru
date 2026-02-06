
-- Fix guard_profile_sensitive_fields: use role-based bypass, not JWT-null detection
CREATE OR REPLACE FUNCTION public.guard_profile_sensitive_fields()
RETURNS TRIGGER AS $$
DECLARE
  _role text;
BEGIN
  -- Check the request role set by PostgREST/Supabase
  _role := current_setting('request.jwt.claim_role', true);

  -- Allow service_role and supabase_admin to modify anything
  IF _role IN ('service_role', 'supabase_admin') THEN
    RETURN NEW;
  END IF;

  -- Also allow direct DB connections (migrations, superuser) where no JWT role is set
  IF _role IS NULL OR _role = '' THEN
    RETURN NEW;
  END IF;

  -- For authenticated (and anon) users: block security-critical fields
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
