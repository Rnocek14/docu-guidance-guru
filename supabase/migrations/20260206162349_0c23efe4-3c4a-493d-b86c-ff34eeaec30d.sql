
-- 1. Prevent status change away from 'paid'
-- 2. Prevent nulling paid_by once paid
-- 3. Prevent changing paid_at / payment_reference once paid
-- All added to the existing guard_payout_immutable_fields trigger function

CREATE OR REPLACE FUNCTION public.guard_payout_immutable_fields()
RETURNS trigger AS $$
BEGIN
  -- approved_by immutable once set
  IF OLD.approved_by IS NOT NULL AND NEW.approved_by IS DISTINCT FROM OLD.approved_by THEN
    RAISE EXCEPTION 'approved_by is immutable once set';
  END IF;

  -- paid_by immutable once set
  IF OLD.paid_by IS NOT NULL AND NEW.paid_by IS DISTINCT FROM OLD.paid_by THEN
    RAISE EXCEPTION 'paid_by is immutable once set';
  END IF;

  -- Once paid, status is immutable
  IF OLD.status = 'paid' AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'Paid payouts are immutable; status cannot be changed';
  END IF;

  -- Once paid, paid_by cannot be nulled
  IF OLD.status = 'paid' AND NEW.paid_by IS NULL THEN
    RAISE EXCEPTION 'Cannot null paid_by on a paid payout';
  END IF;

  -- Once paid, paid_at and payment_reference are immutable
  IF OLD.status = 'paid' AND (
    NEW.paid_at IS DISTINCT FROM OLD.paid_at OR
    NEW.payment_reference IS DISTINCT FROM OLD.payment_reference
  ) THEN
    RAISE EXCEPTION 'Paid payout fields (paid_at, payment_reference) are immutable';
  END IF;

  -- Cannot null approved_by once status is paid
  IF OLD.status = 'paid' AND NEW.approved_by IS NULL THEN
    RAISE EXCEPTION 'Cannot null approved_by on a paid payout';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- 4. CHECK constraint: paid_at required when paid
ALTER TABLE public.payouts
ADD CONSTRAINT payouts_paid_at_required
CHECK ((status <> 'paid') OR (paid_at IS NOT NULL));
