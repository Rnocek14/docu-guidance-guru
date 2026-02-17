# Stripe Termination Survival Strategy

> **Classification:** Existential Risk Mitigation  
> **Owner:** Platform Administrator  
> **Version:** v1.0  
> **Last reviewed:** 2026-02-17  
> **Status:** Pre-launch critical path

---

## Executive Summary

Stripe termination is the **only true kill switch** in this platform. Every other risk (pass rate spikes, abuse waves, correlation events) is manageable with existing breaker/throttle infrastructure. But if Stripe classifies the business as prohibited activity and freezes the account, **revenue stops instantly** and outstanding trader payouts may be frozen.

This document defines:
1. **Prevention** — proactive steps to maintain good standing
2. **Detection** — early warning signals
3. **72-Hour Emergency Protocol** — immediate response playbook
4. **Warm Standby Architecture** — secondary processor cutover plan
5. **Post-Termination Recovery** — business continuity

---

## 1. Prevention: Staying in Good Standing

### 1.1 Dispute Rate Defense (Already Built)

| Threshold | Auto-Action | Manual Action |
|-----------|-------------|---------------|
| < 0.20%   | None        | None          |
| ≥ 0.20%   | Staff alert | Monitor daily |
| ≥ 0.30%   | Staff alert | Investigate sources, tighten refund policy |
| ≥ 0.40%   | Staff alert | Add checkout friction, block risky BINs |
| ≥ 0.50%   | **Auto-pause inbound** | Contact Stripe proactively |

**Key system references:**
- `check-dispute-rate` edge function (cron)
- `payment_system_state.is_paused_inbound` kill switch
- `chargeback_events` table with fingerprint tracking

### 1.2 Proactive Stripe Communication Checklist

Before launch, prepare and have ready:

- [ ] Business description document: "Simulated trading evaluation platform"
- [ ] Dispute prevention documentation (this playbook + auto-pause evidence)
- [ ] Refund policy clearly displayed on checkout page
- [ ] Terms of service with clear performance reward language (not "withdrawal")
- [ ] Product descriptions use safe terminology: "Simulated trading evaluation access"
- [ ] Customer service response SLA documented
- [ ] Evidence of rules acknowledgement capture (checkout_fulfillment_queue)

### 1.3 Stripe Risk Category Awareness

**High-risk indicators Stripe watches:**
- Dispute/fraud metrics exceeding card network monitoring program thresholds (Visa VAMP combines fraud + disputes; exact thresholds vary by region and program — we maintain far stricter internal ceilings to stay well below program entry)
- High refund rate (> 10%)
- Sudden volume spikes (> 3x normal in 7 days)
- Customer complaints to Stripe support
- Regulatory complaints or legal inquiries
- Business model changes without notification

**Mitigation:**
- Keep Stripe informed of business model via dashboard or support tickets
- Volume ramp gradually (don't go from 0 to 500 checkouts/month instantly)
- Proactively issue refunds before disputes are filed (costs less than disputes)
- Monitor Stripe Radar rules and adjust as needed

---

## 2. Detection: Early Warning Signals

### 2.1 Automated Monitoring (Already Built)

| Signal | Source | Dashboard |
|--------|--------|-----------|
| Dispute rate trend | `check-dispute-rate` cron | `/admin` Dispute Card |
| Payment pause state | `payment_system_state` | `/admin/system` |
| Chargeback volume | `chargeback_events` | `/admin` |
| Transaction failures | `payment_transactions` | - |

### 2.2 Manual Monitoring (Weekly)

| Check | Where | Action Threshold |
|-------|-------|-----------------|
| Stripe Dashboard → Risk section | stripe.com/dashboard | Any warning banner |
| Stripe emails | Inbox | Any email from Stripe Risk |
| Refund rate | Stripe Dashboard → Analytics | > 8% of transactions |
| Stripe Radar blocks | Stripe Dashboard → Radar | Unusual spike |
| Account restrictions | Stripe Dashboard → Settings | Any restriction notice |

### 2.3 Pre-Termination Signals (Critical)

If you see ANY of these, activate the 72-Hour Protocol immediately:

1. **Email from Stripe Risk team** requesting business information
2. **Dashboard banner** saying "Account under review"
3. **Payout schedule changed** from rolling to manual/delayed
4. **New requirements** added to your account (additional documentation)
5. **Stripe Radar** blocking legitimate transactions at unusual rate
6. **API errors** returning `account_inactive` or similar

---

## 3. 72-Hour Emergency Protocol

### Hour 0–4: CONTAIN

```
┌─────────────────────────────────────────────┐
│  STRIPE TERMINATION EMERGENCY PROTOCOL      │
│  Priority: EXISTENTIAL                      │
│  Time-critical: YES                         │
└─────────────────────────────────────────────┘
```

**Step 1: Pause all payment flows immediately**
```sql
-- Run via Supabase SQL editor or admin-actions edge function
UPDATE payment_system_state
SET is_paused_inbound = true,
    is_paused_outbound = true,
    pause_reason = 'Stripe account emergency - processor review/termination',
    paused_at = now(),
    updated_at = now();
```

**Step 2: Document current state**
```sql
-- Snapshot outstanding obligations
SELECT
  'pending_payouts' as category,
  COUNT(*) as count,
  SUM(amount) as total_usd
FROM payouts
WHERE status IN ('pending', 'under_review', 'approved', 'payment_initiated')

UNION ALL

SELECT
  'unfulfilled_checkouts',
  COUNT(*),
  SUM(amount_cents::numeric / 100)
FROM checkout_fulfillment_queue
WHERE status IN ('queued', 'processing', 'session_created')

UNION ALL

SELECT
  'active_evaluations',
  COUNT(*),
  0
FROM accounts
WHERE status = 'active';
```

**Step 3: Assess Stripe balance**
- Check Stripe Dashboard → Balance for:
  - Available balance (can withdraw immediately)
  - Pending balance (in transit)
  - Reserve requirement (if any)
- **Attempt** immediate payout/transfer of available funds if permitted; otherwise proceed assuming a 60–120 day hold on all Stripe-held funds

**Step 4: Communicate internally**
- Log incident in `staff_notifications`:
```sql
INSERT INTO staff_notifications (notification_type, title, body, data, idempotency_key)
VALUES (
  'processor_emergency',
  '🚨🚨 STRIPE EMERGENCY PROTOCOL ACTIVATED',
  'Stripe account under review/terminated. All payment flows paused. See docs/STRIPE_SURVIVAL_STRATEGY.md for protocol.',
  '{"activated_at": "' || now()::text || '"}',
  'stripe_emergency:' || now()::date::text
);
```

### Hour 4–24: RESPOND

**Step 5: Respond to Stripe (if under review, not terminated)**

Prepare evidence package:
1. Business model explanation (use template below)
2. Dispute prevention documentation
3. Auto-pause mechanism evidence
4. Customer communication logs
5. Refund policy and terms of service
6. Volume history (gradual ramp, not sudden)

**Business Model Template for Stripe:**
```
Subject: [Account ID] - Business Model Clarification

We operate a simulated trading evaluation platform. Key points:

1. PRODUCT: We sell access to simulated trading evaluations. 
   Customers purchase evaluation access at fixed prices ($149-$349).
   No real financial instruments are traded.

2. PERFORMANCE REWARDS: Successful evaluators earn simulated 
   performance rewards (not withdrawals from deposited funds).
   These are company-funded incentive payments, similar to 
   contest prizes or performance bonuses.

3. DISPUTE PREVENTION: We have automated systems that:
   - Monitor dispute rate in real-time (7-day and 30-day windows)
   - Auto-pause new purchases if rate exceeds 0.50%
   - Require explicit rules acknowledgement before purchase
   - Track all customer interactions with full audit trail

4. REFUND POLICY: [Your refund policy details]

5. VOLUME: We are a small-scale operation processing 
   approximately [X] transactions per month with gradual growth.
```

### Hour 24–72: CUTOVER (if terminated)

**Step 6: Activate secondary processor** (see Section 4)

**Step 7: Handle outstanding obligations**

| Obligation | Action |
|-----------|--------|
| Active evaluations | Continue — these don't require Stripe |
| Pending payouts | Process via alternative method (wire, crypto, manual) |
| Unfulfilled checkouts | Refund via Stripe (if still possible) or honor manually |
| Future revenue | Route through secondary processor |

**Step 8: Customer communication**

```
Subject: Payment System Update

We are transitioning our payment processing to improve service 
reliability. During this transition:

- Your evaluation account is unaffected and continues normally
- Pending performance rewards will be processed on schedule
- New purchases are temporarily paused (estimated [X] days)

We appreciate your patience. Contact support@[domain] with questions.
```

---

## 4. Warm Standby Architecture

### 4.1 Current Architecture (Stripe-Dependent)

```
Checkout → create-checkout-session → Stripe Checkout → stripe-webhook → fulfillment
Payouts  → payout-actions → payout_payments → (manual Stripe/Wise transfer)
```

### 4.2 Abstraction Layer (Already Partially Built)

Your `payment_rails` table and `select_payment_rail` RPC already support multi-processor routing:

```
payment_rails table:
├── stripe_card (inbound, currently active)
├── [secondary_card] (inbound, warm standby)
├── wise_payout (outbound, can operate independently)
└── [crypto_payout] (outbound, future option)
```

### 4.3 Secondary Processor Evaluation Matrix

| Processor | Prop Firm Friendly | Setup Time | API Quality | Dispute Handling | Priority |
|-----------|-------------------|------------|-------------|-----------------|----------|
| **Paddle** | Yes (MoR model) | 2-4 weeks | Good | Paddle handles | ⭐ #1 |
| **Lemon Squeezy** | Likely yes | 1-2 weeks | Good | LS handles | ⭐ #2 |
| **PayPal Commerce** | Maybe | 2-3 weeks | Moderate | Self-managed | #3 |
| **Authorize.net** | Yes | 3-5 weeks | Legacy | Self-managed | #4 |
| **Crypto (USDC)** | N/A | 1 week | N/A | No disputes | Emergency only |

**Recommended primary backup: Paddle or Lemon Squeezy**
- Both operate as Merchant of Record (MoR) — disputes are against them, not you
- Significantly reduces dispute rate exposure on your processor record
- Slightly higher fees (5-8%) but existential risk reduction
- **CAVEAT:** MoR approval is not guaranteed — Paddle has tightened screening in certain verticals and has faced regulatory scrutiny. Pre-approval is required before launch, not during an emergency.
- **Do not swap one single-point-of-failure for another.** Maintain at least one MoR candidate AND one traditional gateway backup (e.g., Authorize.net) to ensure true redundancy.

### 4.4 Cutover Implementation Plan

**Pre-work (do BEFORE any emergency):**

1. **Sign up for backup processor** (Paddle recommended)
   - Get approved for "digital services / educational platform"
   - Create matching products and prices
   - Test sandbox checkout flow

2. **Add payment rail record:**
```sql
INSERT INTO payment_rails (
  rail_key, provider, is_enabled, supports_inbound, supports_outbound,
  mode, priority, currencies, methods
) VALUES (
  'paddle_card', 'paddle', false, true, false,
  'live', 200, '{USD}', '{card}'
);
```

3. **Prepare edge function variant:**
   - Create `create-checkout-session-paddle/index.ts`
   - Same metadata structure, different API
   - Same fulfillment queue integration

4. **DNS/domain preparation:**
   - Ensure your domain can point to different checkout flows
   - Consider a checkout abstraction: `/checkout` → selects processor dynamically

**Cutover steps (during emergency):**

```
1. Enable secondary rail:
   UPDATE payment_rails SET is_enabled = true WHERE rail_key = 'paddle_card';
   UPDATE payment_rails SET is_enabled = false WHERE rail_key = 'stripe_card';

2. Update APP_ORIGIN secret if needed

3. Deploy secondary checkout edge function

4. Update frontend to use new checkout function

5. Test with small transaction

6. Resume inbound payments:
   UPDATE payment_system_state SET is_paused_inbound = false;
```

**Estimated cutover time:** 2-4 hours (if pre-work is done)  
**Without pre-work:** 2-4 weeks (unacceptable)

### 4.5 Payout Independence

Payout processing is **already partially independent** of Stripe:

- `payout_payments` table tracks provider separately
- `payout-webhook-handler` is provider-agnostic in structure
- Wise, bank wire, or crypto payouts don't touch Stripe

**Action item:** Ensure at least one payout method works without Stripe before launch.

---

## 5. Financial Impact Assessment

### 5.1 Immediate Impact of Stripe Loss

| Item | Impact | Mitigation |
|------|--------|-----------|
| New revenue | **Stops immediately** | Secondary processor |
| Stripe balance | **May be frozen 60-120 days** | Withdraw proactively |
| Pending payouts | **Cannot process via Stripe** | Alternative payout rails |
| Active evaluations | **Unaffected** | No Stripe dependency |
| Refund obligations | **Complicated** | Document all outstanding |

### 5.2 Cash Flow Stress Test

**Worst case: Stripe freezes $X,000 in balance for 120 days**

Survival requires:
- Cash reserves > 3 months operating cost
- Alternative revenue stream within 2 weeks
- Payout obligations serviced from reserves

**Minimum recommended reserve before launch:** $15,000
- Covers: 3 months hosting + outstanding payout obligations
- Does NOT cover: marketing spend during transition

### 5.3 Reserve Calculation

```
Monthly burn rate:
  Supabase Pro:     $25
  Domain/DNS:       $15
  Email service:    $20
  Misc tools:       $40
  ─────────────────────
  Total:            ~$100/month

Maximum payout exposure (50 eval cap, 12% pass rate):
  6 passers × $300 first payout cap = $1,800

Recommended minimum reserve:
  3 months burn ($300) + max payout exposure ($1,800) + buffer ($900) = $3,000

Conservative reserve (recommended):
  $15,000 (covers extended Stripe freeze + scaling headroom)
```

---

## 6. Regulatory & Legal Preparation

### 6.1 Terminology Compliance (Already Enforced)

| ❌ Never Use | ✅ Always Use |
|-------------|-------------|
| Prop trading firm | Simulated trading evaluation platform |
| Funded account | Simulated performance account |
| Withdrawal | Performance reward / payout |
| Trading capital | Evaluation access |
| Investment | Evaluation fee |
| Returns | Simulated performance results |

### 6.2 Stripe Business Category

- Register as: **Digital services / Educational platform**
- NOT as: Financial services, trading, gambling
- Product description: "Simulated trading evaluation access"
- This is accurate and defensible

### 6.3 Evidence Pack for Processor Defense

The `evidence-pack` edge function can generate:
- Account event history
- Payout reasoning chain
- Rules acknowledgement proof
- Audit trail with hash chain
- Timeline of all actions

**This should be adapted for processor disputes, not just trader disputes.**

---

## 7. Pre-Launch Checklist (Stripe Survival)

### P0: Must complete before accepting real payments

- [ ] Business model document prepared (Section 3, Step 5 template)
- [ ] Safe terminology audit of all public-facing copy
- [ ] Dispute rate monitoring confirmed working (`check-dispute-rate` cron)
- [ ] Auto-pause kill switch tested (set rate to 0.5%, verify pause)
- [ ] Stripe balance auto-withdrawal enabled (don't accumulate balance)
- [ ] Cash reserve ≥ $3,000 in separate bank account
- [ ] Refund policy clearly visible on checkout page
- [ ] Rules acknowledgement flow working and logged

### P1: Complete within 30 days of launch

- [ ] Secondary processor account created and approved
- [ ] Secondary processor sandbox tested
- [ ] `payment_rails` entry for secondary processor added (disabled)
- [ ] Cutover edge function skeleton created
- [ ] Emergency protocol printed/bookmarked
- [ ] Weekly Stripe Dashboard review added to morning checklist

### P2: Complete within 90 days

- [ ] Full cutover drill executed (sandbox)
- [ ] Payout independence verified (at least one non-Stripe method)
- [ ] Stripe relationship manager contact established (if volume warrants)
- [ ] Quarterly Stripe risk review scheduled

---

## Appendix: Emergency Contact Sheet

| Contact | When | How |
|---------|------|-----|
| Stripe Support | Account questions | Dashboard → Help |
| Stripe Risk Team | Under review response | Reply to their email |
| Bank | Balance transfer | Online banking |
| Secondary Processor | Activation | Their dashboard |
| Traders (affected) | Service disruption | Email template above |
| Legal counsel | If regulatory inquiry | [TBD] |

---

*This document should be reviewed monthly during the first 6 months of operation, then quarterly thereafter.*
