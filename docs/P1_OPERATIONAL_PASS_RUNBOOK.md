# P1 Operational Pass — Pre-Ship Runbook

Run this checklist after the P1-1..P1-8 batch lands in staging and before promoting to prod.
Budget: ~30 minutes end-to-end. Each step is copy-paste; record output in a scratch doc.

Owner: on-call. Sign-off: required before any further P2 batch.

---

## 0. Pre-flight

- [ ] Confirm staging DB is at head migration (`20260518014535_*`).
- [ ] Confirm staging edge functions `stripe-webhook`, `retry-fulfillment-queue`, `approve-payout` are deployed at the same commit as the migrations.
- [ ] Open a scratch doc; paste outputs of each query below verbatim.

---

## 1. `queue_precreate_failed` historical audit

Determines whether the `'session_created'` constraint expansion silently fixed a latent prod bug, or whether the prod constraint was already in sync.

```sql
-- A. Did this error ever fire in audit_logs?
SELECT
  date_trunc('day', created_at) AS day,
  count(*) AS occurrences
FROM audit_logs
WHERE action = 'queue_precreate_failed'
   OR metadata->>'error_code' = 'queue_precreate_failed'
   OR metadata->>'reason' ILIKE '%session_created%'
GROUP BY 1
ORDER BY 1 DESC
LIMIT 30;

-- B. Orphan checkout sessions stuck without a queue row?
SELECT count(*) AS orphan_sessions
FROM payment_transactions pt
WHERE pt.status = 'session_created'
  AND NOT EXISTS (
    SELECT 1 FROM fulfillment_queue fq WHERE fq.session_id = pt.stripe_session_id
  )
  AND pt.created_at > now() - interval '30 days';

-- C. Edge-function log scan (last 7 days) — run via supabase--analytics_query:
--   select timestamp, event_message from function_edge_logs
--   where event_message ilike '%queue_precreate_failed%'
--     and timestamp > now() - interval '7 days'
--   order by timestamp desc limit 100;
```

**Interpretation:**
- A > 0 in last 30d ⇒ latent bug. Note the count; cite in launch notes.
- A = 0 and B = 0 ⇒ constraint was already in sync. No action.
- B > 0 ⇒ stop. Investigate orphans before shipping.

**Follow-up (post-ship):** add `pg_dump --schema-only` diff to CI to catch constraint drift.

---

## 2. `.env` git hygiene

```bash
# Check whether .env was ever committed
git log --all --full-history -- .env | head -20
```

If output is non-empty:
1. `git rm --cached .env`
2. Verify `.gitignore` contains a leading `.env` line (not just `.env.*`)
3. **Rotate every key** that was in the file. Treat as compromised:
   - Supabase service role key
   - Stripe secret + webhook signing secret
   - Lovable API key (use `ai_gateway--rotate_lovable_api_key`)
   - Any third-party API keys
4. Update edge function secrets via the secrets tool.

**Sign-off:** every secret either confirmed never-committed OR rotated and redeployed.

---

## 3. Production env flags

- [ ] `QA_ENDPOINTS_ALLOWED=false` in prod edge function env (per P1-7).
- [ ] Confirm via `secrets--fetch_secrets`, then visually verify in dashboard.
- [ ] `RETRY_ATTEMPTS_CAP` (if exposed as env) = 24. Default in `mark_queue_error_v2` is 24 (up to 23 retries permitted, exhaust on the 24th attempt).

---

## 4. Run the 5 SQL tests against staging

Run in this order. Stop on first failure.

```bash
psql "$STAGING_DB_URL" -f supabase/tests/p1-8-hash-chain-after-refund.sql
psql "$STAGING_DB_URL" -f supabase/tests/p1-8-refund-idempotency.sql
psql "$STAGING_DB_URL" -f supabase/tests/p1-8-retry-cap-exhaustion.sql
psql "$STAGING_DB_URL" -f supabase/tests/p1-8-in-transit-payout-preservation.sql
# Test #5 is a manual 2-session test — see file header. Budget ~10 min.
psql "$STAGING_DB_URL" -f supabase/tests/p1-8-refund-approve-deadlock.sql
```

Each test ends with `RAISE NOTICE` lines summarizing pass/fail. Capture the final NOTICE block for each.

---

## 5. Cron health — `retry-fulfillment-queue` 5xx scan

The retry-cap change is the most behaviorally novel piece of the batch. The cron is where it lives.

```sql
-- via supabase--analytics_query
SELECT
  date_trunc('hour', cron_http_runs.timestamp) AS hour,
  status_code,
  count(*) AS runs
FROM cron_http_runs
WHERE function_name = 'retry-fulfillment-queue'
  AND timestamp > now() - interval '7 days'
  AND status_code >= 500
GROUP BY 1, 2
ORDER BY 1 DESC;

-- Companion: queue depth & exhausted snapshot
SELECT
  status,
  count(*) AS rows,
  min(created_at) AS oldest,
  max(attempts) AS max_attempts
FROM fulfillment_queue
WHERE created_at > now() - interval '7 days'
GROUP BY status
ORDER BY status;
```

**Interpretation:**
- Any 5xx ⇒ pull function logs for that timestamp; do not ship until explained.
- `failed_retryable_exhausted` rows > 0 ⇒ expected post-cap; confirm staff notification fired for each (`audit_logs.action = 'staff_notification_sent'`).

---

## 6. Sign-off

- [ ] All sections above completed, outputs pasted in scratch doc.
- [ ] No unexplained failures, 5xx, or orphan rows.
- [ ] On-call ack: ___________________  Date: ___________________

Ship.

---

## Appendix: rollback

If any step fails post-deploy:
1. Revert the relevant migration with a forward-only revert migration (do NOT edit existing files).
2. Redeploy prior edge function commit.
3. File incident; do not retry the batch without root-cause.
