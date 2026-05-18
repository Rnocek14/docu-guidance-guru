-- ============================================================
-- P1-8 Test #2 — Refund idempotency under serial replay
--
-- Stripe routinely re-delivers charge.refunded webhooks. The handler
-- must:
--   1. First call: invalidate the account, cancel payouts, return
--      already_processed = false.
--   2. Second call (same payment_intent): return already_processed = true,
--      NOT double-write audit_logs / account_events / payment_transactions
--      mutations.
--
-- HOW TO RUN: paste into the SQL Editor as service_role.
-- ============================================================

BEGIN;

DO $$
DECLARE
  _user_id uuid;
  _cohort_id uuid;
  _account_id uuid := gen_random_uuid();
  _payout_id uuid := gen_random_uuid();
  _charge_id text := 'ch_p18_idem_' || substr(gen_random_uuid()::text, 1, 8);
  _pi_id text := 'pi_p18_idem_' || substr(gen_random_uuid()::text, 1, 8);
  _session_id text := 'cs_p18_idem_' || substr(gen_random_uuid()::text, 1, 8);
  _r1 jsonb;
  _r2 jsonb;
  _audit_count_1 int;
  _audit_count_2 int;
  _event_count_1 int;
  _event_count_2 int;
  _txn_updated_at_1 timestamptz;
  _txn_updated_at_2 timestamptz;
BEGIN
  SELECT user_id INTO _user_id FROM accounts LIMIT 1;
  SELECT id INTO _cohort_id FROM cohorts WHERE is_active = true LIMIT 1;
  IF _user_id IS NULL OR _cohort_id IS NULL THEN
    RAISE EXCEPTION 'Need user + active cohort';
  END IF;

  INSERT INTO accounts (id, user_id, cohort_id, account_number, status,
                        provider, provider_session_id, provider_payment_id)
  VALUES (_account_id, _user_id, _cohort_id, 'P18-ID-' || substr(_account_id::text, 1, 8),
          'active', 'stripe', _session_id, _pi_id);

  INSERT INTO payouts (id, account_id, amount, status)
  VALUES (_payout_id, _account_id, 300, 'approved');

  INSERT INTO payment_transactions (user_id, provider, provider_payment_id,
                                    direction, purpose, amount, currency,
                                    status, metadata)
  VALUES (_user_id, 'stripe', _pi_id, 'inbound', 'evaluation_purchase',
          30000, 'USD', 'succeeded',
          jsonb_build_object('account_id', _account_id::text,
                             'stripe_session_id', _session_id));

  -- ── First call ────────────────────────────────────────────
  _r1 := handle_charge_refunded(_charge_id, _pi_id, 30000, 'USD');
  IF (_r1 ->> 'ok')::boolean IS NOT TRUE
     OR (_r1 ->> 'already_processed')::boolean IS NOT FALSE THEN
    RAISE EXCEPTION 'First call expected ok=true already_processed=false, got %', _r1;
  END IF;

  SELECT count(*) INTO _audit_count_1 FROM audit_logs WHERE account_id = _account_id;
  SELECT count(*) INTO _event_count_1 FROM account_events WHERE account_id = _account_id;
  SELECT updated_at INTO _txn_updated_at_1
    FROM payment_transactions WHERE provider_payment_id = _pi_id;

  -- ── Replay ────────────────────────────────────────────────
  PERFORM pg_sleep(0.05);
  _r2 := handle_charge_refunded(_charge_id, _pi_id, 30000, 'USD');

  IF (_r2 ->> 'ok')::boolean IS NOT TRUE
     OR (_r2 ->> 'already_processed')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'Second call expected ok=true already_processed=true, got %', _r2;
  END IF;

  SELECT count(*) INTO _audit_count_2 FROM audit_logs WHERE account_id = _account_id;
  SELECT count(*) INTO _event_count_2 FROM account_events WHERE account_id = _account_id;
  SELECT updated_at INTO _txn_updated_at_2
    FROM payment_transactions WHERE provider_payment_id = _pi_id;

  IF _audit_count_2 <> _audit_count_1 THEN
    RAISE EXCEPTION 'Audit logs grew on replay: % -> %', _audit_count_1, _audit_count_2;
  END IF;
  IF _event_count_2 <> _event_count_1 THEN
    RAISE EXCEPTION 'account_events grew on replay: % -> %', _event_count_1, _event_count_2;
  END IF;
  IF _txn_updated_at_2 <> _txn_updated_at_1 THEN
    RAISE EXCEPTION 'payment_transactions was re-updated on replay (% -> %)',
      _txn_updated_at_1, _txn_updated_at_2;
  END IF;

  RAISE NOTICE 'PASS — refund replay was idempotent. audit=%, events=%, txn untouched',
    _audit_count_1, _event_count_1;
END $$;

ROLLBACK;