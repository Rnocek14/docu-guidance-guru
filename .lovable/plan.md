
# Launch Configuration — Locked v1.5

## Payout Pacing Knobs (v1.5 — validated 2026-03-03)

| Knob | Value | Rationale |
|------|-------|-----------|
| `targetPayRevSoft` | **0.45** | Lowest budget that clears deferral < 15% while keeping margin > 20% |
| `payRevEngageThreshold` | **0.38** | Ratio-based engagement; only clamps months trending hot |

### Validation Results (seed 42, 15-month horizon, 200 accts/mo)

| Scenario | Pay/Rev P95 | Deferral | Margin | Reserve Breach | Worst Month |
|----------|-------------|----------|--------|----------------|-------------|
| Baseline (attack=0) | 45.0% | 14.0% | 20.7% | 0% | $1,604 |
| Clustered (attack=0.5) | 45.0% | 37.4% (info) | 16.0% | 0% | $1,060 |

### Acceptance Criteria (all met ✅)
- Baseline: Pay/Rev P95 ≤ 45%, Deferral ≤ 15%, Margin ≥ 20%
- Clustered: Margin ≥ 15%, Reserve breach < 15%, Worst month > -$15k

### Architecture
- **Layer 1 (Soft Pacing)**: Monthly budget at 45% pay/rev, engages at 0.38 ratio, defers excess to next cycle
- **Layer 2 (Hard Breaker)**: Emergency freeze for adversarial events (unchanged)
- Engagement uses running pay/rev ratio (not absolute dollars) — prevents premature triggering

### What NOT to change at launch
- Do not raise baseline split to 85% (kills upgrade incentive)
- Do not remove first payout cap (structural defense against fraud)
- Do not lower engage threshold below 0.38 (causes always-on pacing → high deferrals)

---


# Multi-Account Trader Dashboard Redesign

## Problem

With 12 seeded accounts across all lifecycle states, the current dashboard only shows a single "active" account (the first one found). Traders have no way to switch between accounts, see a portfolio overview, or filter trades/payouts by account. This is worse than every competitor.

## Design: Account Switcher + Portfolio Overview

### Core UX Pattern: Persistent Account Selector

A compact account switcher appears at the top of the Dashboard, Trades, and Payouts pages. The Dashboard page also gets a new "Portfolio Overview" section above the single-account detail view.

```text
+-----------------------------------------------+
|  Dashboard                                     |
+-----------------------------------------------+
|  Portfolio Overview (all accounts)             |
|  [3 Active] [2 Passed] [4 Failed] [1 Payout]  |
|  Total Balance: $423,500  |  Total P&L: +$18k |
+-----------------------------------------------+
|  [ Account Switcher Tabs / Dropdown ]          |
|  DEMO-EVAL-01 (Active) | DEMO-PERF-01 (PA)   |
+-----------------------------------------------+
|  (existing single-account detail view below)   |
|  Phase indicator, stats, equity curve, etc.    |
+-----------------------------------------------+
```

### 1. Portfolio Overview Strip (Dashboard only)

A summary card at the top showing aggregate stats across ALL accounts:
- Account counts by status (active / passed / failed / payout)
- Total combined balance across active accounts
- Total lifetime P&L
- Total payouts received

This gives traders an instant "how am I doing overall" answer -- something no competitor shows.

### 2. Account Switcher Component

A new `AccountSwitcher` component used on the Dashboard page. It renders as:
- **Desktop**: Horizontal scrollable tab-style pills showing account number + phase badge + P&L
- **Mobile**: A dropdown/select showing the same info

Clicking an account updates the dashboard to show that account's full detail view (equity curve, rule health, what's next, etc.).

The selected account ID is stored in URL search params (`?account=uuid`) so it's shareable and survives refresh.

### 3. Trades Page: Account Filter

Add an account filter dropdown at the top of the Trades page. Options:
- "All Accounts" (default -- current behavior)
- Each account listed by number + phase

### 4. Payouts Page: Account Filter

Same filter pattern as Trades. Already shows account numbers in the table, but filtering lets traders focus.

### 5. Sidebar Enhancement

Add a small account count badge next to "Accounts" in the sidebar nav showing total active accounts.

## Files to Create/Modify

| File | Change |
|------|--------|
| `src/components/trader/PortfolioOverview.tsx` | **New** -- aggregate stats strip |
| `src/components/trader/AccountSwitcher.tsx` | **New** -- tab/dropdown account selector |
| `src/pages/trader/TraderDashboard.tsx` | Add PortfolioOverview + AccountSwitcher; replace `activeAccount` logic with URL-param-driven selection |
| `src/pages/trader/TraderTrades.tsx` | Add account filter dropdown |
| `src/pages/trader/TraderPayouts.tsx` | Add account filter dropdown |
| `src/components/layout/DashboardLayout.tsx` | No change needed (nav items are static) |

## Technical Details

### Account Switcher State Management

```typescript
// In TraderDashboard.tsx
const [searchParams, setSearchParams] = useSearchParams();
const selectedAccountId = searchParams.get('account');

// Default to first "best" account (active > passed > payout > others)
const sortedAccounts = useMemo(() => {
  const priority = { active: 0, passed: 1, payout_requested: 2, ... };
  return [...(accounts ?? [])].sort((a, b) => 
    (priority[a.status] ?? 99) - (priority[b.status] ?? 99)
  );
}, [accounts]);

const selectedAccount = selectedAccountId 
  ? accounts?.find(a => a.id === selectedAccountId) 
  : sortedAccounts[0];
```

### Portfolio Overview Component

Shows 4 stat cards in a compact row:
- Active Accounts count (with phase breakdown tooltip)
- Combined Balance (sum of all active/passed account balances)
- Lifetime P&L (sum of total_pnl across all accounts)
- Total Payouts (query payouts table for paid totals)

### Account Switcher Component

Each pill/tab shows:
- Account number (e.g., `#DEMO-EVAL-01`)
- Phase badge (Eval / Veri / PA) with color coding
- P&L as a compact +$X.Xk or -$X.Xk
- Status indicator dot (green = active, yellow = review, red = failed, blue = passed)

### Trades/Payouts Filter

Simple `Select` component from shadcn with options populated from the accounts query. Filters the existing query by adding `.eq('account_id', selectedId)` when not "all".

### What This Looks Like vs Competitors

Most prop firm dashboards:
- Show one account at a time
- Require navigating to a separate "accounts list" page
- No portfolio-level view
- No cross-account filtering

Meridian after this change:
- Portfolio overview showing holistic trader health
- Instant account switching without page navigation
- Account-filtered trades and payouts
- URL-shareable account views
- Phase-aware visual design (eval = blue, veri = purple, PA = green, failed = red)

