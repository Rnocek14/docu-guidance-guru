
# Recommended Cohort — Market Position add-on

Adds a "Recommended Cohort" section to the existing Market Position view that turns the comparison matrix into actionable tier configs.

## What the user sees

A new card above the existing comparison matrix, with a tier selector (Starter / Pro / Elite) and a 3-column table:

```text
                     Your current   Match the median   Competitive & solvent
Entry fee            $149           $90                $129
Profit target        $3,000 (10%)   $3,000             $3,000
Daily loss           $1,500 (3%)    $2,500             $2,000   ← clamped
Max drawdown         $2,500 (5%)    $2,500             $2,500
Payout split         80%            90%                85%      ← clamped
First payout cap     $500           $2,000             $1,000   ← clamped
Cooldown             14d            8d                 10d      ← clamped
Reset fee            $99            $70                $80
─────────────────────────────────────────────────────────────────
                                    [ Preview as draft cohort ]
```

- **Your current** column: pulled from `TIER_ECONOMICS` for the selected tier.
- **Match the median** column: pure median of competitor snapshots for that account size, no constraints.
- **Competitive & solvent** column: starts from the median, then each field is clamped by a per-field "floor/ceiling" derived from existing solvency tooling (see Technical). Any clamped value gets a `← clamped` marker with a tooltip explaining which constraint bound it.
- Each cell has a hover tooltip citing the source (e.g. "Median of Apex/Topstep/MFFU/Tradeify Starter 50K" or "Reserve model floor — splits >85% push 12-month ruin >5%").

Below the table: a "Preview as draft cohort" button. Clicking it opens a confirmation modal showing the exact `cohorts` row that will be inserted, with `is_active=false` and `intake_active=false` so it is dormant until an admin flips it in the existing CohortsManagement page. Nothing in `tier-economics.ts` changes — that remains the SSOT until a separate, deliberate PR.

## How recommendations are computed

**Median column** — per metric, per tier, across the `comparable` snapshots (the existing `filterComparableSnapshots` already filters to verified futures firms). Account size buckets: Starter ≈ 50K, Pro ≈ 100K, Elite ≈ 150K–200K. Missing data → median is computed on what's present, marked with sample size in tooltip.

**Solvent column** — same median, then each value is clamped to a per-field policy band:

| Field | Floor | Ceiling | Source |
|-------|-------|---------|--------|
| Entry fee | `currentFee × 0.7` | `currentFee × 1.2` | guardrail against pricing whiplash |
| Profit target % | 8 | 12 | matches existing cohort spec spread |
| Daily loss % | 3 | 5 | `cohorts.max_daily_loss_percent` band |
| Max drawdown % | 4 | 10 | cohort band |
| Split % | from solvency table (see below) | 95 | reserve / Monte Carlo |
| First payout cap | from solvency table | `entryFee × 15` | reserve / lifetime ratio |
| Cooldown days | 7 | 21 | ops capacity band |
| Reset fee | 50 | 99 | margin band |

The split / first-payout-cap floors come from a small lookup derived from the existing breaker + Monte Carlo constants — not a live Monte Carlo call. Concretely a constant table in the new `competitor-recommendation.ts`:

```ts
const SOLVENCY_FLOORS = {
  starter:  { splitPct: 80, firstPayoutCap: 500 },
  pro:      { splitPct: 80, firstPayoutCap: 750 },
  elite:    { splitPct: 80, firstPayoutCap: 1000 },
}
```

Sourced from the same numbers already in `TIER_ECONOMICS` so they cannot drift. Tooltip on any clamped cell says: "Cannot drop below current solvency floor — see `tier-economics.ts`."

This keeps the recommendation auditable and avoids piping the Monte Carlo engine into a UI render path.

## "Preview as draft cohort" flow

1. Button opens a modal with the proposed `cohorts` row, JSON-formatted.
2. Confirm → calls a new edge function `recommend-cohort-draft` (admin-only, JWT-validated) that:
   - Validates the requesting user has `admin` role.
   - Validates every numeric field is within the solvency bands (defense in depth — UI cannot bypass).
   - Inserts one row into `cohorts` with `is_active=false`, `intake_active=false`, `cohort_phase='performance'`, `name='Recommended <Tier> — <YYYY-MM-DD>'`, `version=max(version)+1`, `tier_id=<selected>`.
   - Writes an `audit_logs` entry with `action='cohort_draft_created'` and the recommendation source (median values, clamped values, snapshot IDs used).
3. Modal closes, toast links to `/admin/cohorts` where the draft appears and can be reviewed / activated by the existing flow.

No existing cohort is mutated. No `tier-economics.ts` change. The user remains the final approver.

## Files touched

- `src/lib/competitor-recommendation.ts` — **new**, pure logic: `recommendCohort(tierId, matrix, snapshots) → { current, median, solvent, clampedFields[] }`.
- `src/lib/competitor-recommendation.test.ts` — **new**, unit tests for median math, clamping, and missing-data fallback.
- `src/components/admin/competitor-intel/RecommendedCohortCard.tsx` — **new**, the UI card with tier selector and 3-column table.
- `src/components/admin/competitor-intel/MarketPositionView.tsx` — mount `<RecommendedCohortCard>` above the existing matrix.
- `supabase/functions/recommend-cohort-draft/index.ts` — **new**, admin-only edge function that inserts the draft cohort.
- Migration — none required; uses existing `cohorts` and `audit_logs` schemas.

## Out of scope

- No edit to `tier-economics.ts` — recommendation is observational/draft only.
- No automatic application of a recommended cohort to live accounts.
- No change to the public `ComparisonTable.tsx`.
- No Monte Carlo or breaker engine calls at render time — floors are static constants sourced from existing SSOT.
