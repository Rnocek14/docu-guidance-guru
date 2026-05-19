
# Diagnosis: Why the Treasury Sim Says LTV = −$104

I found the answer, and it's not "assumptions are vague" — it's much more concrete than that. **The treasury simulator is missing four production constraints that already exist in this codebase.** The result is a model that systematically overstates payout liability by ~4–5× and produces a false negative-LTV signal.

## The Smoking Gun

This project has TWO simulators:

- `supabase/functions/run-treasury-projection/index.ts` — the one we've been running. Standalone. Hand-rolled defaults. **Missing key production constraints.**
- `src/lib/monte-carlo.ts` — a 1,655-line production simulator with `DEFAULT_ASSUMPTIONS` explicitly labeled **"CALIBRATED TO INDUSTRY REALITY (2026-03-02)"** referencing QuantVPS, Tradeify, and Topstep benchmarks.

These two simulators were never reconciled. The treasury sim uses a simplified behavior model that the production sim outgrew months ago.

## Side-by-Side: What the Treasury Sim Got Wrong

| Variable | Treasury sim (broken) | Production calibration (real) | Impact |
|---|---|---|---|
| `passRate` | 12% | 7% mode (4–12%) | ~OK |
| `avgPayoutWhenPaid` | $380 | $350 mean / $120 stdDev | ~OK |
| `payoutRequestRate` | **MISSING — assumes 100%** | **25% mode (15–40%)** | **4× overstated** |
| `lifetimeCapPerUser` | **MISSING** | **$1,490 hard cap** | unbounded → bounded |
| `minMonthsBetweenPayouts` | **MISSING** | **1 month** | cadence cap |
| `minWinningDaysPerPayout` | **MISSING** | **10 days** | retires most blowing-up traders |
| `payoutCooldownDays` | MISSING | 14 days | reinforces cadence cap |
| `fixedMonthlyCosts` | $12k | $18k (but solo beta is much less) | known |

## Why This Produced "LTV = −$104"

The treasury sim's per-trader payout obligation is:
```
0.14 lifetime pass × 4.4 expected payouts × $380 = $234 obligation / signup
```

But the production constraints say the real obligation is bounded:
```
0.08 lifetime pass × 0.25 payoutRequestRate × min($1,490 lifetime cap, ...) 
≈ 0.02 × $1,490 = ~$30 obligation / signup
```

That's an **~8× difference** in expected payout liability per signup. With net inflow ~$161/signup, the corrected number is roughly:
```
LTV ≈ $161 net inflow − $30 payout obligation − $24 variable cost ≈ +$107 / signup
```

**The math flips from −$104 to roughly +$107 just by importing production constraints.** No assumption change required.

## Why It Was Hidden Until Now

- The original treasury sim was written before Bug #1 (liability-adjusted trough) was fixed. Without liability accounting, it never showed runaway obligations and nobody noticed it wasn't modeling caps.
- Once Bug #1 was fixed, the unbounded payout obligation finally surfaced — but as a "scary insight," not as "your sim is missing 4 production constraints."
- The two simulators have different purposes (per-trader vs cohort-aging) and were never explicitly reconciled.

The user's instinct ("the assumptions are wrong") was directionally right but the actual issue is even more concrete: the constraints exist in code already, they just aren't wired into the treasury model.

---

# The Plan

## Phase 1 — Reconcile the Treasury Sim with Production Calibration

Edit `supabase/functions/run-treasury-projection/index.ts`:

1. **Import the SSOT.** Reference (mirror) `DEFAULT_ASSUMPTIONS` and `SimulationKnobs` from `src/lib/monte-carlo.ts` directly inside the edge function (edge functions can't import from `src/`, so mirror with a "SOURCE OF TRUTH" comment block and a CI assertion test that fails if values drift).

2. **Add `payoutRequestRate`** to behavior model. Apply it to the funded population before computing payout requests:
   ```ts
   const requestingFunded = funded * beh.payoutRequestRate.mode
   const payoutRequestsThisMonth = requestingFunded * beh.payoutsPerPaidAccountPerMonth.mode
   ```

3. **Add `lifetimeCapPerUser` accounting.** Track cumulative paid amount per cohort (or as an aggregate stock). When a cohort's average cumulative paid amount approaches `lifetimeCap`, decay its `payoutProbPerMonth` toward zero. This is the single most important fix.

4. **Add `minMonthsBetweenPayouts`** as a hard cap on `payoutsPerPaidAccountPerMonth`. Currently 1, so this caps cadence at 1/month per requesting trader.

5. **Update fixed opex default to a "lean beta" tier.** Add a `costMode` input: `lean` ($3k/mo), `staffed` ($12k/mo), `scaled` ($18k/mo). Default to `lean` for beta scenarios.

6. **Add a `methodology` field** to results: `liability_adjusted_v2_lifetime_capped`. Bump the schema marker so the dashboard knows the new runs are post-calibration.

## Phase 2 — Re-Derive LTV and Republish Decomposition v2

Rerun the same 5 decompositions (`/mnt/documents/treasury_decomposition_v2.md`) using the corrected model:

- Unit economics (expect LTV to flip from −$104 to roughly +$100, give or take)
- Cohort waterfall (no change — already correct)
- Revenue attribution (no change — already correct)
- Small-beta survival scenarios (expect tiny beta to flip from "trough −$264k, 0% survival" to "survivable")
- Sensitivity ranking (expect `lifetimeCapPerUser` and `payoutRequestRate` to top the list)

Output: a clean v2 markdown report side-by-side with v1, with a "what changed" section showing the corrected numbers vs the broken ones.

## Phase 3 — Build the Viability Region Map (the user's actual ask)

A standalone analytical script (no UI, no edge function) that produces a 3-axis grid:

- **Axis 1: `fixedMonthlyOpex`** — [$2k, $4k, $6k, $8k, $12k, $18k]
- **Axis 2: `avgPayoutWhenPaid`** — [$200, $300, $380, $500]
- **Axis 3: `payoutRequestRate` × `payoutsPerPaidAccountPerMonth`** — combined as "effective payout extraction velocity" with 5 levels (low → high)

For each cell (6 × 4 × 5 = 120 combinations), run 30 Monte Carlo trials with corrected model and record:

- 24-month liability-adjusted trough (P50, P5)
- Insolvency probability
- L2 freeze months
- **Classification:** `viable` (P50 trough > 0, L2 < 3 mo) / `marginal` (P50 > −$20k) / `insolvent` (P50 < −$20k)

Output: `/mnt/documents/treasury_viability_map_v1.md` with:
- A heatmap-style table per opex tier showing the viability region across payout-size × velocity
- A textual summary: "Meridian is viable when [opex ≤ $X] AND [avgPayout ≤ $Y OR velocity ≤ Z]"
- The minimum opex headroom required at each (avgPayout, velocity) point

## Phase 4 — Cross-Validate Against the Existing Competitor Profiles

The codebase already has `src/lib/competitor-profiles.ts` with Apex- and FTMO-derived calibrations. Run the corrected treasury sim against:
- Apex Conservative profile (high pass throttle, $2k cap × 5, fast cadence)
- FTMO refund-model variant
- Meridian Starter (current production knobs)

If the corrected Meridian model lands in a plausibly-survivable zone vs the competitor benchmarks, the calibration is validated. If not, the next investigation step is `payoutRequestRate` — that's the only assumption I'm still genuinely unsure about, and it's the one that should be checked against any seed-data the project has.

## What I'm NOT Doing (And Why)

- **Not adding UI for the viability map.** Markdown report is faster, denser, and what the user has been consuming. UI later if useful.
- **Not researching external prop firm payout data via web search.** The project already calibrated against QuantVPS/Tradeify/Topstep three months ago — those numbers are baked into `monte-carlo.ts`. Re-researching would be redundant.
- **Not building a separate "beta mode" simulator.** The corrected treasury sim with `costMode: 'lean'` IS the beta simulator.
- **Not touching production payout logic.** This is all simulator-side. Production payout/breaker/cap code is correct; the sim was simply unaware of it.

## Deliverables

1. Patched `supabase/functions/run-treasury-projection/index.ts` with imported production constraints
2. `treasury_decomposition_v2.md` — corrected LTV and decomposition
3. `treasury_viability_map_v1.md` — the 3-axis region map
4. A short verdict at the end: **"At opex ≤ $X and trader behavior in region Y, Meridian is viable. Here's the minimum required reserve and the safe scaling velocity."**

## Risk / Confidence

- High confidence the LTV flips positive once `lifetimeCapPerUser` and `payoutRequestRate` are wired in. The math is mechanical, not modeled.
- Medium confidence on the exact `payoutRequestRate` value (production says 25% mode; if it's actually 50% in real Meridian data we don't have yet, the picture is less rosy).
- Low risk of regressions — all changes are inside the projection edge function. No production payout code is touched.

## Suggested Order

Phase 1 → Phase 2 → Phase 3 → Phase 4. Phase 1+2 is roughly one edit cycle. Phase 3 is a single bun script. Phase 4 is half an hour. Total: one focused session.
