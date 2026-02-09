# Operations Playbook

> **Owner:** Platform Administrator  
> **Last updated:** 2026-02-09  
> **Status:** Launch-ready  

This playbook covers every scenario where automated systems alert you and you need to act. Each runbook follows the same format: **Trigger → Severity → Steps → Verification → Escalation**.

---

## Table of Contents

1. [Daily Morning Checks](#1-daily-morning-checks)
2. [Dispute Rate Alerts](#2-dispute-rate-alerts)
3. [Economic Breaker Fired](#3-economic-breaker-fired)
4. [Liability Buffer Negative](#4-liability-buffer-negative)
5. [Payout Stuck in `payment_initiated`](#5-payout-stuck-in-payment_initiated)
6. [Stripe Account Under Review](#6-stripe-account-under-review)
7. [Cron Job Failure](#7-cron-job-failure)
8. [Abuse Wave / Coordinated Fraud](#8-abuse-wave--coordinated-fraud)
9. [Fulfillment Queue Stuck](#9-fulfillment-queue-stuck)
10. [Pass Rate Anomaly](#10-pass-rate-anomaly)
11. [Kill Switch Reference](#11-kill-switch-reference)

---

## 1. Daily Morning Checks

**Time:** First 5 minutes of your day  
**Goal:** Confirm no overnight surprises

| # | Check | Where | Expected |
|---|-------|-------|----------|
| 1 | Cron health — all jobs green | `/admin/system` → Cron Health | All green/yellow |
| 2 | Dispute rate | `/admin` → Dispute Rate Card | < 0.20% |
| 3 | Breaker state | `/admin/system` → Breaker Panel | `normal` |
| 4 | Net buffer | `/admin/liability` | Positive |
| 5 | Pending payouts | `/admin` → Stats | Reasonable count |
| 6 | Staff notifications | `staff_notifications` table | No unacked emergencies |
| 7 | Fulfillment queue | `checkout_fulfillment_queue` | No stuck `processing` rows > 10 min |

**If any check fails:** Jump to the relevant runbook below.

---

## 2. Dispute Rate Alerts

### Thresholds

| Level | Rate | Auto-action | Your action |
|-------|------|-------------|-------------|
| `ok` | < 0.20% | None | None |
| `warn` | ≥ 0.20% | Staff notification | Monitor daily |
| `high` | ≥ 0.30% | Staff notification | **Investigate sources immediately** |
| `severe` | ≥ 0.40% | Staff notification | Add checkout friction, block risky BINs |
| `emergency` | ≥ 0.50% | **Auto-pause inbound payments** | Contact Stripe, review all pending disputes |

### Runbook: `high` (0.30%+)

1. **Check the 7-day vs 30-day split** — is it a spike or a trend?
   ```sql
   SELECT * FROM cron_http_runs 
   WHERE jobname = 'check-dispute-rate' 
   ORDER BY ran_at DESC LIMIT 5;
   ```
2. **Identify dispute sources** — which users/cards are generating disputes?
   ```sql
   SELECT user_id, COUNT(*), SUM(amount) 
   FROM chargeback_events 
   WHERE occurred_at > now() - interval '30 days'
   GROUP BY user_id ORDER BY count DESC LIMIT 20;
   ```
3. **Check for pattern** — same card fingerprint, same country, same IP range?
4. **Action options:**
   - Tighten refund policy (proactive refunds reduce disputes)
   - Block specific card BINs via `payment_rails.blocked_countries`
   - Add friction: require email confirmation before checkout
5. **Document** what you found and what you changed

### Runbook: `emergency` (0.50%+ — auto-paused)

1. **DO NOT unpause** until you understand the cause
2. Inbound payments are already paused via `payment_system_state.is_paused_inbound = true`
3. Review ALL pending disputes in Stripe Dashboard
4. Contact Stripe support proactively — explain you detected the spike and paused intake
5. Only unpause when:
   - Root cause identified and addressed
   - 7-day rate trending back below 0.30%
   - You've documented the incident

### How to unpause inbound payments

```sql
UPDATE payment_system_state 
SET is_paused_inbound = false, 
    pause_reason = null, 
    paused_at = null,
    updated_at = now();
```

Or use the Admin Actions edge function with `toggle_intake`.

---

## 3. Economic Breaker Fired

The economic breaker (`econ_breaker_state`) has three escalation levels:

| Level | Effect |
|-------|--------|
| `caution` | Logged, no blocks |
| `elevated` | New approvals blocked |
| `critical` | Payouts blocked + evaluations frozen |

### Runbook: Breaker at `elevated` or `critical`

1. **Check what triggered it** — go to `/admin/system` → Breaker Panel
2. **Review the numbers:**
   ```sql
   SELECT breaker_level, rolling_pass_rate, pending_liability, 
          net_buffer, triggered_by, last_evaluated_at
   FROM econ_breaker_state;
   ```
3. **If pass rate is genuinely high** (not a data artifact):
   - Review cohort rules — are profit targets too easy?
   - Check for evaluation gaming (same user, multiple accounts)
   - Consider tightening rules via `safety_setting_changes` (requires 2-key approval)
4. **If it's a false positive** (small sample size, data lag):
   - The breaker will auto-resolve on next `daily-risk-snapshot` run
   - Do NOT manually override the breaker state
5. **If payouts are blocked and there are legitimate pending payouts:**
   - These are safe — they'll process once the breaker clears
   - Communicate to affected traders if needed

---

## 4. Liability Buffer Negative

**Trigger:** `check-liability-alert` fires, net buffer goes negative  
**Meaning:** Pending payout obligations exceed cash reserves + incoming revenue

### Runbook

1. **Assess severity:**
   ```sql
   SELECT * FROM liability_alerts WHERE is_active = true;
   ```
2. **Check pending payouts:**
   ```sql
   SELECT status, COUNT(*), SUM(amount) 
   FROM payouts 
   WHERE status IN ('pending', 'under_review', 'approved', 'payment_initiated')
   GROUP BY status;
   ```
3. **Options (in order of preference):**
   - Slow down payout approvals (don't deny — just take more time reviewing)
   - Pause new intake temporarily (`global_intake_active = false`)
   - Increase `cash_reserve` setting if you have funds available
4. **DO NOT** reject legitimate payouts to fix the buffer — this is an intake/pricing problem, not a payout problem

---

## 5. Payout Stuck in `payment_initiated`

**Trigger:** A payout has been in `payment_initiated` for > 48 hours  
**Meaning:** The payment provider webhook hasn't confirmed or failed

### Runbook

1. **Check the payout_payments record:**
   ```sql
   SELECT pp.*, p.amount, p.account_id
   FROM payout_payments pp
   JOIN payouts p ON p.id = pp.payout_id
   WHERE pp.status = 'initiated' 
   AND pp.initiated_at < now() - interval '48 hours';
   ```
2. **Check the provider dashboard** (Stripe/Wise/etc.) for the payment status
3. **If confirmed in provider but webhook missed:**
   - The `payout-webhook-handler` can be called manually with the event data
   - This will transition to `paid_confirmed` idempotently
4. **If failed in provider but webhook missed:**
   - Update via the webhook handler with failure data
   - The payout will transition to `payment_failed`
5. **Never manually UPDATE the payouts table** — always go through the webhook handler to maintain audit trail

---

## 6. Stripe Account Under Review

**Trigger:** Email from Stripe, or dashboard shows account restrictions  
**Severity:** 🚨 EXISTENTIAL

### Runbook

1. **Immediately pause inbound payments** if not already paused:
   ```sql
   UPDATE payment_system_state 
   SET is_paused_inbound = true,
       pause_reason = 'Stripe account under review',
       paused_at = now(),
       updated_at = now();
   ```
2. **Gather evidence:**
   - Export dispute history and resolution rates
   - Document your monitoring systems (this playbook!)
   - Show your auto-pause mechanism and threshold enforcement
3. **Respond to Stripe within 24 hours** with:
   - Explanation of your business model (simulated trading evaluations)
   - Your dispute prevention measures
   - Evidence of proactive monitoring
4. **Activate secondary processor plan** if you have one ready
5. **DO NOT** continue processing payments while under review

---

## 7. Cron Job Failure

**Trigger:** `/admin/system` shows red/yellow cron health  
**Jobs monitored:** `daily-risk-snapshot`, `check-dispute-rate`, `check-liability-alert`, `retry-fulfillment-queue`

### Runbook

1. **Check recent runs:**
   ```sql
   SELECT jobname, ran_at, http_status, 
          substring(http_content, 1, 200) as preview
   FROM cron_http_runs 
   WHERE jobname = '<failing_job>'
   ORDER BY ran_at DESC LIMIT 10;
   ```
2. **Check edge function logs** in Supabase dashboard
3. **Common causes:**
   - `CRON_SECRET` mismatch or missing → 401/503
   - Edge function deployment failed → 500
   - Database timeout on heavy queries → 504
4. **To manually trigger a missed run:**
   ```bash
   curl -X POST https://sfxmgwkrjwuerfkqxokq.supabase.co/functions/v1/<function-name> \
     -H "X-Cron-Secret: <your-cron-secret>" \
     -H "Content-Type: application/json"
   ```
5. **Verify recovery** — check `cron_http_runs` for the next successful run

---

## 8. Abuse Wave / Coordinated Fraud

**Trigger:** Multiple flags/fraud reviews appearing for linked accounts  
**Indicators:** Shared device fingerprints, same IP cluster, rapid account creation

### Runbook

1. **Assess scope:**
   ```sql
   SELECT cluster_id, COUNT(*) as device_count, 
          array_agg(DISTINCT user_id) as users
   FROM device_fingerprints 
   WHERE cluster_id IS NOT NULL
   GROUP BY cluster_id 
   HAVING COUNT(*) > 3
   ORDER BY device_count DESC;
   ```
2. **Freeze payouts for affected users** (not accounts — the user level):
   ```sql
   UPDATE profiles 
   SET payouts_hold = true, 
       payouts_hold_reason = 'Under investigation - abuse cluster',
       payouts_hold_at = now()
   WHERE user_id IN ('<affected_user_ids>');
   ```
3. **DO NOT auto-ban or auto-deny** — flag for review
4. **If the wave is active (ongoing signups):**
   - Pause global intake: set `global_intake_active = false`
   - This stops the bleeding while you investigate
5. **Document everything** — create fraud_reviews for each affected entity
6. **After investigation:** Clear holds for legitimate users, escalate confirmed fraud

---

## 9. Fulfillment Queue Stuck

**Trigger:** `checkout_fulfillment_queue` has rows in `processing` or `queued` status for > 10 minutes

### Runbook

1. **Check the queue:**
   ```sql
   SELECT id, status, attempts, last_error, 
          stripe_session_id, created_at, processing_started_at
   FROM checkout_fulfillment_queue 
   WHERE status IN ('queued', 'processing', 'failed')
   ORDER BY created_at DESC;
   ```
2. **If `processing` and stuck:**
   - Check if the retry-fulfillment-queue cron is running
   - Rows with `processing_started_at` > 10 min ago should be auto-reset
3. **If repeatedly `failed` (attempts > 3):**
   - Check `last_error` for the root cause
   - Common: breaker blocking account creation, cohort not found, duplicate session
4. **Manual retry:**
   - The `retry-fulfillment-queue` edge function handles this automatically
   - If cron is down, trigger it manually (see Cron Job Failure runbook)
5. **User impact:** The user paid but doesn't have an account yet — prioritize this

---

## 10. Pass Rate Anomaly

**Trigger:** Daily risk snapshot shows pass rate outside expected band  
**Normal range:** Depends on cohort design, but typically 5–15% for evaluation

### Runbook

1. **Check current rate:**
   ```sql
   SELECT pass_rate, passed_accounts_in_window, total_accounts_in_window,
          pass_rate_alert_level, created_at
   FROM risk_snapshots 
   WHERE snapshot_type = 'daily'
   ORDER BY created_at DESC LIMIT 7;
   ```
2. **If pass rate is HIGH (> 20%):**
   - Check if profit targets are too easy for current market conditions
   - Look for evaluation gaming patterns
   - The economic breaker should be handling this automatically
   - Consider proposing rule tightening via `safety_setting_changes`
3. **If pass rate is ZERO:**
   - Check if evaluations are actually being processed (trade ingestion working?)
   - Check if account status transitions are functioning
   - This might be a system issue, not a market issue

---

## 11. Kill Switch Reference

Quick reference for all emergency controls:

| Switch | Table | Column | Effect |
|--------|-------|--------|--------|
| Pause inbound payments | `payment_system_state` | `is_paused_inbound` | Blocks all new checkouts |
| Pause outbound payments | `payment_system_state` | `is_paused_outbound` | Blocks all payout disbursements |
| Pause new signups | `system_settings` | `global_intake_active = false` | Blocks new account creation |
| Freeze user payouts | `profiles` | `payouts_frozen = true` | Blocks specific user's payouts |
| Hold user payouts | `profiles` | `payouts_hold = true` | Soft hold, requires review |
| Block card payments | `profiles` | `card_payments_blocked = true` | Blocks specific user's card |
| Economic breaker | `econ_breaker_state` | `breaker_level` | Auto-managed, blocks approvals/payouts |

### Priority order during a crisis:

1. **Pause inbound** (stop new money in)
2. **Pause outbound** (stop money going out)
3. **Pause intake** (stop new accounts)
4. **Assess** (read this playbook)
5. **Communicate** (contact affected parties)
6. **Resolve** (fix root cause)
7. **Unpause** (in reverse order: intake → outbound → inbound)

---

## Incident Log Template

When an incident occurs, create an entry:

```
## Incident: [Title]
- **Date:** YYYY-MM-DD HH:MM UTC
- **Severity:** warn / high / critical / emergency
- **Trigger:** What alerted you
- **Impact:** What was affected (users, money, operations)
- **Actions taken:** Step-by-step what you did
- **Root cause:** Why it happened
- **Prevention:** What changes prevent recurrence
- **Resolved at:** YYYY-MM-DD HH:MM UTC
```

---

## Contact & Escalation

| Situation | Action |
|-----------|--------|
| Dispute rate > 0.30% | Investigate within 4 hours |
| Dispute rate > 0.50% | Auto-paused — investigate within 1 hour |
| Stripe contact | Respond within 24 hours |
| Stuck payout > 48h | Resolve within 4 hours |
| Breaker at critical | Review within 2 hours |
| Negative net buffer | Review within 4 hours |
| Coordinated fraud | Freeze + investigate within 2 hours |
