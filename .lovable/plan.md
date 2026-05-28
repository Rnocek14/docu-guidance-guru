## Problem

The cohort recommender takes a per-field median across competitor snapshots. Today that median is biased in two ways:

1. **Implausible zeros are treated as real values.** If a scraper extracts `daily_loss_usd: 0`, `reset_fee_usd: 0`, `payout_split_pct: 0`, etc., those 0s get fed into the median and pull it toward zero. Live example: `ftmo@100k` and `fundednext@100k` have `reset_fee_usd: 0` — almost certainly a scrape miss, not a real free reset.
2. **Selective absence is only flagged for daily-loss.** Other fields (`first_payout_cap_usd`, `reset_fee_usd`, `payout_split_pct`) are missing for many firms in the cohort, but the UI shows the median with no warning. A median of "the 3 firms that publish a first-payout cap" is presented as if it represented the whole cohort.

So yes — if your own daily loss is 5% and the cohort median lands at 0% because every other firm reported `null` or a junk `0`, the recommendation is wrong.

## Fix

### 1. Coerce implausible zeros to null in `competitor-recommendation.ts`

For fields where 0 is structurally not a real rule, treat `0` (and negatives) as missing before going into the median:

| Field | Treat 0 as null? |
|---|---|
| `daily_loss_usd` | yes |
| `max_drawdown_usd` | yes |
| `profit_target_usd` | yes |
| `payout_split_pct` | yes (0% split is not a real product) |
| `first_payout_cap_usd` | yes (use null = "no cap" instead) |
| `reset_fee_usd` | **no** — keep 0, some firms genuinely have free resets. But require the snapshot's `extraction_confidence >= 0.5` to count; otherwise drop. |
| `payout_cadence_days` | **no** — 0 means instant/on-demand, valid. |

Add a small helper `nonZeroOrNull(v)` and apply it inside the `.map(...)` callbacks feeding each `median(...)` call.

### 2. Track per-field coverage and surface it

Extend `RecommendationRow` with:

```ts
sampleCount: number;   // firms with a usable value for this field
totalFirms: number;    // firms in the bucket
exclusionNote?: string;
```

Compute `sampleCount` inline next to each median. When `sampleCount < totalFirms / 2`, attach an `exclusionNote` like:

```
Only 3 of 7 firms in this bucket publish a first-payout cap — median may not be representative.
```

Already done for daily-loss; generalize the pattern to all sparse fields.

### 3. Surface coverage in the UI

In `RecommendedCohortCard.tsx` (and `MarketPositionView.tsx` where relevant), render the coverage badge next to each row: `n/N firms`. When the exclusionNote is present, show the existing amber-warning style already used for daily-loss.

### 4. Tests

Extend `competitor-recommendation.test.ts`:
- Cohort where every competitor reports `daily_loss_usd: 0` → median should be `null`, not `0`, and a coverage warning fires.
- Cohort where 1 of 5 firms has `first_payout_cap_usd` set → median uses that 1 firm but row carries `exclusionNote`.
- `reset_fee_usd: 0` from a high-confidence snapshot is kept; from a low-confidence snapshot is dropped.

## Out of scope

- Re-running the scraper. This is purely a math/UX fix on top of whatever the scraper already stored.
- Switching away from median (mean / trimmed mean). Median is still the right central-tendency estimator once the junk-zero and sparsity issues are handled.

## Files touched

- `src/lib/competitor-recommendation.ts` — zero-coercion helper, per-field coverage, exclusionNote generalization
- `src/lib/competitor-recommendation.test.ts` — new cases above
- `src/components/admin/competitor-intel/RecommendedCohortCard.tsx` — coverage badge + warning surface
- `src/components/admin/competitor-intel/MarketPositionView.tsx` — coverage badge on the comparison rows
