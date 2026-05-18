# Trader Dashboard Cleanup — Clarity Pass

## Goal

Answer the trader's two real questions ("how much have I made" / "how far do I have to go") **without adding cards**. Enrich existing cards, remove redundant ones, and keep precise dollar exposure out of the trader UI to avoid gameable behavior.

## Principle: Qualitative for trader, exact for admin

A new project rule I'll save to memory:

- **Trader-facing UI** — show progress bars, qualitative bands (Plenty Remaining / Healthy / Well Used / Nearing Limit / At Review), and supportive copy. No exact lifetime-headroom dollars.
- **Admin / internal UI** — keep exact dollars, ratios, forecasts. Operations needs precision.
- **Precision as a privilege** — leave the door open to unlock exact figures later for higher tiers / funded accounts.

This avoids anchoring traders to a number they'll optimize against ("$1,070 left to extract") and preserves the casino-brain architecture.

## Changes

### 1. Remove `UnlockRoadmap` from the dashboard
Keep `TierStatusCard` (where am I + progress to next) and `CleanPayoutChecklist` (what counts as clean). The roadmap card duplicates Tier Status visually. It moves to a future `/trader/ladder` detail page (not built this pass — just unmounted from the dashboard for now).

### 2. Enrich `PayoutReadinessCard` with the next-payout number
Currently shows only "Eligible / In Progress" + top blocker + CTA. Add a single prominent line above the blocker:

- Eligible: **"Next payout: up to $X"** (from `eligibility.max_eligible_amount`)
- Waiting: **"Estimated next payout: $X when window opens"**
- Blocked: omit the number

Why this number is OK to show: it's a single-request maximum derived from split × current P&L. Traders can compute it themselves from rules; it's not gameable against the platform the way lifetime headroom is.

### 3. Convert `CapProgressCard` / Portfolio "Total Payouts" tile to a qualitative band
The "Total Payouts" tile in `PortfolioOverview` keeps **"$420 received"** (exact — these are payouts already made, no game-theory risk). Add a second line: a qualitative headroom badge for the account:

| Band | Trigger (lifetime cap usage) | Copy |
|------|------------------------------|------|
| Plenty Remaining | < 25% | "You're comfortably within payout pacing." |
| Healthy Usage | 25–50% | "Steady progress — keep trading cleanly." |
| Well Used | 50–75% | "You've used a healthy portion of this account." |
| Nearing Limit | 75–90% | "Recent withdrawals are approaching your pacing band." |
| At Review Threshold | > 90% | "Maintain clean trading to continue expanding headroom." |

`CapProgressCard` (already in `PayoutRequest.tsx`) gets the same qualitative treatment — replace exact "$ remaining" text with the badge + copy, keep the progress bar (visual only, no axis labels).

### 4. Admin views stay exact
`AdminPayoutsTable`, `AdminAccountDetail`, and any operator-facing surface keep exact dollar headroom, ratios, and forecasts. No change there.

## Files Touched (frontend only, no DB / no edge functions)

- `src/pages/TraderDashboard.tsx` — unmount `UnlockRoadmap` from the ladder row; grid becomes 2-col (TierStatus + CleanPayoutChecklist).
- `src/components/trader/PayoutReadinessCard.tsx` — add next-payout dollar line driven by `eligibility.max_eligible_amount`.
- `src/components/trader/PortfolioOverview.tsx` — add qualitative headroom badge to "Total Payouts" tile using account-level cap usage %.
- `src/components/trader/CapProgressCard.tsx` — swap exact "$ remaining" for qualitative band + copy; keep bar.
- New helper: `src/lib/headroom-band.ts` — pure function `getHeadroomBand(usagePct) → { band, copy }` so the bands are SSOT and reusable.

## Out of scope (this pass)

- New "Earnings & Headroom" 3-tile band — explicitly dropped (would add clutter).
- Per-cycle "$Z available · N payouts so far" tile — dropped for same reason.
- Building a dedicated `/trader/ladder` detail page (parked for later).
- Any backend / RPC / migration work.

## Resulting dashboard

Card count drops from ~12 to ~10. Both trader questions are answered inside cards that already exist. No exact lifetime-headroom dollars exposed to the trader.

## Memory update

After implementation I'll add `mem://design/trader-vs-admin-precision` capturing the hybrid principle so future work doesn't reintroduce exact headroom numbers to trader surfaces.
