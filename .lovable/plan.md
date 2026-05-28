# Fix Per-Size Scraper — Recovery Plan

## What's wrong

A `weekly` scrape just ran for all 11 active firms. Result:

- 9 firms wrote snapshots successfully.
- 2 firms hard-failed: `alpha` (OpenAI 429 TPM) and `lucid` (thin browserless content).
- **0 firms wrote any `competitor_firm_rules` rows.** Every snapshot payload is missing the `rules_by_size` key entirely — meaning the per-size extraction block from the recent rewrite never reached the snapshot insert with data.

Root causes, in order of likelihood:

1. **OpenAI TPM ceiling (30k tokens/min for gpt-4o on this org).** Each firm does 1 base extraction + N per-size extractions back-to-back. With 3–5 sizes per firm × 11 firms running sequentially, the per-size calls 429 and the `catch` swallows the error → `rulesBySize` stays `{}` → `rules_by_size` is set to an empty object → upsert loop has 0 rows → table stays empty. We even see alpha 429 on the *base* call.
2. **No retry / backoff** on the OpenAI call, so a single 429 wipes out that size permanently for the run.
3. **Silent swallow.** `per-size extraction failed for X@Y` only goes to `console.warn`; nothing surfaces in the UI or the snapshot, so the run looks "green" while producing zero new rules.
4. **Hard-failed firms (`alpha`, `lucid`) have no fallback.** One thin fetch or one 429 kills the entire firm for the cycle.

## Fix

### 1. OpenAI client hardening (`supabase/functions/scrape-competitor-intel/index.ts`)

- Add retry-with-backoff around `openaiNormalize`: on HTTP 429, parse `Please try again in Xms` from the body, sleep that long (cap at 30s), retry up to 3 times.
- Switch the per-size extraction to `gpt-4o-mini` (much higher TPM, plenty for "extract these rules at size $X"). Keep `gpt-4o` for the base extraction only.
- Sleep ~250ms between per-size calls inside a firm to stay under TPM.

### 2. Make per-size capture observable

- Track `rulesBySizeErrors: Record<number, string>` next to `rulesBySize`.
- Write both into the snapshot payload (`rules_by_size`, `rules_by_size_errors`).
- Return per-firm `sizes_captured` / `sizes_failed` counts in the function's JSON response so the admin "Re-scrape" button shows real numbers instead of just "ok".

### 3. Always seed the base size

The base extraction already returns one rules object with `account_size_usd`. Currently we only insert it into `rulesBySize` if it happens to match a configured size. Change to: **always** upsert the base size as a `competitor_firm_rules` row, regardless of whether it's in `sizes_to_scrape`. That guarantees at least 1 row per firm even if every per-size call fails.

### 4. Fetch-step resilience for `lucid`

`lucid` failed with `thin browserless content (62)` on both URLs. Add `firecrawl` to its profile's `fetch_strategy` fallback chain (browserless → firecrawl). One-line profile update via `insert` tool, no schema change.

### 5. Run order

- Apply code changes.
- Insert `fetch_strategy` update for `lucid`.
- Re-run `kind=weekly` from the admin UI.
- Verify: `SELECT firm_id, COUNT(*) FROM competitor_firm_rules GROUP BY firm_id;` should show ≥1 row for every active firm, and Pro / Elite firms should show 2–3 rows each.

## Out of scope

- Removing the OpenAI 429 by upgrading the org's TPM tier (user action).
- Replacing browserless with a different vendor.
- UI changes beyond surfacing the new per-firm capture counts.

## Files touched

- `supabase/functions/scrape-competitor-intel/index.ts` — retry/backoff, model swap for per-size, base-size always upsert, error capture in payload, richer JSON response.
- `src/components/admin/competitor-intel/ScraperCoverageCard.tsx` — surface `sizes_captured / sizes_total` from the last run (small read-only addition).
- One `insert`-tool data update for `lucid.fetch_strategy`.
