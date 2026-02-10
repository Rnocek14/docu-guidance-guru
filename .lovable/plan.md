
# Trader Dashboard: Mock Data + Enhanced UI

## Overview
Seed realistic mock data for rnocek14@gmail.com and enhance the trader dashboard to be genuinely impressive — equity curve chart, better stats, and a polished experience that doubles as a real product screenshot for the hero image.

## What the user currently sees
- Empty dashboard with a "Start Your Evaluation" card (no accounts, trades, or payouts exist)
- User exists with `trader` + `admin` roles, profile name "Riley Nocek"

## Step 1: Seed Mock Data via SQL Migration

Insert realistic trading data for user `65c43a0a-7182-448f-9753-ed9818030602`:

**Account** (evaluation phase, actively trading, doing well):
- Cohort: "Standard Challenge" (`30c85b00-c613-4d33-83e5-c5af8a8ea6d5`)
- Starting balance: $100,000
- Current balance: $107,450
- Highest balance: $108,200
- Total P&L: +$7,450 (7.45% — close to the 10% target)
- 12 trading days (past the 5-day minimum)
- Daily P&L: +$320
- Status: `active`
- Rule snapshot frozen from cohort

**Trades** (~25 realistic closed trades over 12 days):
- Mix of ES, NQ, CL futures
- Varied position sizes (1-4 contracts)
- ~65% win rate, realistic P&L distribution
- Spread across the last 3 weeks
- 1 open position (ES, entered today)

This gives the dashboard rich data to display without needing to touch any edge functions or RPCs.

## Step 2: Add Equity Curve Chart to Trader Dashboard

Create a new `EquityCurveChart` component using Recharts (already installed). It will:
- Query closed trades for the active account, sorted by `closed_at`
- Compute a running cumulative P&L series (starting from `starting_balance`)
- Render an `AreaChart` with gradient fill (green when above start, following existing chart patterns from admin pages)
- Show the starting balance as a reference line
- Display in the main dashboard between the stats grid and the progress section

## Step 3: Enhance the Dashboard Layout

Current layout: phase indicator, payout readiness (PA only), 4 stat cards, 2 progress cards, account status card.

Enhanced layout:
1. Welcome + phase indicator (unchanged)
2. **4 stat cards** (unchanged — balance, P&L, drawdown, trading days)
3. **NEW: Equity curve chart** (full-width, prominent)
4. **2 progress cards** (profit target + drawdown monitor — unchanged)
5. Account status card (unchanged)

## Step 4: Replace Fake Hero Image

Remove the AI-generated `hero-dashboard.jpg` and instead:
- Remove the `<img>` from Hero.tsx
- Remove the import and the image file itself
- The landing page returns to the clean text-only hero (which looked great before)

Alternatively: once the dashboard is live with real data, take an actual screenshot and use that. For now, remove the fake.

## Files Changed

| File | Change |
|------|--------|
| SQL migration | Seed account + 25 trades for rnocek14 |
| `src/components/trader/EquityCurveChart.tsx` | **New** — Recharts area chart component |
| `src/pages/trader/TraderDashboard.tsx` | Add equity curve below stat cards |
| `src/components/landing/Hero.tsx` | Remove fake hero image |
| `src/assets/hero-dashboard.jpg` | **Delete** |

## Technical Notes

- The equity curve uses the same `ChartContainer` / `ChartConfig` pattern already established in admin charts
- Trade data is computed client-side from the existing `trades` table query (no new RPC needed)
- The cumulative P&L is calculated by sorting trades by `closed_at` and running a prefix sum
- No schema changes required — only INSERT statements for mock data
