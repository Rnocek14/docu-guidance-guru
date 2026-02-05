# Payout System Deep Audit Report

**Date:** 2026-02-05  
**Auditor:** Senior Backend/Fintech QA + Database Reliability Engineer  
**Scope:** Payout + Income System Correctness, Security, Race-Condition Safety, and Scale Readiness

---

## A) System Readiness Score: 82/100

### Rationale

| Category | Score | Weight | Notes |
|----------|-------|--------|-------|
| **Schema & Constraints** | 85/100 | 15% | Solid enum types, good unique constraints, missing some CHECK constraints |
| **RLS & Privileges** | 90/100 | 20% | Client cannot mutate payout-critical rows, SECURITY DEFINER properly configured |
| **RPC Transaction Safety** | 80/100 | 25% | FOR UPDATE locking implemented, lock ordering documented, idempotency present |
| **State Machine Enforcement** | 85/100 | 15% | Edge function validates transitions, CHECK constraint for paid_at present |
| **Abuse/Fraud Prevention** | 75/100 | 15% | Good correlation detection, device fingerprinting, but missing velocity limits |
| **Observability & Audit** | 80/100 | 10% | Audit logs with request_id correlation, but missing payout ledger entries |

**Weighted Total:** 82/100

---

## B) Issues Prioritized

### 🔴 BLOCKERS (Must-Fix Before Production)

#### B1. Missing CHECK Constraint: `payment_reference` on Paid Status
**Table:** `payouts`  
**Issue:** CHECK constraint ensures `paid_at IS NOT NULL` when `status = 'paid'`, but no constraint for `payment_reference`.  
**Risk:** A payout could be marked paid without a payment reference, making reconciliation impossible.

```sql
-- FIX: Add constraint
ALTER TABLE public.payouts 
ADD CONSTRAINT payouts_paid_requires_payment_reference 
CHECK ((status <> 'paid') OR (payment_reference IS NOT NULL));
```

#### B2. Missing `updated_at` Trigger on `payouts` Table
**Table:** `payouts`  
**Issue:** Unlike `accounts`, `profiles`, and `user_cohort_payouts`, the `payouts` table has no `updated_at` column or trigger.  
**Risk:** Cannot track when payout records were last modified, hampering forensic analysis.

```sql
-- FIX: Add column and trigger
ALTER TABLE public.payouts ADD COLUMN updated_at timestamptz DEFAULT now();

CREATE TRIGGER update_payouts_updated_at
  BEFORE UPDATE ON public.payouts
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
```

#### B3. No Velocity Limit on Payout Requests
**File:** `supabase/functions/payout-actions/index.ts`  
**Issue:** No rate limiting on how many payout requests a user can submit per hour/day.  
**Risk:** Denial-of-service via spam payout requests, admin inbox flooding.

**Recommendation:** Add rate limiting (e.g., max 3 requests per account per 24h in pending/under_review states).

#### B4. KYC Not Gating Payouts
**Table:** `profiles.kyc_status`  
**Issue:** `calculate_payout_eligibility` does not check KYC status before allowing payouts.  
**Risk:** Money can flow to unverified identities, creating AML/compliance exposure.

```sql
-- FIX: Add to calculate_payout_eligibility RPC
SELECT kyc_status INTO _kyc_status FROM profiles WHERE user_id = _user_id;
IF _kyc_status != 'verified' THEN
  RETURN jsonb_build_object('eligible', false, 'reason', 'KYC verification required before payout');
END IF;
```

---

### 🟡 NEAR-TERM IMPROVEMENTS

#### B5. FOR UPDATE Lock on `profiles` for Consistency
**File:** `mark_payout_paid` RPC  
**Issue:** The RPC locks `payouts`, `accounts`, and `user_cohort_payouts` but not `profiles` before incrementing `lifetime_paid_total`.  
**Risk:** Under extreme concurrency, the `profiles.lifetime_paid_total` mirror could drift.

```sql
-- FIX: Add lock in mark_payout_paid before profiles update
SELECT * INTO _profile FROM profiles WHERE user_id = _account.user_id FOR UPDATE;
```

#### B6. Missing Index on `payouts.status` for Queue Queries
**Issue:** Admin review queue likely filters by `status IN ('pending', 'under_review')`.  
**Current:** Partial index exists for pending/approved but simple `status` index is missing.

```sql
-- FIX: Add index
CREATE INDEX idx_payouts_status ON public.payouts(status);
```

#### B7. No Deadlock Prevention Documentation
**Issue:** Lock order (payouts → accounts → user_cohort_payouts → profiles) is implicit but not documented.  
**Risk:** Future code changes could introduce deadlocks.

**Recommendation:** Add code comment in `mark_payout_paid`:
```sql
-- LOCK ORDER (must be consistent everywhere):
-- 1. payouts FOR UPDATE
-- 2. accounts FOR UPDATE  
-- 3. user_cohort_payouts FOR UPDATE
-- 4. profiles FOR UPDATE (if updating)
```

#### B8. Leaked Password Protection Disabled
**Source:** Supabase linter  
**Risk:** Accounts could be created with known-compromised passwords.

**Fix:** Enable in Supabase Dashboard → Auth → Security → Password Protection.

---

### 🟢 NICE-TO-HAVES

#### B9. Payout Ledger Table for Double-Entry Accounting
**Issue:** Payout history is tracked via status changes, but no formal ledger exists.  
**Benefit:** Enables reconciliation, dispute resolution, and financial reporting.

```sql
CREATE TABLE public.payout_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payout_id uuid NOT NULL REFERENCES payouts(id),
  entry_type text NOT NULL, -- 'debit' or 'credit'
  amount numeric NOT NULL,
  balance_after numeric NOT NULL,
  created_at timestamptz DEFAULT now(),
  request_id uuid
);
```

#### B10. Webhook Idempotency for External Payment Providers
**Issue:** When integrating Wise/PayPal/etc, webhook retries could cause duplicate processing.  
**Recommendation:** Add `external_payment_id` unique constraint.

#### B11. Add `FOR NO KEY UPDATE` Where Possible
**Issue:** Current `FOR UPDATE` locks are conservative and block FK checks.  
**Benefit:** `FOR NO KEY UPDATE` reduces lock contention when only updating non-key columns.

---

## C) Test Matrix

### C1. Functional Tests

| Test ID | Description | SQL Location | Status |
|---------|-------------|--------------|--------|
| F1 | Eligibility calculates correctly for passed account | `lifetime-cap-verification.sql` Step 3 | ✅ |
| F2 | First payout cap ($300) is applied | `lifetime-cap-verification.sql` Step 6-7 | ✅ |
| F3 | Lifetime cap enforcement blocks ineligible | `lifetime-cap-verification.sql` Step 6 | ✅ |
| F4 | Minimum payout ($50) rejected | `lifetime-cap-verification.sql` Step 5 | ✅ |
| F5 | Cooldown period enforced | `calculate_payout_eligibility` RPC | Implicit |
| F6 | Min trading days enforced | `calculate_payout_eligibility` RPC | Implicit |
| F7 | Pending violations block eligibility | `calculate_payout_eligibility` RPC | ✅ |
| F8 | Pending flags block eligibility | `calculate_payout_eligibility` RPC | ✅ |
| F9 | Pending fraud reviews block eligibility | `calculate_payout_eligibility` RPC | ✅ |

### C2. Race Condition Tests

| Test ID | Description | SQL Location | Expected Outcome |
|---------|-------------|--------------|------------------|
| R1 | Double-click on mark_paid (same payout) | `lifetime-cap-concurrency.sql` | Exactly one increment |
| R2 | Two payouts, headroom for one | `lifetime-cap-headroom-race.sql` | One paid, one stays approved |
| R3 | 100 concurrent mark_paid same payout | Load test (proposed) | 99 idempotent success |
| R4 | 50 concurrent mark_paid, 2 payouts | Load test (proposed) | Exactly one wins |

### C3. Security Tests

| Test ID | Description | Method | Expected |
|---------|-------------|--------|----------|
| S1 | Client cannot INSERT into user_cohort_payouts | RLS test | Blocked |
| S2 | Client cannot UPDATE payouts.amount | RLS test | Blocked |
| S3 | Client cannot call mark_payout_paid directly | RLS + RPC privilege | Blocked |
| S4 | Amount > calculated_eligible_amount rejected | Edge function | 400 error |
| S5 | Non-admin cannot approve/mark_paid | Edge function | 403 error |
| S6 | SECURITY DEFINER search_path pinned | Schema check | `public` only |

### C4. Abuse Scenario Tests

| Test ID | Scenario | Protection | Location |
|---------|----------|------------|----------|
| A1 | Repeated payout requests (spam) | Pending check in validate_payout_request | RPC |
| A2 | Concurrent approvals same payout | Status check in PAYOUT_TRANSITIONS | Edge function |
| A3 | Modify amount after approval | calculated_eligible_amount comparison | mark_payout_paid |
| A4 | Double-spend via two approved payouts | Headroom check with FOR UPDATE | mark_payout_paid |
| A5 | Cross-account correlation trading | detect_trade_correlations RPC | payout-actions |
| A6 | Device fingerprint reuse | fingerprint_hash lookup | payout-actions |
| A7 | Payout method reuse across users | method_hash lookup | payout-actions |

---

## D) Database Improvements (SQL Diffs)

### D1. Add Missing Constraints

```sql
-- Add payment_reference constraint
ALTER TABLE public.payouts 
ADD CONSTRAINT payouts_paid_requires_payment_reference 
CHECK ((status <> 'paid') OR (payment_reference IS NOT NULL));

-- Add updated_at to payouts
ALTER TABLE public.payouts ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

CREATE TRIGGER update_payouts_updated_at
  BEFORE UPDATE ON public.payouts
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Add reviewed_at NOT NULL when status is approved/rejected/paid
-- (Nice-to-have, may require data migration)
```

### D2. Add Indexes for Performance

```sql
-- Simple status index for admin queries
CREATE INDEX IF NOT EXISTS idx_payouts_status ON public.payouts(status);

-- Composite for lifetime cap queries
CREATE INDEX IF NOT EXISTS idx_user_cohort_payouts_user_cohort 
ON public.user_cohort_payouts(user_id, cohort_id);
-- (Already exists as unique constraint, so this is redundant)

-- For audit log queries by action type
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON public.audit_logs(action);
```

### D3. Upgrade Lock Mode (Optional Performance Improvement)

```sql
-- In mark_payout_paid, consider using FOR NO KEY UPDATE on accounts
-- when only updating status/balances (not cohort_id foreign key)
-- This reduces lock contention with FK checks

-- Before: SELECT * INTO _account FROM accounts WHERE id = ... FOR UPDATE;
-- After:  SELECT * INTO _account FROM accounts WHERE id = ... FOR NO KEY UPDATE;
```

---

## E) Observability Additions

### E1. Audit Log Enhancements

Current state is good with `request_id` correlation. Recommend adding:

```sql
-- Add payout_id column for direct payout audit queries
ALTER TABLE public.audit_logs ADD COLUMN payout_id uuid REFERENCES payouts(id);
CREATE INDEX idx_audit_logs_payout_id ON public.audit_logs(payout_id) WHERE payout_id IS NOT NULL;
```

### E2. Payout Ledger for Financial Reconciliation

```sql
CREATE TABLE public.payout_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payout_id uuid NOT NULL REFERENCES payouts(id),
  user_id uuid NOT NULL,
  cohort_id uuid NOT NULL REFERENCES cohorts(id),
  event_type text NOT NULL CHECK (event_type IN ('requested', 'approved', 'paid', 'rejected', 'clawback')),
  amount numeric NOT NULL,
  cohort_total_after numeric NOT NULL,
  profile_total_after numeric NOT NULL,
  created_at timestamptz DEFAULT now(),
  request_id uuid,
  metadata jsonb DEFAULT '{}'
);

ALTER TABLE public.payout_ledger ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can view ledger" ON public.payout_ledger
  FOR SELECT USING (has_any_role(auth.uid(), ARRAY['risk_officer', 'admin']));
```

### E3. Anomaly Alert Triggers

```sql
-- Create function to detect unusual payout patterns
CREATE OR REPLACE FUNCTION public.check_payout_anomalies()
RETURNS trigger AS $$
BEGIN
  -- Alert if payout amount > 5x average for this cohort
  IF NEW.status = 'approved' AND NEW.amount > (
    SELECT AVG(amount) * 5 FROM payouts p
    JOIN accounts a ON p.account_id = a.id
    WHERE a.cohort_id = (SELECT cohort_id FROM accounts WHERE id = NEW.account_id)
    AND p.status = 'paid'
  ) THEN
    INSERT INTO fraud_reviews (entity_type, entity_id, review_type, severity, details)
    VALUES ('payout', NEW.id, 'anomaly', 'high', 
            jsonb_build_object('trigger', 'amount_5x_avg', 'amount', NEW.amount));
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
```

### E4. Dashboard Metrics Queries

```sql
-- Payout health dashboard query
SELECT 
  date_trunc('day', paid_at) as day,
  COUNT(*) as payouts_count,
  SUM(amount) as total_paid,
  AVG(amount) as avg_payout,
  COUNT(*) FILTER (WHERE amount >= 300) as capped_payouts
FROM payouts
WHERE status = 'paid' AND paid_at > now() - interval '30 days'
GROUP BY 1
ORDER BY 1;

-- Cap binding rate by cohort
SELECT 
  c.name as cohort,
  c.entry_fee * c.lifetime_cap_multiple as cap_dollars,
  COUNT(*) as total_users,
  COUNT(*) FILTER (WHERE ucp.lifetime_paid_total >= c.entry_fee * c.lifetime_cap_multiple * 0.9) as near_cap,
  COUNT(*) FILTER (WHERE ucp.lifetime_paid_total >= c.entry_fee * c.lifetime_cap_multiple) as at_cap
FROM user_cohort_payouts ucp
JOIN cohorts c ON ucp.cohort_id = c.id
WHERE c.lifetime_cap_multiple IS NOT NULL
GROUP BY c.id, c.name, c.entry_fee, c.lifetime_cap_multiple;
```

---

## F) Pressure Testing Plan

### F1. Single-Payout Idempotency (100 concurrent calls)

```bash
# Using k6 or similar load testing tool
k6 run --vus 100 --iterations 100 <<EOF
import http from 'k6/http';
import { check } from 'k6';

export default function() {
  const res = http.post('https://sfxmgwkrjwuerfkqxokq.supabase.co/functions/v1/payout-actions', 
    JSON.stringify({
      action: 'mark_paid',
      payout_id: 'APPROVED_PAYOUT_UUID',
      payment_reference: 'STRESS-TEST-001',
      idempotency_key: 'STRESS-TEST-001-KEY'
    }),
    { headers: { 'Authorization': 'Bearer ADMIN_TOKEN', 'Content-Type': 'application/json' } }
  );
  check(res, { 'status is 200': (r) => r.status === 200 });
}
EOF
```

**Expected:** All 100 return success, `duplicate: true` on 99 of them.

**Metrics to Watch:**
- Postgres lock wait time (`pg_stat_activity.wait_event = 'Lock'`)
- Edge function latency P99
- No deadlocks (`pg_stat_activity.wait_event_type = 'Lock'` with conflicting PIDs)

### F2. Headroom Race (50 concurrent, 2 payouts)

```sql
-- Setup: Create 2 approved payouts for same user/cohort, prime headroom to cap - 50
-- Then run 50 concurrent mark_payout_paid calls split between A and B

-- Verify:
SELECT 
  (SELECT COUNT(*) FROM payouts WHERE id IN (A_UUID, B_UUID) AND status = 'paid') as paid_count,
  (SELECT lifetime_paid_total FROM user_cohort_payouts WHERE user_id = X AND cohort_id = Y) as total
-- Expected: paid_count = 1, total = cap
```

### F3. Scale Test (1000 users, 10 cohorts)

**Scenario:** Simulate 12 months of operations with:
- 100 new accounts/month across 10 cohorts
- 65% payout request rate among passed accounts
- Random approval delays (0-3 days)
- 5% reset rate

**Metrics:**
| Metric | Target | Alert Threshold |
|--------|--------|-----------------|
| `mark_payout_paid` P99 latency | < 500ms | > 1000ms |
| Deadlocks/hour | 0 | > 0 |
| Lock wait time P95 | < 100ms | > 500ms |
| Statement timeouts | 0 | > 0 |
| Cap enforcement violations | 0 | > 0 |

---

## G) Parity Benchmarking vs Industry

### FTMO
| Feature | FTMO | Our Platform | Gap |
|---------|------|--------------|-----|
| Profit Split | 80-90% | 80-85% | ✅ Aligned |
| First Payout Cap | Not public | $300-750 by tier | N/A |
| Lifetime Cap | Not public | 7-12x entry fee | N/A |
| Min Payout | €50 | $50 | ✅ Aligned |
| Payout Frequency | Bi-weekly minimum | 30-day cooldown | ✅ Aligned |
| KYC Required | Yes, before payout | ⚠️ **NOT ENFORCED** | **GAP** |
| Trading Days Min | 4 calendar days | 5-10 configurable | ✅ Aligned |

### Topstep
| Feature | Topstep | Our Platform | Gap |
|---------|---------|--------------|-----|
| Express Payout | After 5 days | N/A | Nice-to-have |
| Payout Method Verification | Required | Implemented | ✅ |
| Correlation Detection | Unknown | Implemented | ✅ |
| Consistency Guarantee | Unknown | FOR UPDATE locking | ✅ |

### Apex Trader Funding
| Feature | Apex | Our Platform | Gap |
|---------|------|--------------|-----|
| Same-day Approval | Offered | Manual review | Operational choice |
| Chargeback Policy | Published | Simulated in MC | ✅ |
| Dispute Resolution | 30-day window | Not formalized | **GAP** |

### Industry-Standard Engineering Practices

| Practice | Industry Standard | Our Implementation | Status |
|----------|-------------------|-------------------|--------|
| API Idempotency | Stripe-style idempotency keys | ✅ `idempotency_key` param + `request_id` | ✅ |
| Row Locking | FOR UPDATE in correct order | ✅ payouts → accounts → user_cohort_payouts | ✅ |
| SECURITY DEFINER | search_path pinned | ✅ `SET search_path = public` | ✅ |
| RLS Bypass Prevention | Only via service role | ✅ Edge functions use service role | ✅ |
| Webhook Idempotency | External payment ID | ⚠️ Not yet implemented | **FUTURE** |
| Audit Trail | Full event logging | ✅ audit_logs + account_events | ✅ |
| Rate Limiting | Per-user/per-endpoint | ⚠️ Not implemented | **GAP** |

---

## H) Summary

### Critical Path to Production

1. **Add KYC check** to `calculate_payout_eligibility` (BLOCKER)
2. **Add payment_reference CHECK constraint** (BLOCKER)
3. **Add updated_at to payouts** (BLOCKER)
4. **Enable leaked password protection** (BLOCKER)
5. **Add velocity/rate limiting** on payout requests (BLOCKER)

### Post-Launch Priorities

1. Payout ledger table for reconciliation
2. FOR NO KEY UPDATE optimization
3. Webhook idempotency for external payments
4. Dispute resolution workflow
5. Enhanced anomaly detection triggers

### Confidence Level

The system is **production-ready with the above blockers addressed**. The core transaction safety (FOR UPDATE locking, idempotency, status validation) is robust. The Monte Carlo simulation alignment with production RPCs provides high confidence in cap enforcement.

**Risk Assessment:** LOW-MEDIUM after blockers fixed. The primary residual risk is operational (admin mistakes) rather than systemic (race conditions or security bypasses).

---

*Report generated 2026-02-05. Review annually or after significant payout logic changes.*
