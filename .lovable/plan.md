

# Monte Carlo Sim: Payout Velocity Gates

## Goal
Add 3 new simulation knobs to the Monte Carlo engine that model payout velocity controls used by top firms (Tradeify, Alpha Futures, Topstep). Re-run projections to measure which gate combo moves Month 10-12 from negative/breakeven to positive -- before hardcoding anything into production RPCs.

## Target metric
Month 10-12 mean profit of +$2,500/month (up from ~$0 / slightly negative today).

---

## New Knobs (added to `SimulationKnobs`)

| Knob | Type | Default | Description |
|------|------|---------|-------------|
| `minWinningDaysPerPayout` | `number` | `0` (disabled) | Minimum winning trading days required since last payout before next payout is allowed. Resets after each payout. Mirrors Tradeify/Topstep "5 winning days" rule. |
| `requireProfitSinceLastPayout` | `boolean` | `false` | If true, account must be net profitable since last payout to request another. Prevents "drip withdraw then die" loops. |
| `payoutCadenceDays` | `number` | `0` (disabled) | Minimum calendar days between payouts (e.g., 14 = biweekly windows). Complements winning-days gate with a time floor. |

---

## How These Gates Work in the Simulation

The payout request loop (lines 528-614 of `monte-carlo.ts`) currently checks:
1. Is account active + eligible? 
2. Random payout request probability
3. Lifetime cap headroom
4. Generate amount, apply split, apply caps

**New logic inserted between steps 2 and 3:**

For each eligible account requesting a payout:

```text
if minWinningDaysPerPayout > 0:
  simulate winning days accumulation since last payout
  (use a simple probability model: each trading day has ~55% chance of being a "winning day")
  if accumulated winning days < minWinningDaysPerPayout:
    skip this payout request (account must keep trading)

if requireProfitSinceLastPayout AND account.payoutCount > 0:
  simulate whether account is profitable since last payout
  (use a ~60% probability -- most active traders are profitable in any given period)
  if not profitable: skip

if payoutCadenceDays > 0 AND account.payoutCount > 0:
  calculate months since last payout using daysSinceLastPayout counter
  if daysSinceLastPayout < payoutCadenceDays: skip
```

The winning days gate is the most impactful because it directly reduces `payoutsPerPaidAccountPerMonth` for repeat withdrawers without blocking first payouts.

---

## AccountState Changes

Add to `AccountState` interface:
- `daysSinceLastPayout: number` -- incremented each month by 30, reset to 0 on payout
- `winningDaysSinceLastPayout: number` -- accumulated each month, reset to 0 on payout

---

## New Scenario Presets

| Preset | Knobs | Purpose |
|--------|-------|---------|
| `withVelocityGate5d` | `minWinningDaysPerPayout: 5` + 7x cap | Topstep-style: 5 winning days per payout |
| `withVelocityGate5d_profit` | above + `requireProfitSinceLastPayout: true` | Combined gate |
| `withVelocityGate5d_biweekly` | above + `payoutCadenceDays: 14` | Full velocity control |
| `withVelocityGate10d` | `minWinningDaysPerPayout: 10` + 7x cap | Stricter gate for comparison |

---

## New Test: Velocity Gate Impact Analysis

A new test file `src/lib/velocity-gate-analysis.test.ts` that:

1. Runs baseline (current model with 7x cap, no velocity gates)
2. Runs each velocity gate preset
3. Compares Month 10-12 mean, P99 drawdown, loss probability, payout/revenue ratio
4. Outputs a formatted comparison table
5. Asserts that velocity gates improve Month 10-12 economics

---

## Mechanical Invariant Tests (added to `monte-carlo.test.ts`)

- Velocity gates reduce avg payouts per account per month (monotonicity)
- Stricter gates (10d) reduce payouts more than looser gates (5d)
- Velocity gates don't affect Month 1-2 economics significantly (they target mature cohort)
- All existing tests continue to pass (gates default to disabled)

---

## Files Changed

| File | Change |
|------|--------|
| `src/lib/monte-carlo.ts` | Add 3 knobs to `SimulationKnobs`, add fields to `AccountState`, add gate logic in `simulateMonth` payout loop, add new scenario presets |
| `src/lib/velocity-gate-analysis.test.ts` | New test file: runs gate sweep, outputs comparison report |
| `src/lib/monte-carlo.test.ts` | Add mechanical invariant tests for velocity gates |

---

## What This Does NOT Change

- No database schema changes
- No RPC changes
- No UI changes
- No edge function changes
- All existing tests pass unchanged (gates default to 0/false)

## Decision Framework (Output)

After running the tests, the comparison table will show for each gate configuration:

```text
Gate Config         | M10-12 Mean | P99 DD  | Loss% | Payout/Rev
-----------------------------------------------------------------
Baseline (no gate)  | -$200       | $11.5k  | 48%   | 0.82
5 winning days      | +$???       | $???    | ???%  | ???
5d + profit-since   | +$???       | $???    | ???%  | ???
5d + profit + 14d   | +$???       | $???    | ???%  | ???
10 winning days     | +$???       | $???    | ???%  | ???
```

The results tell you exactly which policy to implement in production RPCs.

