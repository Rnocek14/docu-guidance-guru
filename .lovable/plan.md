
# Full Risk Visibility: Configurable Simulation Dashboard

## Goal
Expose all economically meaningful parameters in the Monte Carlo UI so you can model realistic scenarios — from lean bootstrap to scaled operations — and see full tail risk.

## Changes

### 1. New UI Controls (MonteCarloAnalytics.tsx)

Add sliders and presets to the Simulation Parameters card:

- **Accounts per Month** slider (25 - 1,000, default 150)
- **Fixed Monthly Costs** slider ($2,000 - $30,000, default $6,000)
- **Entry Fee** slider ($99 - $299, default $149)
- **Reset Fee** slider ($49 - $149, default $99)
- **Simulation Horizon** slider (6 - 36 months, default 12)
- **Attack Intensity** slider (0 - 1.0, default 0) — models coordinated fraud
- **Scenario Presets** buttons:
  - "Bootstrap" — 50 accts/mo, $5k costs
  - "Growth" — 200 accts/mo, $12k costs
  - "Scale" — 500 accts/mo, $18k costs

### 2. Pass Overrides to Edge Function

The `run-simulation` edge function already accepts an `overrides` parameter. The UI will send:

```text
POST /run-simulation
{
  iterations: 2000,
  months: 24,            // from horizon slider
  reserve_threshold: 16000,
  overrides: {
    accountsPerMonth: 150,
    fixedMonthlyCosts: 6000,
    pricePerAccount: 149,
    knobs: {
      resetPrice: 99,
      attackIntensity: 0.3
    }
  }
}
```

No edge function changes needed — the override merge logic already exists on line 135.

### 3. New Risk Summary Section

Add a "Risk Report" tab alongside the existing Bands/Histogram/Diagnostics tabs showing:

- **Breakeven Analysis**: minimum accounts/month needed at current cost structure
- **Months to Insolvency**: at P5 (worst case), how many consecutive months before reserve is depleted
- **Steady-State Month**: which month the P50 band crosses zero (margin compression point)
- **Cumulative P&L waterfall**: Revenue vs Payouts vs Fraud vs Costs breakdown

### 4. Comparison Mode

After a run completes, a "Compare" button saves the current result. Running again overlays the new result against the saved one — so you can visually compare "Bootstrap vs Growth" scenarios side by side.

## Technical Details

### Files Modified

| File | Change |
|------|--------|
| `src/pages/admin/MonteCarloAnalytics.tsx` | Add override sliders, presets, risk report tab, comparison state |

### No Backend Changes Required
The edge function's `overrides` parameter already supports all of these fields. The UI simply needs to pass them through.

### Computed Risk Metrics (client-side from existing result data)

```text
breakeven = fixedMonthlyCosts / (pricePerAccount - variableCostPerAccount)
                                  adjusted for passRate and payout drain

monthsToInsolvency = reserveThreshold / abs(monthlyBands[last].p5)

steadyStateMonth = first month index where p50 < 0
```

### UI Layout

```text
+--------------------------------------------------+
| Simulation Parameters                             |
| [Bootstrap] [Growth] [Scale]                      |
|                                                   |
| Accounts/mo  [====|====] 150                      |
| Fixed Costs  [==|======] $6,000                   |
| Entry Fee    [=====|===] $149                     |
| Reset Fee    [===|=====] $99                      |
| Horizon      [====|====] 24 months                |
| Attack       [|========] 0.0                      |
|                                                   |
| [Run Simulation]              [Compare Previous]  |
+--------------------------------------------------+

+--------------------------------------------------+
| Verdict Banner: PROFITABLE / MARGINAL / etc.      |
+--------------------------------------------------+

| 12-Mo Profit | Monthly | Loss Prob | Reserve | Worst |
|   $XX,XXX    |  $X,XXX |   XX.X%   |  XX.X%  | -$XX  |

+--------------------------------------------------+
| [Bands] [Distribution] [Risk Report] [Diagnostics]|
|                                                   |
| Risk Report tab:                                  |
|  - Breakeven: 120 accts/mo                        |
|  - Months to insolvency (P5): 8                   |
|  - Margin compression month: 5                    |
|  - Cumulative waterfall chart                     |
+--------------------------------------------------+
```
