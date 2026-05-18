-- ============================================================
-- P1-8 Test #4 — In-transit payout preservation
--
-- A refund on an account with an in-transit payout (status =
-- 'payment_initiated') MUST:
--   - leave the payout row untouched (status still 'payment_initiated',
--     same updated_at, no review_notes injection).
--   - count the row in in_transit_payouts_count and surface its id in
--     in_transit_payouts.
--   - emit the refund_invalidated audit row regardless.
--
-- HOW TO RUN: SQL Editor as service_role.
-- ============================================================

BEGIN;

DO $$
DECLARE
  _user_id uuid;
  _cohort_id uuid;
  _account_id uuid := gen_random_uuid();
  _payout_intransit uuid := gen_random_uuid();
  _payout_pending uuid := gen_random_uuid();
  _charge_id text := 'ch_p18_intr_' || substr(gen_random_uuid()::text, 1, 8);
  _pi_id text := 'pi_p18_intr_' || substr(gen_random_uuid()::text, 1, 8);
  _session_id text := 'cs_p18_intr_' || substr(gen_random_uuid()::text, 1, 8);
  _r jsonb;
  _intransit_after record;
  _pending_after record;
  _audit_count int;
BEGIN
  SELECT user_id INTO _user_id FROM accounts LIMIT 1;
  SELECT id INTO _cohort_id FROM cohorts WHERE is_active = true LIMIT 1;
  IF _user_id IS NULL OR _cohort_id IS NULL THEN
    RAISE EXCEPTION 'Need user + active cohort';
  END IF;

  INSERT INTO accounts (id, user_id, cohort_id, account_number, status,
                        provider, provider_session_id, provider_payment_id)
  VALUES (_account_id, _user_id, _cohort_id, 'P18-IT-' || substr(_account_id::text, 1, 8),
          'passed', 'stripe', _session_id, _pi_id);

  INSERT INTO payouts (id, account_id, amount, status, updated_at)
  VALUES
    (_payout_intransit, _account_id, 1000, 'payment_initiated', now() - interval '1 hour'),
    (_payout_pending,   _account_id,  500, 'approved',          now() - interval '1 hour');

  INSERT INTO payment_transactions (user_id, provider, provider_payment_id,
                                    direction, purpose, amount, currency,
                                    status, metadata)
  VALUES (_user_id, 'stripe', _pi_id, 'inbound', 'evaluation_purchase',
          50000, 'USD', 'succeeded',
          jsonb_build_object('account_id', _account_id::text,
                             'stripe_session_id', _session_id));

  _r := handle_charge_refunded(_charge_id, _pi_id, 50000, 'USD');

  IF (_r ->> 'ok')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'Refund returned not-ok: %', _r;
  END IF;
  IF (_r ->> 'in_transit_payouts_count')::int <> 1 THEN
    RAISE EXCEPTION 'Expected 1 in-transit, got %', _r;
  END IF;
  IF (_r ->> 'cancelled_payouts_count')::int <> 1 THEN
    RAISE EXCEPTION 'Expected 1 cancelled, got %', _r;
  END IF;
  IF NOT ((_r -> 'in_transit_payouts')::jsonb @> jsonb_build_array(
            jsonb_build_object('id', _payout_intransit::text))) THEN
    RAISE EXCEPTION 'in_transit_payouts missing expected id: %', _r;
  END IF;

  -- In-transit row must be untouched
  SELECT status, updated_at, review_notes INTO _intransit_after
    FROM payouts WHERE id = _payout_intransit;
  IF _intransit_after.status <> 'payment_initiated' THEN
    RAISE EXCEPTION 'In-transit payout mutated! status=%', _intransit_after.status;
  END IF;
  IF _intransit_after.updated_at > now() - interval '30 minutes' THEN
    RAISE EXCEPTION 'In-transit updated_at moved: %', _intransit_after.updated_at;
  END IF;
  IF _intransit_after.review_notes IS NOT NULL THEN
    RAISE EXCEPTION 'In-transit review_notes was written: %', _intransit_after.review_notes;
  END IF;

  -- Pending row must be cancelled
  SELECT status, review_notes INTO _pending_after
    FROM payouts WHERE id = _payout_pending;
  IF _pending_after.status <> 'rejected' THEN
    RAISE EXCEPTION 'Pending payout NOT cancelled: status=%', _pending_after.status;
  END IF;

  -- One refund_invalidated audit row exists
  SELECT count(*) INTO _audit_count
    FROM audit_logs
   WHERE account_id = _account_id
     AND idempotency_key = format('audit.refund_invalidated:%s:%s', _charge_id, _account_id);
  IF _audit_count <> 1 THEN
    RAISE EXCEPTION 'Expected 1 refund_invalidated audit row, got %', _audit_count;
  END IF;

  RAISE NOTICE 'PASS — in-transit payout preserved, pending cancelled, audit emitted.';
END $$;

ROLLBACK;