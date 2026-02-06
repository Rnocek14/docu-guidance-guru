

# Wire Winning-Days Gate into Production UI

## What Already Exists
The `min_trading_days_between_payouts` gate is already enforced in the `calculate_payout_eligibility` RPC. When a trader hasn't accumulated enough trading days since their last payout, the RPC returns `reason_code: 'MIN_TRADING_DAYS'` with `trading_days_since_payout` and `required_trading_days`. However, there's no dedicated UI card showing this progress -- traders just see a generic "Not Eligible" alert.

## What We're Building
A self-explaining "Winning Trading Days" card (like the Profit Buffer card) that shows traders exactly how many more trading days they need before their next payout unlocks.

---

## Changes

### 1. RPC Enhancement: Add progress fields to MIN_TRADING_DAYS denial AND eligible response

Update the `calculate_payout_eligibility` function to return:
- `winning_days_progress_pct` -- server-computed progress (with divide-by-zero guard)
- `winning_days_remaining` -- days still needed
- Include `trading_days_since_payout` and `required_trading_days` in the ELIGIBLE response too (so the card can render even when eligible, showing "requirement met")

### 2. New Component: `PayoutWinningDaysCard`

A new component at `src/components/trader/PayoutWinningDaysCard.tsx` that:
- Shows a progress bar (days completed / days required)
- Displays "X of Y winning trading days completed"
- Uses the same visual pattern as `PayoutProfitBufferCard` (warning style when unmet, success when met)
- Only renders when the cohort has `min_trading_days_between_payouts > 0` AND the trader has a prior paid payout

### 3. TypeScript Types Update

Add to `PayoutEligibility`:
- `required_trading_days?: number`
- `winning_days_remaining?: number`
- `winning_days_progress_pct?: number`

### 4. PayoutRequest Page Updates

- Render `PayoutWinningDaysCard` alongside the Profit Buffer card when applicable
- Add `'MIN_TRADING_DAYS'` to the `isProfitGate`-style suppression so the generic denial card is hidden when the dedicated card handles it
- Rename the suppression variable to something broader like `isDedicatedGate`

---

## Technical Details

### RPC SQL changes (migration)

In the MIN_TRADING_DAYS denial block, add computed fields:

```text
winning_days_remaining = required - actual
winning_days_progress_pct = CASE WHEN required <= 0 THEN 100
  ELSE LEAST(100, GREATEST(0, (actual / required) * 100)) END
```

In the ELIGIBLE response, include `required_trading_days` and `winning_days_progress_pct: 100` so the UI can optionally show "requirement met."

### Component structure

The card will accept props:
- `tradingDaysSincePayout: number`
- `requiredTradingDays: number`
- `winningDaysRemaining: number`
- `progressPct: number`
- `isMet: boolean`

### Files changed

| File | Change |
|------|--------|
| New migration SQL | Update `calculate_payout_eligibility` with progress fields |
| `src/lib/types.ts` | Add `required_trading_days`, `winning_days_remaining`, `winning_days_progress_pct` to `PayoutEligibility` |
| `src/components/trader/PayoutWinningDaysCard.tsx` | New component: progress card for winning days gate |
| `src/pages/trader/PayoutRequest.tsx` | Render the new card, suppress generic denial for `MIN_TRADING_DAYS` |

### What this does NOT change
- No new database columns (gate already uses existing `min_trading_days_between_payouts` on cohorts)
- No edge function changes
- No changes to `validate_payout_request`
- All existing gates continue to work unchanged

