

# Show Customer Volume and Growth in Simulation Results

## Problem
The simulation runs on `accountsPerMonth` from the slider but never shows:
- How many total customers are being simulated
- Monthly cumulative customer growth (new signups, eligible, capped out, churned)
- The funnel breakdown that drives the financial results

This makes the financial numbers feel disconnected from the actual customer base.

## Solution

### 1. Edge Function: Return monthly cohort counters

Modify `simulateMonthAggregate()` to also return pool sizes, and collect them as monthly bands (P50) across iterations.

New fields added to the return object:

```text
cohortBands: [
  { month: 1, totalAccounts: 150, eligible: 18, firstPayout: 18, capHits: 0, churned: 12 },
  { month: 2, totalAccounts: 300, eligible: 36, firstPayout: 15, capHits: 0, churned: 25 },
  ...
]
```

**Changes to `supabase/functions/run-simulation/index.ts`:**
- Have `simulateMonthAggregate()` return additional fields: `totalAccounts`, `eligiblePool`, `firstPayoutPool`, `capHits`
- In `runSimulation()`, collect these per-month per-iteration into columns (like `monthColumns` for profit)
- Compute P50 (median) of each counter per month
- Add `cohortBands` array to the results object alongside `monthlyBands`

### 2. UI: Add "Customer Growth" tab and summary cards

**Changes to `src/pages/admin/MonteCarloAnalytics.tsx`:**

Add two new elements:

**a) Summary banner** — Show total customers simulated prominently in the verdict section:
- "Simulating **1,800 total customers** over 12 months (150/mo)"
- "Peak eligible pool: **216 funded accounts**"

**b) New "Customers" tab** alongside Bands / Distribution / Risk / Diagnostics:
- Stacked area chart showing monthly cumulative counts:
  - Total signups (cumulative)
  - Eligible (funded, active)
  - First-payout pending
  - Cap-hit / churned
- This directly answers "how many customers is this modeling?"

### 3. Diagnostics enhancement

Add to the existing diagnostics panel:
- Total accounts simulated: `accountsPerMonth x horizon`
- Peak eligible pool (median)
- Churn rate (cap-hit + reset-out as % of total)
- Customer lifetime (avg months before cap or churn)

## Technical Details

### Edge function changes (`supabase/functions/run-simulation/index.ts`)

The `simulateMonthAggregate` function (line 160) already computes `totalEligible` on line 279. We need to:

1. Return it from the function along with other pool counters
2. Collect per-month arrays similar to `monthColumns` for profit
3. Compute medians and add to results

New return type from `simulateMonthAggregate`:
```text
{
  netProfit, totalPayouts, payoutRequests, capHits,
  totalAccounts,     // sum of all cohort.totalAccounts
  eligiblePool,      // sum of all cohort.eligiblePool
  firstPayoutPool,   // sum of all cohort.firstPayoutPool
}
```

New field in simulation results:
```text
cohortBands: Array<{
  totalAccounts: number   // cumulative signups
  eligible: number        // funded & active (median across iterations)
  firstPayout: number     // awaiting first payout
  capHits: number         // cumulative cap-hit accounts
}>
```

### Frontend changes

| File | Change |
|------|--------|
| `supabase/functions/run-simulation/index.ts` | Return cohort pool counters per month |
| `src/pages/admin/MonteCarloAnalytics.tsx` | Add customer summary to verdict, new "Customers" tab with stacked area chart, enhance diagnostics |

### UI Layout for Customers tab

```text
+--------------------------------------------------+
| Customer Growth (Median Across Iterations)        |
|                                                   |
|  [Stacked Area Chart]                             |
|  - Blue area: Cumulative signups                  |
|  - Green area: Eligible (funded)                  |
|  - Orange area: First-payout pending              |
|  - Red line: Cumulative cap-hits                  |
|                                                   |
|  M1    M3    M6    M9    M12                      |
+--------------------------------------------------+
| Key Stats:                                        |
| Total Customers: 1,800 | Peak Eligible: 216       |
| Avg Lifetime: 4.2 mo   | Cap-Hit Rate: 8.3%       |
+--------------------------------------------------+
```

### Verdict banner addition

The existing verdict banner (line 236) will be enhanced to show:
```text
"2,000 iterations x 12 months using live cohort rules"
→
"2,000 iterations x 12 months | 1,800 customers (150/mo) | live cohort rules"
```

