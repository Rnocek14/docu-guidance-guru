# Worst-Case Economic Collapse Simulation Scenarios

> **Classification:** Model Validation  
> **Owner:** Platform Administrator  
> **Version:** v1.0  
> **Created:** 2026-02-17  
> **Status:** Pre-launch analysis

---

## Purpose

This document defines adversarial economic scenarios to stress-test platform profitability using the existing Monte Carlo engine (`/admin/monte-carlo`). Each scenario has specific parameters, expected outcomes, and the system response that should trigger.

**Core question each scenario answers:** *"At what point does the platform lose money, and does the breaker catch it?"*

---

## Baseline Parameters (Starter Tier)

| Parameter | Value |
|-----------|-------|
| Entry fee | $149 |
| Account size | $50,000 |
| Profit target | 10% ($5,000) |
| Max daily loss | 5% ($2,500) |
| Max trailing drawdown | 10% ($5,000) |
| First payout cap | $300 |
| Lifetime cap | 7× entry fee = $1,043 |
| Payout split | 80% |
| Payout cooldown | 30 days |
| Min trading days | 5 |
| Min profitable days between payouts | Required |
| Reset fee | $99 |

---

## Scenario 1: Elevated Pass Rate Sustained

**Hypothesis:** Pass rate stabilizes at 18% instead of modeled 10-12%

| Parameter | Value |
|-----------|-------|
| Monthly evaluations | 100 |
| Pass rate | 18% |
| Average first payout | $300 (capped) |
| Monthly passers | 18 |
| Chargeback rate | 0% |

**Monthly P&L:**
```
Revenue:  100 × $149 = $14,900
Payouts:  18 × $300  = -$5,400 (first payout only)
─────────────────────────────
Net:      $9,500/month (still profitable)

But with lifetime payouts (subsequent months):
Additional payouts from prior cohorts:
  Month 2: 18 × 0.3 survival × $300 = -$1,620
  Month 3: accumulating...
  
Break-even pass rate (first payout only): ~50%
Break-even pass rate (with lifetime caps): ~30-35%
```

**System response expected:**
- Economic breaker should trigger at `elevated` around 18-20% pass rate
- New approvals blocked, preventing further exposure
- Existing payouts still honored

**Verdict:** ✅ Survivable. Breaker catches this.

---

## Scenario 2: Correlated Win Event (Mass Pass)

**Hypothesis:** Market spike causes 30% of active accounts to pass in same week

| Parameter | Value |
|-----------|-------|
| Active accounts | 100 |
| Accounts passing | 30 |
| First payout cap | $300 each |
| Total payout obligation | $9,000 |
| Revenue to date | ~$14,900 |

**Immediate impact:**
```
Payout obligation: 30 × $300 = $9,000
Revenue (1 month): $14,900
Reserve: $15,000

Net position after payouts: $14,900 + $15,000 - $9,000 = $20,900
```

**System response expected:**
- Breaker fires to `critical` (pass rate = 30%)
- All new approvals + payouts blocked
- Staff notification sent
- Existing obligations must still be honored (but processing is queued)

**The critical question:** Can you pay $9,000 in obligations?
- With $15,000 reserve + $14,900 revenue: **Yes**
- Without reserve: Only if revenue covers it

**Verdict:** ✅ Survivable with $15k reserve. Without reserve: 🟡 Tight.

---

## Scenario 3: Chargeback Attack + Pass Exploit

**Hypothesis:** Bad actors purchase, pass quickly, request payout, then chargeback the entry fee

| Parameter | Value |
|-----------|-------|
| Attackers | 5 |
| Entry fee charged back | 5 × $149 = $745 |
| Payouts requested | 5 × $300 = $1,500 |
| Stripe dispute fees | 5 × $15 = $75 |
| Total loss | $2,320 |

**Attack timeline:**
```
Day 1:  Purchase ($149)
Day 5:  Pass evaluation
Day 6:  Request payout ($300)
Day 7:  Payout approved
Day 8:  Payout initiated
Day 30: File chargeback on $149

Total extraction per attacker: $300 + $149 = $449
```

**System response expected:**
- `check-dispute-rate` cron detects spike
- At 5 chargebacks from 100 transactions: 5% rate → **auto-pause fires**
- Refund handler (`handleChargeRefunded`) cancels in-flight payouts
- Accounts marked `failed_confirmed`
- Staff notifications for each refund+payout conflict

**But the gap:**
- If payout is already in `paid_confirmed` state before chargeback arrives
- Loss = $449 per attacker, unrecoverable
- At 5 attackers: $2,320 loss

**Mitigation already built:**
- 30-day payout cooldown delays extraction
- `min_trading_days` = 5 slows attack
- First payout cap at $300 limits exposure per attack
- Device fingerprint clustering flags repeat attackers

**Mitigation needed:**
- Payout eligibility delay (7 days after pass) adds more buffer
- Name matching on payout method vs KYC
- Block payouts until chargeback window closes (60-90 days) — but this kills UX

**Verdict:** 🟡 Survivable at small scale. At scale (50+ attackers): 🔴 Existential without additional gates.

---

## Scenario 4: Revenue Drought + Payout Clustering

**Hypothesis:** Marketing stops working, revenue drops 80%, but existing passers still request payouts

| Parameter | Value |
|-----------|-------|
| Month 1 revenue | $14,900 (100 evals) |
| Month 2 revenue | $2,980 (20 evals) |
| Month 2 payouts from Month 1 passers | $3,600 (12 × $300) |
| Month 3 revenue | $1,490 (10 evals) |
| Month 3 payouts | $2,400 (8 × $300 subsequent) |

**Cash flow:**
```
Month 1: +$14,900 revenue, -$0 payouts = +$14,900
Month 2: +$2,980 revenue, -$3,600 payouts = -$620
Month 3: +$1,490 revenue, -$2,400 payouts = -$910
Month 4: +$1,490 revenue, -$1,200 payouts = +$290

Cumulative: $14,900 - $620 - $910 + $290 = $13,660
```

**System response expected:**
- Liability alert fires when net buffer approaches zero
- Breaker does NOT fire (pass rate is fine, it's a revenue problem)
- No automated protection for revenue drought

**Verdict:** ✅ Survivable — revenue drought is slow bleed, not sudden death. $15k reserve provides 6+ months runway at this burn rate.

---

## Scenario 5: AI Model Drift (Edge Score False Positives)

**Hypothesis:** Edge score flags 50% of legitimate traders for review, creating support backlog

| Parameter | Value |
|-----------|-------|
| Accounts flagged incorrectly | 25 of 50 |
| Support tickets generated | 25 |
| Average resolution time | 2 hours each |
| Total ops time | 50 hours |
| Revenue impact | None (no money lost) |

**Impact:**
- No financial loss (edge score is advisory only)
- Massive operational burden for solo operator
- Reputational risk if traders feel unfairly scrutinized
- Payout delays for flagged accounts

**System response expected:**
- Edge score does NOT auto-deny payouts (AI governance constraint)
- Human reviews required for all flagged accounts
- System continues to function, just slowly

**Verdict:** ✅ Not financially dangerous. Operationally painful. Self-correcting (adjust thresholds).

---

## Scenario 6: Stripe Termination (Existential)

**Hypothesis:** Stripe terminates account, freezes $10,000 balance for 120 days

| Parameter | Value |
|-----------|-------|
| Stripe balance frozen | $10,000 |
| Outstanding payout obligations | $3,000 |
| Active evaluations | 40 |
| Monthly burn rate | ~$100 |
| Reserve (separate account) | $15,000 |

**Impact:**
```
Available funds: $15,000 (reserve) - $10,000 was in Stripe
Actual available: $15,000 (if reserve is separate from Stripe)

Obligations:
  Payouts: -$3,000
  4 months burn: -$400
  ───────────────
  Remaining: $11,600

If Stripe returns balance after 120 days: +$10,000
Final: $21,600
```

**Verdict:** ✅ Survivable IF reserve is in separate bank account AND secondary processor is ready. See `docs/STRIPE_SURVIVAL_STRATEGY.md`.

---

## Scenario 7: Coordinated Collusion Ring (5 Accounts)

**Hypothesis:** Same person creates 5 accounts, trades opposite positions across them to guarantee some pass

| Parameter | Value |
|-----------|-------|
| Accounts created | 5 |
| Entry fees paid | 5 × $149 = $745 |
| Expected passes (hedged) | 2-3 |
| Payout attempts | 2-3 × $300 = $600-$900 |
| Net extraction | $600 - $745 = -$145 to $900 - $745 = +$155 |

**Analysis:**
- With $300 first payout cap and $149 entry fee:
  - 2 passes: $600 payout - $745 fees = **-$145 (attacker loses)**
  - 3 passes: $900 payout - $745 fees = **+$155 (small profit)**
- **The first payout cap is the structural defense**

**System response expected:**
- Device fingerprint clustering should link all 5 accounts
- `fraud_reviews` created for cluster
- Payouts held pending review
- If fingerprints are evaded (different devices/IPs): detection is manual only

**Verdict:** ✅ Structurally unprofitable for attacker at current caps. Detection depends on fingerprint system quality.

---

## Scenario 8: Black Swan — 50% Pass Rate Spike

**Hypothesis:** Unprecedented market move, 50 of 100 accounts pass in one week

| Parameter | Value |
|-----------|-------|
| Accounts passing | 50 |
| Payout obligation (all first) | 50 × $300 = $15,000 |
| Revenue to date | $14,900 |
| Reserve | $15,000 |

**Cash flow:**
```
Revenue: $14,900
Reserve: $15,000
Total available: $29,900
Payout obligation: -$15,000
Remaining: $14,900
```

**System response:**
- Breaker fires to `critical` IMMEDIATELY
- All approvals and payouts blocked
- Staff notification: emergency
- But obligation still exists — you owe the money once accounts clear review

**Can you pay?** Yes, with reserve. But you've burned your entire reserve.

**Verdict:** 🟡 Survivable once. A second event would be terminal without replenishment.

---

## Summary: Break Points

| Scenario | Pass Rate | Survivable? | Breaker Catches? | Reserve Needed |
|----------|-----------|-------------|-------------------|----------------|
| 1. Elevated sustained | 18% | ✅ Yes | ✅ Yes | $5,000 |
| 2. Correlated mass pass | 30% | ✅ Yes | ✅ Yes | $10,000 |
| 3. Chargeback attack | N/A | 🟡 Mostly | ✅ Partially | $5,000 |
| 4. Revenue drought | 10% | ✅ Yes | ❌ No | $10,000 |
| 5. AI drift | N/A | ✅ Yes | N/A | $0 |
| 6. Stripe termination | N/A | ✅ If prepared | ❌ No | $15,000 |
| 7. Collusion ring | N/A | ✅ Yes | ❌ Manual | $0 |
| 8. Black swan 50% | 50% | 🟡 Once | ✅ Yes | $15,000 |

### The system breaks at:

1. **Pass rate > 35% sustained** with no intake cap → payout obligations exceed revenue
2. **Stripe termination without backup** → instant revenue death
3. **Coordinated chargeback attack at scale (50+)** → financial loss + processor risk
4. **Two black swan events in sequence** → reserve depleted

### What the breaker protects against:
- High pass rates (✅)
- Excessive pending liability (✅)
- Unchecked approval volume (✅)

### What the breaker does NOT protect against:
- Revenue decline (intake problem, not pass rate problem)
- Payment processor loss (external dependency)
- Slow-bleed operational costs (not a risk engine concern)
- Reputational damage from delayed payouts (human problem)

---

## Monte Carlo Engine Integration

To run these scenarios through the existing engine at `/admin/monte-carlo`:

### Recommended Presets to Add

| Preset Name | Pass Rate | Monthly Evals | Months | Notes |
|-------------|-----------|---------------|--------|-------|
| Hostile: Elevated Pass | 18% | 100 | 12 | Tests sustained high pass rate |
| Hostile: Mass Correlation | 30% | 100 | 3 | Tests spike event |
| Hostile: Revenue Drought | 10% | 20 | 6 | Tests cash flow under low volume |
| Hostile: Scale Stress | 12% | 500 | 12 | Tests at solo-operator ceiling |
| Hostile: Black Swan | 50% | 100 | 1 | Tests single catastrophic event |

These presets should use the existing `SimulationConfig` interface and can be added to the Monte Carlo analytics page.

### Live Data Override (Post-Launch)

Once 30+ days of live data is available, simulation parameters MUST be overridden with observed values:

| Parameter | Default (Pre-Launch) | Live Override Source |
|-----------|---------------------|---------------------|
| Pass rate distribution | Triangular(5%, 10%, 18%) | `accounts` table: `COUNT(passed_at IS NOT NULL) / COUNT(*)` rolling 30d |
| First payout average | $300 (cap) | `payouts` table: `AVG(amount) WHERE status IN ('paid', 'paid_confirmed')` |
| Dispute rate | 0% | `chargeback_events`: rolling 30d count / `payment_transactions` count |
| Time to breach | 5 days | `accounts`: `AVG(failed_at - created_at) WHERE failed_at IS NOT NULL` |
| Time to pass | 15 days | `accounts`: `AVG(passed_at - created_at) WHERE passed_at IS NOT NULL` |
| Reset rate | 10% | Future: track reset purchases per user |
| Payout survival rate | 30% | `payouts`: % of passers who request subsequent payouts |

**Implementation:** The `/admin/monte-carlo` page should include a "Use Live Data" toggle that queries these values and injects them as distribution overrides, replacing the static triangular assumptions. Until n ≥ 50 completed evaluations, display a warning: "Sample size insufficient — simulation uses modeled defaults."

This is what turns Monte Carlo from "storytelling" into a "control system."

---

*Run all scenarios quarterly, or whenever cohort rules change. Update parameters to match actual observed pass rates once live data is available.*
