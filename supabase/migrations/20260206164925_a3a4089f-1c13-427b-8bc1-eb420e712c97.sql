
-- Table may already exist from partial migration, create if not
CREATE TABLE IF NOT EXISTS public.payout_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payout_id uuid NOT NULL REFERENCES payouts(id),
  provider text NOT NULL,
  provider_payment_id text,
  provider_event_id text,
  status text NOT NULL DEFAULT 'initiated' CHECK (status IN ('initiated', 'confirmed', 'failed', 'canceled')),
  amount numeric NOT NULL,
  currency text NOT NULL DEFAULT 'USD',
  initiated_by uuid NOT NULL,
  initiated_at timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz,
  failed_at timestamptz,
  failure_code text,
  failure_reason text,
  raw_webhook jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_provider_payment UNIQUE (provider, provider_payment_id),
  CONSTRAINT uq_provider_event UNIQUE (provider, provider_event_id)
);

-- Enum values may already exist from partial migration
DO $$ BEGIN
  ALTER TYPE payout_status ADD VALUE IF NOT EXISTS 'payment_initiated';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TYPE payout_status ADD VALUE IF NOT EXISTS 'paid_confirmed';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TYPE payout_status ADD VALUE IF NOT EXISTS 'payment_failed';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- RLS: enable + revoke writes from authenticated/anon, allow SELECT via policies
ALTER TABLE public.payout_payments ENABLE ROW LEVEL SECURITY;

REVOKE INSERT, UPDATE, DELETE ON public.payout_payments FROM authenticated, anon;

CREATE POLICY "Staff can view all payout payments"
  ON public.payout_payments FOR SELECT
  USING (has_any_role(auth.uid(), ARRAY['risk_officer'::app_role, 'support'::app_role, 'admin'::app_role]));

CREATE POLICY "Traders can view own payout payments"
  ON public.payout_payments FOR SELECT
  USING (payout_id IN (
    SELECT p.id FROM payouts p
    JOIN accounts a ON a.id = p.account_id
    WHERE a.user_id = auth.uid()
  ));

-- Immutability trigger
CREATE OR REPLACE FUNCTION guard_payout_payment_immutable()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status = 'confirmed' AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'Confirmed payout payments are immutable';
  END IF;
  IF OLD.status = 'confirmed' AND (
    NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at OR
    NEW.amount IS DISTINCT FROM OLD.amount OR
    NEW.provider_payment_id IS DISTINCT FROM OLD.provider_payment_id OR
    NEW.provider_event_id IS DISTINCT FROM OLD.provider_event_id
  ) THEN
    RAISE EXCEPTION 'Confirmed payout payment fields are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

CREATE TRIGGER trg_payout_payment_immutable
  BEFORE UPDATE ON payout_payments
  FOR EACH ROW
  EXECUTE FUNCTION guard_payout_payment_immutable();

-- RPC: initiate_payout_payment
CREATE OR REPLACE FUNCTION public.initiate_payout_payment(
  _payout_id uuid,
  _provider text,
  _amount numeric,
  _currency text DEFAULT 'USD',
  _initiated_by uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _payout payouts%ROWTYPE;
  _account accounts%ROWTYPE;
  _payment_id uuid;
  _actor uuid := COALESCE(_initiated_by, auth.uid());
BEGIN
  PERFORM check_payment_system_paused('outbound');

  SELECT * INTO _payout FROM payouts WHERE id = _payout_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payout not found'; END IF;

  IF _payout.status != 'approved' THEN
    RAISE EXCEPTION 'Payout must be approved to initiate payment (current: %)', _payout.status;
  END IF;

  IF _payout.approved_by = _actor THEN
    RAISE EXCEPTION 'Payment initiator cannot be the same person who approved the payout';
  END IF;

  IF _amount != _payout.amount THEN
    RAISE EXCEPTION 'Payment amount does not match approved payout amount';
  END IF;

  IF EXISTS (SELECT 1 FROM payout_payments WHERE payout_id = _payout_id AND status IN ('initiated', 'confirmed')) THEN
    RAISE EXCEPTION 'An active payment attempt already exists for this payout';
  END IF;

  INSERT INTO payout_payments (payout_id, provider, amount, currency, initiated_by, status)
  VALUES (_payout_id, _provider, _amount, _currency, _actor, 'initiated')
  RETURNING id INTO _payment_id;

  UPDATE payouts SET status = 'payment_initiated', updated_at = now() WHERE id = _payout_id;

  RETURN jsonb_build_object(
    'ok', true, 'payment_id', _payment_id, 'payout_id', _payout_id,
    'provider', _provider, 'amount', _amount, 'currency', _currency,
    'account_id', _payout.account_id
  );
END;
$$;

-- RPC: confirm_payout_payment (webhook handler)
CREATE OR REPLACE FUNCTION public.confirm_payout_payment(
  _payout_id uuid,
  _provider text,
  _provider_payment_id text,
  _provider_event_id text,
  _raw_webhook jsonb DEFAULT '{}'::jsonb,
  _confirmed_at timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _payout payouts%ROWTYPE;
  _payment payout_payments%ROWTYPE;
  _account accounts%ROWTYPE;
BEGIN
  IF EXISTS (SELECT 1 FROM payout_payments WHERE provider = _provider AND provider_event_id = _provider_event_id AND status = 'confirmed') THEN
    RETURN jsonb_build_object('ok', true, 'deduplicated', true);
  END IF;

  SELECT * INTO _payout FROM payouts WHERE id = _payout_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payout not found'; END IF;

  IF _payout.status IN ('paid', 'paid_confirmed') THEN
    RETURN jsonb_build_object('ok', true, 'deduplicated', true);
  END IF;

  IF _payout.status NOT IN ('payment_initiated', 'approved') THEN
    RAISE EXCEPTION 'Payout in unexpected status for confirmation: %', _payout.status;
  END IF;

  SELECT * INTO _payment FROM payout_payments
  WHERE payout_id = _payout_id AND provider = _provider AND status = 'initiated'
  ORDER BY initiated_at DESC LIMIT 1 FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO payout_payments (payout_id, provider, provider_payment_id, provider_event_id, amount, currency, initiated_by, status, confirmed_at, raw_webhook)
    VALUES (_payout_id, _provider, _provider_payment_id, _provider_event_id, _payout.amount, 'USD', '00000000-0000-0000-0000-000000000000'::uuid, 'confirmed', _confirmed_at, _raw_webhook);
  ELSE
    UPDATE payout_payments SET status = 'confirmed', provider_payment_id = _provider_payment_id, provider_event_id = _provider_event_id, confirmed_at = _confirmed_at, raw_webhook = _raw_webhook, updated_at = now() WHERE id = _payment.id;
  END IF;

  UPDATE payouts SET status = 'paid_confirmed', paid_at = _confirmed_at, paid_by = COALESCE(_payment.initiated_by, '00000000-0000-0000-0000-000000000000'::uuid), payment_reference = _provider_payment_id, updated_at = now() WHERE id = _payout_id;

  SELECT * INTO _account FROM accounts WHERE id = _payout.account_id;

  INSERT INTO user_cohort_payouts (user_id, cohort_id, lifetime_paid_total)
  VALUES (_account.user_id, _account.cohort_id, _payout.amount)
  ON CONFLICT (user_id, cohort_id) DO UPDATE SET lifetime_paid_total = user_cohort_payouts.lifetime_paid_total + _payout.amount, updated_at = now();

  UPDATE profiles SET lifetime_paid_total = lifetime_paid_total + _payout.amount, updated_at = now() WHERE user_id = _account.user_id;

  PERFORM reset_payout_cycle(_payout.account_id);

  RETURN jsonb_build_object('ok', true, 'deduplicated', false, 'payout_id', _payout_id, 'paid_at', _confirmed_at, 'amount', _payout.amount);
END;
$$;

-- RPC: fail_payout_payment (webhook handler on failure)
CREATE OR REPLACE FUNCTION public.fail_payout_payment(
  _payout_id uuid,
  _provider text,
  _provider_payment_id text,
  _provider_event_id text,
  _failure_code text DEFAULT NULL,
  _failure_reason text DEFAULT NULL,
  _raw_webhook jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _payment payout_payments%ROWTYPE;
BEGIN
  IF EXISTS (SELECT 1 FROM payout_payments WHERE provider = _provider AND provider_event_id = _provider_event_id) THEN
    RETURN jsonb_build_object('ok', true, 'deduplicated', true);
  END IF;

  SELECT * INTO _payment FROM payout_payments
  WHERE payout_id = _payout_id AND provider = _provider AND status = 'initiated'
  ORDER BY initiated_at DESC LIMIT 1 FOR UPDATE;

  IF FOUND THEN
    UPDATE payout_payments SET status = 'failed', provider_payment_id = _provider_payment_id, provider_event_id = _provider_event_id, failed_at = now(), failure_code = _failure_code, failure_reason = _failure_reason, raw_webhook = _raw_webhook, updated_at = now() WHERE id = _payment.id;
  ELSE
    INSERT INTO payout_payments (payout_id, provider, provider_payment_id, provider_event_id, amount, currency, initiated_by, status, failed_at, failure_code, failure_reason, raw_webhook)
    VALUES (_payout_id, _provider, _provider_payment_id, _provider_event_id, (SELECT amount FROM payouts WHERE id = _payout_id), 'USD', '00000000-0000-0000-0000-000000000000'::uuid, 'failed', now(), _failure_code, _failure_reason, _raw_webhook);
  END IF;

  UPDATE payouts SET status = 'approved', updated_at = now() WHERE id = _payout_id AND status = 'payment_initiated';

  RETURN jsonb_build_object('ok', true, 'deduplicated', false, 'payout_id', _payout_id, 'failure_code', _failure_code);
END;
$$;
