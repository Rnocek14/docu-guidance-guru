# 30-Day Controlled Launch Playbook

> **Classification:** Operational Control  
> **Owner:** Platform Administrator  
> **Version:** v1.0  
> **Created:** 2026-02-17  
> **Status:** Pre-launch

---

## Purpose

This playbook prevents **emotional scaling** — the single most common failure mode for solo-operated prop platforms. It enforces daily discipline, explicit pause triggers, and graduated scaling gates.

The core principle: **Data before ambition.**

---

## Launch Parameters

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| Initial intake cap | 50 evaluations | Statistically sufficient for pass rate signal |
| Reserve minimum | $15,000 | Covers 3 months + max payout exposure |
| Pass rate alarm | > 15% (7-day) | Exceeds model assumption of 10-12% |
| Dispute rate alarm | > 0.20% (7-day) | Stripe VAMP threshold proximity |
| Payout oversight | Manual review ALL | No auto-approval until data validates |
| Scaling gate | Week 3 earliest | Minimum 14 days behavioral data |

---

## Week 1: Smoke Test (Days 1-7)

### Goal: Confirm end-to-end lifecycle works with real users

### Daily Checklist (5 minutes)

| # | Check | Dashboard | Expected | Pause If |
|---|-------|-----------|----------|----------|
| 1 | Cron health | `/admin/system` | All green | Any red |
| 2 | Dispute rate | `/admin` → Dispute Card | 0.00% | Any dispute |
| 3 | Breaker state | `/admin/system` | `normal` | `elevated` or higher |
| 4 | Net buffer | `/admin/liability` | Positive | Negative |
| 5 | Fulfillment queue | `/admin/system` | No stuck rows | Any stuck > 10 min |
| 6 | Trade ingestion | `/admin/system` | Trades flowing | Zero trades for 48h |
| 7 | Active accounts | `/admin/system` | Growing | Zero (system issue) |

### Week 1 Targets

- [ ] First 5-10 real evaluations purchased
- [ ] Trade ingestion confirmed working (broker → ingest-trade → account updates)
- [ ] At least 1 account breaches (validates breach detection)
- [ ] Checkout → fulfillment → account creation flow confirmed
- [ ] Refund flow tested with real transaction
- [ ] Support email pipeline working (`process-support-email`)

### Week 1 Pause Triggers

| Trigger | Action | Resume When |
|---------|--------|-------------|
| Any checkout fails to fulfill within 10 min | Pause intake | Fulfillment pipeline fixed and verified |
| Trade ingestion stops for > 24h | Pause intake | Broker connection restored |
| Any dispute filed | Investigate immediately | Root cause identified and addressed |
| Breaker fires | Do NOT override | Breaker clears naturally |
| Any unfamiliar error in edge function logs | Investigate | Error understood and documented |

### Week 1 Data Collection

Record daily:
```
Day [X]:
- New evaluations: ___
- Active accounts: ___
- Trades ingested: ___
- Breaches detected: ___
- Pass rate (running): ___%
- Disputes: ___
- Support tickets: ___
- Notes: ___
```

---

## Week 2: Behavioral Calibration (Days 8-14)

### Goal: Validate that trader behavior matches model assumptions

### Additional Daily Checks

| # | Check | Expected | Alarm |
|---|-------|----------|-------|
| 8 | Pass rate (7-day rolling) | 5-15% | > 15% or 0% |
| 9 | Average time-to-breach | 3-7 days | < 1 day (too easy to breach) |
| 10 | Average time-to-pass | 10-20 days | < 5 days (rules too easy) |
| 11 | Payout request volume | 0-2 | > 5 (unexpected) |
| 12 | Device fingerprint clusters | 0-1 flagged | > 3 flagged clusters |

### Week 2 Targets

- [ ] 20-30 total evaluations
- [ ] First pass event observed (or confirmed zero passes is normal for volume)
- [ ] Breach distribution matches expectations (mostly daily loss + trailing DD)
- [ ] No abuse flags triggered
- [ ] First payout request (if any accounts pass) handled manually
- [ ] Pass rate signal: is it within 5-15% band?

### Week 2 Decision Gates

**If pass rate > 15% (7-day, n ≥ 20 accounts):**
1. Pause new intake
2. Review: Are rules misconfigured? Is market unusually easy?
3. Compare actual breach reasons vs expected distribution
4. Consider tightening via `safety_setting_changes` (2-key approval)
5. Resume only when cause identified

**If pass rate = 0% (n ≥ 20 accounts, > 10 days):**
1. Verify trade ingestion is working correctly
2. Check if breach rules are too aggressive
3. May indicate rules need loosening (but be cautious)
4. This could be normal for small samples

**If any dispute filed:**
1. Investigate source immediately
2. Check if rules acknowledgement was captured
3. Prepare evidence pack (`evidence-pack` edge function)
4. Consider proactive refund if customer is clearly confused
5. Document in incident log

### Week 2 Data Collection

```
Week 2 Summary:
- Total evaluations sold: ___
- Total accounts active: ___
- Accounts breached: ___ (___%)
- Accounts passed: ___ (___%)
- Pass rate (7-day): ___%
- Breaches by type:
  - Daily loss: ___
  - Trailing DD: ___
  - Position size: ___
  - Other: ___
- Avg time to breach: ___ days
- Disputes: ___
- Revenue: $___
- Payout obligations: $___
- Net position: $___
```

---

## Week 3: Scaling Decision (Days 15-21)

### Goal: Decide whether to scale, hold, or tighten

### Scaling Decision Framework

```
                     Pass Rate Assessment
                     ┌─────────────────┐
                     │  < 5% pass rate  │ → Hold. Too aggressive?
                     │  5-12% pass rate │ → ✅ SCALE to 100-150/month
                     │  12-15% pass rate│ → Hold. Monitor 1 more week
                     │  > 15% pass rate │ → ⛔ PAUSE. Tighten rules
                     └─────────────────┘

                     Dispute Rate Assessment
                     ┌─────────────────┐
                     │  0.00%           │ → ✅ Healthy
                     │  0.01-0.19%      │ → ⚠️ Monitor closely
                     │  0.20%+          │ → ⛔ Do NOT scale
                     └─────────────────┘

                     Revenue Assessment
                     ┌─────────────────┐
                     │  Revenue > payouts│ → ✅ Sustainable
                     │  Revenue ≈ payouts│ → ⚠️ Tight margin
                     │  Revenue < payouts│ → ⛔ Unsustainable
                     └─────────────────┘
```

**Scale ONLY if ALL three are green.**

### If Scaling: Week 3-4 Actions

- [ ] Increase intake cap to 100-150 evaluations/month
- [ ] Enable auto-fulfillment confidence (reduce manual oversight)
- [ ] Begin tracking cohort survival curves
- [ ] Set up weekly pass rate review cadence
- [ ] Consider enabling Pro tier ($199) if Starter is validated

### If Holding: Week 3-4 Actions

- [ ] Maintain current intake cap
- [ ] Continue daily monitoring
- [ ] Collect more data before deciding
- [ ] Prepare rule adjustment proposals (don't execute yet)

### If Pausing: Week 3-4 Actions

- [ ] Pause new intake immediately
- [ ] Honor all existing evaluations
- [ ] Process all legitimate payouts
- [ ] Analyze root cause
- [ ] Prepare rule adjustments via `safety_setting_changes`
- [ ] Resume only after adjustments validated

---

## Week 4: Operational Maturity (Days 22-30)

### Goal: Establish sustainable operating rhythm

### Transition to Steady-State

| From (Launch Mode) | To (Steady State) |
|--------------------|-------------------|
| Daily checklist (7 items) | Morning check (5 min) + weekly deep review |
| Manual payout review (all) | Manual review (first payout only) |
| Daily pass rate monitoring | Weekly pass rate review |
| Zero automation trust | Conditional automation trust |

### Week 4 Targets

- [ ] 30-day pass rate calculated with real data
- [ ] First month revenue vs payout ratio documented
- [ ] Dispute rate trend established (hopefully 0%)
- [ ] Operational rhythm comfortable (< 30 min/day)
- [ ] All runbooks in Ops Playbook validated against real events
- [ ] Decision: scale, hold, or pivot

### 30-Day Report Template

```
═══════════════════════════════════════════
  30-DAY LAUNCH REPORT
═══════════════════════════════════════════

Revenue:
  Total evaluations sold: ___
  Total revenue: $___
  Average revenue/day: $___

Pass Rate:
  Total accounts evaluated: ___
  Accounts passed: ___
  Pass rate: ___%
  Model prediction was: 10-12%
  Variance: ___% (over/under)

Payouts:
  Payout requests: ___
  Payouts approved: ___
  Payouts paid: $___
  Average payout: $___
  Payout/revenue ratio: ___%

Risk:
  Dispute count: ___
  Dispute rate: ___%
  Breaker events: ___
  Abuse flags: ___
  Fraud reviews: ___

Operations:
  Average daily time spent: ___ min
  Support tickets: ___
  Incidents: ___
  System downtime: ___ hours

Financial Health:
  Starting reserve: $___
  Current reserve: $___
  Net buffer: $___
  Runway at current burn: ___ months

VERDICT: [SCALE / HOLD / TIGHTEN / PIVOT]
Rationale: ___

═══════════════════════════════════════════
```

---

## Hard Rules (Non-Negotiable)

### Never Do

1. **Never scale because revenue feels good** — scale because data says so
2. **Never override the economic breaker** — it exists to protect you
3. **Never reject a legitimate payout** to improve cash position
4. **Never retroactively change rules** for existing accounts
5. **Never ignore a dispute** — respond within 24 hours
6. **Never skip the morning checklist** — 5 minutes prevents disasters

### Always Do

1. **Always document incidents** using the template in Ops Playbook
2. **Always process payouts** if trader meets all rules
3. **Always respond to Stripe** communications within 24 hours
4. **Always have cash reserves** > 3 months of maximum payout exposure
5. **Always review pass rate** before approving intake increases
6. **Always test in sandbox** before deploying to production

---

## Emergency Contacts & Escalation

| Situation | Action | Timeframe |
|-----------|--------|-----------|
| First dispute | Investigate + prepare evidence | Within 4 hours |
| Dispute rate > 0.20% | Follow dispute runbook | Within 2 hours |
| Stripe communication | Respond with business explanation | Within 24 hours |
| Breaker fires | Review, do not override | Within 2 hours |
| Pass rate > 15% | Assess and decide | Within 24 hours |
| Trade ingestion stops | Contact broker, check logs | Within 4 hours |
| Payout stuck > 48h | Manual reconciliation | Within 4 hours |

---

## Integration Points

| This Playbook | Links To |
|--------------|----------|
| Daily checklist | `/admin/system` System Overview |
| Pass rate monitoring | `/admin/monte-carlo` + `/admin/system` |
| Dispute monitoring | `/admin` Dispute Rate Card |
| Payout oversight | `/risk/queue` Review Queue |
| Incident response | `docs/OPS_PLAYBOOK.md` runbooks |
| Stripe survival | `docs/STRIPE_SURVIVAL_STRATEGY.md` |
| Readiness gate | `/admin/readiness` Safe to Sell |

---

*Review this document weekly during the first 30 days. After Month 1, transition to the steady-state operating rhythm described in Week 4.*
