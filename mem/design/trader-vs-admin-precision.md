---
name: Trader vs Admin Precision
description: Trader UI uses qualitative bands for headroom/caps; admin UI keeps exact dollars. Never expose lifetime-headroom dollars on trader surfaces.
type: design
---
**Rule:** Trader-facing surfaces show qualitative bands and progress bars for lifetime cap / headroom — never exact remaining dollars. Admin / internal / risk surfaces keep exact dollars, ratios, and forecasts.

**Why:** Exact lifetime headroom anchors traders psychologically and becomes gameable ("I can still extract $X before the system tightens"), shifting behavior from disciplined trading to payout-optimization-against-the-platform. Preserves casino-brain architecture and fairness perception.

**How to apply:**
- Trader UI lifetime cap usage → `getHeadroomBand(usagePct)` from `src/lib/headroom-band.ts` (Plenty Remaining / Healthy Usage / Well Used / Nearing Limit / At Review Threshold).
- Trader UI may show: payouts already received (exact), single-request max payout (exact — derived from split × P&L, not gameable), progress bars without axis labels.
- Trader UI must NOT show: exact lifetime headroom $, exact cap remaining $, exact pacing-band ratios.
- Admin surfaces (`AdminPayoutsTable`, `AdminAccountDetail`, ops dashboards) keep full precision.
- Future: precision may be unlocked as a trust privilege for higher tiers / funded accounts.
