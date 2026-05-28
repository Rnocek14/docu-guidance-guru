## Goal

Today the scraper produces one rules-snapshot per firm at whatever account size that firm's landing page happened to show. That leaves Pro (100K) at the floor of the bucket and Elite (200K) almost empty. We rework the pipeline so rules are captured **per (firm, account size)** and Pro/Elite recommendations finally have ≥3 real samples.

## Approach (Option A — full fix)

Single source of truth shifts from "latest snapshot per firm" to "latest rules per (firm, size)". The existing snapshots table stays as the raw log; a new normalized table holds the per-size rules the recommendation engine reads.

---

## 1. Database

New table `competitor_firm_rules` — one row per (firm_id, account_size_usd), upserted on each scrape.

Columns:
- `firm_id text` (FK to `competitor_intel_profiles`)
- `account_size_usd integer` (50000, 100000, 200000, …)
- `rules jsonb` (same shape as today's `payload.rules`)
- `source_snapshot_id uuid` (FK to `competitor_intel_snapshots`)
- `source_url text`
- `captured_at timestamptz`
- `extraction_confidence text`
- PK: `(firm_id, account_size_usd)`

Standard 4-step migration (CREATE → GRANT authenticated SELECT + service_role ALL → RLS enable → admin-only SELECT policy via `has_role`). No anon grant (admin-only data).

Index: `(firm_id)` for fast per-firm reads.

## 2. Profiles change

Add a `sizes_to_scrape integer[]` column on `competitor_intel_profiles` (default `'{50000,100000,200000}'`). Per-firm overrides for firms that genuinely don't offer a size (e.g. Halcyon Elite). Backfill all 11 active firms with sensible defaults based on their current pricing rows.

## 3. Scraper rewrite (`supabase/functions/scrape-competitor-intel/index.ts`)

For each active profile, instead of one extraction pass per firm:

1. Fetch the configured pricing + rules URLs as today (single markdown bundle per URL).
2. For each `size` in `sizes_to_scrape`:
   - Run the OpenAI normalizer with an **additional system instruction**: "Extract the rules that apply to the {size} account. If the page only lists rules for a different size, return `rules: null`."
   - Keep the per-size rules block; discard if `rules` is null.
3. Write **one `competitor_intel_snapshots` row** (raw markdown + the combined payload, now shaped as `{ pricing, rules_by_size: { "50000": {...}, "100000": {...} } }` plus the legacy `rules` field set to whichever size matched the firm's default for backward compat).
4. Upsert one `competitor_firm_rules` row per non-null size into the new table.
5. Diff logic unchanged (operates on the snapshot payload).

Token budget: one fetch + N small extraction calls per firm (N ≤ 3). Cost stays bounded — the markdown is already in memory; only the LLM call repeats with a tighter prompt.

Curated-reference fallback (`CURATED_REFERENCE`) gets a `rules_by_size` block for the 3–4 firms where we already know Pro/Elite rules from manual research, so the first run after deploy has data even before live scrapes succeed.

## 4. Recommendation engine (`src/lib/competitor-recommendation.ts`)

`snapshotsInBucket()` currently filters by `payload.rules.account_size_usd`. Change the input contract: accept an additional `rulesByFirmSize: Map<firm_id, Map<size, rules>>` and, for each tier, pull the rules row whose size sits inside the tier's bucket. Snapshots without a matching size are excluded from that tier's median (not from others).

All downstream math (median, clamps, rows, proposedCohort) is unchanged.

## 5. UI

- `ScraperCoverageCard`: switch from `payload.rules.account_size_usd` to the new per-size table. A cell is green (`rules`) when the firm has a `competitor_firm_rules` row inside that bucket; amber (`price`) when only a pricing label exists; gray otherwise. Tooltip on amber says "Re-scrape this firm at this size".
- `MarketPositionView`: load `competitor_firm_rules` once and pass `rulesByFirmSize` into `recommendCohort` for all three tiers.
- No new pages, no new buttons.

## 6. Backfill

After deploy, run the scraper once with `kind=weekly` for all firms; the new code path populates `competitor_firm_rules` for the 3 sizes per firm. Verify in admin UI that Pro and Elite both show ≥3 green cells.

## 7. Tests

Extend `src/lib/competitor-recommendation.test.ts`:
- Pro recommendation with 3 firms at 100K → status `ok`, sourceFirms = those 3.
- Elite with only 2 firms at 200K → status `insufficient_data`.
- A firm with rules at 50K only does not contaminate Pro/Elite medians.

---

## Files touched

- new migration: `competitor_firm_rules` table + grants/RLS + `sizes_to_scrape` column on profiles + backfill defaults
- `supabase/functions/scrape-competitor-intel/index.ts` — per-size extraction loop, upsert into new table, extend curated fallback
- `src/lib/competitor-recommendation.ts` — accept `rulesByFirmSize`, change bucket filter
- `src/lib/competitor-recommendation.test.ts` — Pro/Elite coverage tests
- `src/components/admin/competitor-intel/ScraperCoverageCard.tsx` — read new table
- `src/components/admin/competitor-intel/MarketPositionView.tsx` — fetch `competitor_firm_rules`, pass through

## Out of scope

- Reset-bundle recommendations (still belongs on `reset-bundles.ts` SSOT).
- A manual "re-scrape this cell" button (Option B). Skipped — full per-size loop replaces the need.
- Replacing `CURRENT_FLOORS` with MC-derived floors (separate TODO already noted in the code).
