-- ============================================================
-- P1-8 Test #3 — Retry cap exhaustion (P1-3 regression guard)
--
-- Asserts:
  --   - With cap=24, mark_queue_error_v2 keeps the row in 'queued' for
  --     attempts 1..23 (retryable error path).
  --   - The 24th retryable call (attempts = cap, comparison is attempts
  --     >= cap) transitions the row to 'failed_retryable_exhausted' and
  --     returns exhausted=true. This is the canonical semantic: cap=24
  --     means "up to 23 retries permitted, exhaust on the 24th attempt"
  --     ≈ 24 × 5min cron cadence ≈ ~2 hours of breaker tolerance.
  --     (Matches the docstring in checkout-handler.ts:278.)
--   - claim_checkout_fulfillment_v2 refuses to re-pick exhausted rows.
--   - Once terminal, mark_queue_error_v2 returns no_op=true and does not
--     mutate status.
--
-- HOW TO RUN: SQL Editor as service_role.
-- ============================================================

BEGIN;

DO $$
DECLARE
  _user_id uuid;
  _queue_id uuid := gen_random_uuid();
  _session_id text := 'cs_p18_cap_' || substr(gen_random_uuid()::text, 1, 8);
  _result jsonb;
  _status text;
  _attempts int;
  i int;
  _claim record;
  _replay jsonb;
BEGIN
  SELECT user_id INTO _user_id FROM accounts LIMIT 1;
  IF _user_id IS NULL THEN
    RAISE EXCEPTION 'Need at least one user';
  END IF;

  -- Seed a claimable row in 'processing' with attempts pre-set to 1
  -- so mark_queue_error_v2 (which does NOT increment attempts) sees a
  -- realistic post-claim state. We bump attempts manually each loop to
  -- mimic the claim->fail cycle without re-running the full claim RPC.
  INSERT INTO checkout_fulfillment_queue (
    id, user_id, tier_id, stripe_session_id, provider, provider_session_id,
    status, attempts, processing_started_at
  ) VALUES (
    _queue_id, _user_id, 'starter', _session_id, 'stripe', _session_id,
    'processing', 0, now()
  );

  -- Attempts 1..23 — should stay retryable (queued); exhaustion fires AT cap.
  FOR i IN 1..23 LOOP
    UPDATE checkout_fulfillment_queue
       SET attempts = i, status = 'processing', processing_started_at = now()
     WHERE id = _queue_id;

    _result := mark_queue_error_v2(_queue_id, 'EVALUATIONS_FROZEN', true, 24);

    IF (_result ->> 'exhausted')::boolean IS TRUE THEN
      RAISE EXCEPTION 'Attempt % should NOT be exhausted (cap=24), got %', i, _result;
    END IF;
    IF (_result ->> 'next_status') <> 'queued' THEN
      RAISE EXCEPTION 'Attempt % expected next_status=queued, got %', i, _result;
    END IF;
  END LOOP;

  -- Attempt 24 — first call where attempts >= cap, must exhaust.
  UPDATE checkout_fulfillment_queue
     SET attempts = 24, status = 'processing', processing_started_at = now()
   WHERE id = _queue_id;

  _result := mark_queue_error_v2(_queue_id, 'EVALUATIONS_FROZEN', true, 24);

  IF (_result ->> 'exhausted')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'Attempt 24 (>=cap=24) MUST exhaust, got %', _result;
  END IF;
  IF (_result ->> 'next_status') <> 'failed_retryable_exhausted' THEN
    RAISE EXCEPTION 'Attempt 24 expected failed_retryable_exhausted, got %', _result;
  END IF;

  SELECT status, attempts INTO _status, _attempts
    FROM checkout_fulfillment_queue WHERE id = _queue_id;
  IF _status <> 'failed_retryable_exhausted' THEN
    RAISE EXCEPTION 'Row status should be failed_retryable_exhausted, got %', _status;
  END IF;

  -- claim_v2 must refuse to re-pick it
  SELECT * INTO _claim FROM claim_checkout_fulfillment_v2('stripe', _session_id);
  IF _claim.id IS NOT NULL THEN
    RAISE EXCEPTION 'claim_checkout_fulfillment_v2 returned an exhausted row: %', _claim;
  END IF;

  -- Terminal-state defense: another mark call should no-op
  _replay := mark_queue_error_v2(_queue_id, 'EVALUATIONS_FROZEN', true, 24);
  IF (_replay ->> 'no_op')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'Expected no_op=true on terminal row, got %', _replay;
  END IF;

  RAISE NOTICE 'PASS — cap exhausts at attempt 24, claim refuses, terminal no-op holds.';
END $$;

ROLLBACK;