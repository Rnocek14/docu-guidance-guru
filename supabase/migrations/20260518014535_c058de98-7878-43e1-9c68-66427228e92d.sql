-- ============================================================
-- P1-3: Server-side retry cap for the checkout fulfillment queue.
--
-- The classifier in checkout-handler.ts / retry-fulfillment-queue/index.ts
-- treats breaker freezes, deadlocks, timeouts, etc. as "retryable" and
-- reverts the queue row to 'queued'. Without a cap, a permanently
-- mis-classified error (e.g. a typo in a SQL function that surfaces as
-- "could not serialize") would loop forever.
--
-- This migration adds:
--   1. A new terminal status `failed_retryable_exhausted` — distinct from
--      plain `failed` so ops can spot rows that exhausted retries vs rows
--      that hit a terminal classifier match. Manual re-queue is a simple
--      UPDATE; we don't auto-revive.
--   2. `mark_queue_error_v2(queue_id, error, retryable, cap)` — DB-enforced
--      cap. The cap CANNOT be bypassed by an edge-function bug.
--   3. Updated `claim_checkout_fulfillment_v2` to exclude the new terminal
--      state so the cron worker won't pick it back up.
-- ============================================================

-- ── 1. Expand the status CHECK to include the new terminal value ──
ALTER TABLE public.checkout_fulfillment_queue
  DROP CONSTRAINT IF EXISTS checkout_fulfillment_queue_status_check;

ALTER TABLE public.checkout_fulfillment_queue
  ADD CONSTRAINT checkout_fulfillment_queue_status_check
  CHECK (status IN (
    'session_created',
    'queued',
    'processing',
    'fulfilled',
    'failed',
    'failed_retryable_exhausted',
    'refunded'
  ));

-- ── 2. Atomic error-marking RPC with built-in cap ──
-- attempts is already incremented inside claim_checkout_fulfillment_v2, so
-- by the time we get here it reflects the count INCLUDING the just-failed
-- attempt. Cap comparison is `attempts >= cap`.
CREATE OR REPLACE FUNCTION public.mark_queue_error_v2(
  p_queue_id uuid,
  p_error text,
  p_retryable boolean,
  p_cap integer DEFAULT 24
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_attempts integer;
  v_current_status text;
  v_next_status text;
  v_session_id text;
BEGIN
  -- Lock the queue row to serialise against any concurrent claim/mark.
  SELECT attempts, status, stripe_session_id
    INTO v_attempts, v_current_status, v_session_id
  FROM checkout_fulfillment_queue
  WHERE id = p_queue_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'queue_row_missing',
      'queue_id', p_queue_id
    );
  END IF;

  -- Defensive: if the row is already terminal, never reopen it.
  IF v_current_status IN ('fulfilled', 'failed', 'failed_retryable_exhausted', 'refunded') THEN
    RETURN jsonb_build_object(
      'ok', true,
      'no_op', true,
      'reason', 'already_terminal',
      'current_status', v_current_status,
      'queue_id', p_queue_id
    );
  END IF;

  -- Decide next status.
  IF NOT p_retryable THEN
    v_next_status := 'failed';
  ELSIF COALESCE(v_attempts, 0) >= GREATEST(p_cap, 1) THEN
    v_next_status := 'failed_retryable_exhausted';
  ELSE
    v_next_status := 'queued';
  END IF;

  UPDATE checkout_fulfillment_queue
     SET status = v_next_status,
         last_error = p_error,
         processing_started_at = NULL,
         updated_at = now()
   WHERE id = p_queue_id;

  RETURN jsonb_build_object(
    'ok', true,
    'queue_id', p_queue_id,
    'session_id', v_session_id,
    'previous_status', v_current_status,
    'next_status', v_next_status,
    'attempts', v_attempts,
    'cap', GREATEST(p_cap, 1),
    'retryable', p_retryable,
    'exhausted', v_next_status = 'failed_retryable_exhausted'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.mark_queue_error_v2(uuid, text, boolean, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mark_queue_error_v2(uuid, text, boolean, integer) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_queue_error_v2(uuid, text, boolean, integer) TO service_role;

COMMENT ON FUNCTION public.mark_queue_error_v2(uuid, text, boolean, integer) IS
  'P1-3: atomic next-status decision for checkout fulfillment queue rows. Caller passes the classified retryable flag; this function enforces the retry cap server-side and emits failed_retryable_exhausted as a distinct terminal state for operator visibility.';

-- ── 3. Update claim_checkout_fulfillment_v2 to exclude the new terminal ──
-- The only line that changes is the NOT IN list. Everything else is identical
-- to the previous version to keep the contract stable.
CREATE OR REPLACE FUNCTION public.claim_checkout_fulfillment_v2(
  p_provider text,
  p_provider_session_id text
)
RETURNS TABLE (
  id uuid,
  status text,
  user_id uuid,
  tier_id text,
  fulfilled_account_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  UPDATE checkout_fulfillment_queue cfq
  SET
    status = 'processing',
    processing_started_at = now(),
    attempts = COALESCE(cfq.attempts, 0) + 1,
    last_error = NULL,
    updated_at = now()
  WHERE cfq.provider = p_provider
    AND cfq.provider_session_id = p_provider_session_id
    AND cfq.fulfilled_account_id IS NULL
    AND cfq.status NOT IN ('fulfilled', 'failed', 'failed_retryable_exhausted', 'refunded')
    AND (
      cfq.status = 'queued'
      OR (cfq.status = 'processing' AND cfq.processing_started_at < now() - interval '10 minutes')
    )
  RETURNING
    cfq.id,
    cfq.status,
    cfq.user_id,
    cfq.tier_id,
    cfq.fulfilled_account_id;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_checkout_fulfillment_v2(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_checkout_fulfillment_v2(text, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_checkout_fulfillment_v2(text, text) TO service_role;