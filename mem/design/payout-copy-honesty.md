---
name: Payout copy honesty
description: Never describe Payouts 2+ as "uncapped" — must reflect pacing/reserve/breaker reality
type: constraint
---
Trader-facing copy for payouts beyond the first cap must NOT use "uncapped per cycle" or similar.

Approved wording: "Every {N} days, paced" / "paced for platform stability".

**Why:** Payout Pacing v1.5 (0.45 soft budget cap), Reserve-aware Payout Gate (Monte Carlo min_reserve), and Breaker Policy v1 (>60% Pay/Rev freeze) all materially throttle subsequent payouts. Promising "uncapped" creates a trust break the moment any deferral fires — exactly the failure mode the trust-polish workstream was meant to prevent.

Surfaces governed by this rule:
- src/components/landing/PricingSection.tsx — Payout Rules toggle
- src/components/trader/RulesAtAGlanceCard.tsx — dashboard rules row
- src/components/trader/PayoutTrackerBar.tsx — post-first-cap secondary line
