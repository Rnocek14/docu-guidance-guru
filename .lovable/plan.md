# Launch Traction Plan — Distribution Over Engineering

The risk architecture is done. From here, every build should answer one question: **does this generate trader trust, payout proof, or repeat revenue?** If no, defer.

Four workstreams, ordered by ROI. Ship 1 → 2 → 3 → 4. Do not parallelize 3 or 4 until 1 and 2 are live and producing real screenshots.

---

## 1. Payout Proof System (HIGHEST ROI)

**Goal:** Every paid trader becomes a marketing asset. Make sharing the default action, not an afterthought.

**What to build:**
- **Shareable payout receipt page** — public, unlisted URL per paid payout: `/p/[short_id]`. Renders trader handle (opt-in display name), amount, tier badge, "Paid by Meridian" wordmark, date. Open Graph image auto-generated for Twitter/Discord previews.
- **"Share your payout" modal** — appears once when a payout flips to `paid_confirmed`. One-click buttons: Copy link, Download PNG, Tweet, Open in Discord.
- **$25 share bonus (opt-in)** — trader pastes public post URL → admin verifies → bonus credited to next payout. New `payout_share_bonuses` table, simple admin approve queue.
- **Public payout wall** — `/payouts` landing route. Anonymized feed of recent paid payouts (handle + amount + tier + relative time). Live social proof on the marketing site. Drives the funnel back to checkout.

**Why first:** Cheapest viral loop. Each verified screenshot reduces CAC on the next 50 sales. Architecture already tracks `is_clean_payout` and `paid_confirmed` — we're just adding a presentation layer + one bonus table.

---

## 2. Reset Funnel (HIGHEST REVENUE LIFT)

**Goal:** Convert breach events into reset purchases within 24 hours. Today there is **no in-app reset CTA at all** — this is the single biggest revenue leak.

**What to build:**
- **Breach-moment CTA** — `AccountPhaseIndicator` / `WhatsNextCard` show a prominent "Reset for $99 — keep your progress streak" button the instant status flips to `failed`. Existing breach copy stays; CTA is additive.
- **24-hour urgency discount** — first 24h after breach: $79 reset (20% off). After 24h: $99. Countdown timer visible in dashboard + email. Server-enforced; cohort-aware; reuses existing checkout pipeline with a `reset_discount` flag.
- **Reset email sequence** — 3 transactional emails via Lovable Email: T+0 (breach + discount link), T+12h (last chance), T+48h (final offer at full price). One template, dynamic copy.
- **Reset bundle SKU** — "3-pack resets — $199 (save $98)." New tier variant in `tier-economics.ts`, single Stripe price, decrements a `reset_credits` counter on the account lineage.
- **"Reset history" strip** on TraderDashboard — gamifies persistence ("Attempt 3 of ∞ — most traders pass by attempt 4"). Soft social proof, no manipulation.

**Why second:** Pure margin. Acquisition is already paid for. Every reset captured here is found money.

---

## 3. Affiliate / Creator Scaffold (DISTRIBUTION ENGINE)

**Goal:** Stand up the rev-share rails so a creator can sign up, get a link, and earn within 10 minutes. Don't recruit yet — just be ready when the first payout screenshots go viral.

**What to build:**
- `affiliates` table (user_id, code, rate_pct default 20, payout_method, status)
- `affiliate_attributions` table (purchase_id, affiliate_id, amount_due, status)
- `/affiliate/apply` page — simple form, manual approval initially
- `/affiliate/dashboard` page — link, clicks, conversions, pending payout, paid total
- Checkout attribution: capture `?ref=CODE` → cookie (30 days) → stamp on `checkout_fulfillment_queue` → resolve to `affiliate_attributions` on `paid_confirmed`
- Admin page: approve affiliates, mark commissions paid (manual Stripe transfer for v1 — no automation needed at this volume)
- **Do NOT build:** automated payouts, MLM tiers, leaderboards, fancy dashboards. Bare-minimum until 5 active affiliates exist.

**Why third:** Builds quietly in background. The moment payout screenshots start spreading (from #1), one DM to a small YouTube trader unlocks compounding distribution. If the rails don't exist that day, the moment is lost.

---

## 4. Dashboard Trust Polish (CONVERSION DEFENSE)

**Goal:** A trader landing on the dashboard for the first time should think "this is real" within 5 seconds. Tactical, not a redesign.

**What to build:**
- **Drawdown visual upgrade** in `EquityCurveChart` — render the trailing 10% EOD floor as a visible line that locks at starting balance. Makes the abstract rule tangible.
- **Payout tracker bar** — across the top of TraderDashboard: "$0 paid → $500 first payout cap → $1,490 lifetime." Visible progress is psychological gold.
- **Rules clarity card** — collapsible "Your rules at a glance" on first dashboard load, dismissible. One source of truth, plain English.
- **Live payout ticker** — small footer strip pulling the same feed as the public payout wall: "Trader_X just got paid $312 — 2 min ago." Real social proof inside the product.
- **Pro/Elite cards on pricing** — keep them, but add explicit "Unlocks after Starter beta — Q[X] 2026" badge so they read as roadmap not vaporware. (Reverses prior advice based on user feedback — clearer label, not removal.)

**Why fourth:** Polish only matters once #1–3 are driving traffic. Premature polish = procrastination.

---

## Explicit Non-Goals

These are off the table until post-launch data demands them:
- More risk rules, breakers, or restrictions
- Additional tiers, currencies, or instruments
- Re-architecting the ladder or payout pacing
- AI-anything that isn't already shipped
- Mobile app
- More admin dashboards

---

## Technical Notes

- All new edge function logic follows existing patterns: SECURITY DEFINER RPCs, `FOR UPDATE` on money rows, server-side state transitions only.
- Reset discount logic lives in `_shared/checkout/tier-economics.ts` (SSOT) — never duplicated in the UI.
- Public payout pages must read from a security-definer RPC that returns only the opted-in safe fields. No direct table exposure.
- Share bonuses are tracked separately from `payouts` so they never pollute `is_clean_payout` or lifetime cap math.
- Affiliate commissions are a *liability*, not a payout — they bypass the trader payout pipeline entirely.

---

## Suggested Sequencing (rough)

1. Payout proof system — ship within 1 week. Highest leverage per hour of work.
2. Reset funnel — ship week 2. Revenue starts compounding immediately.
3. Affiliate scaffold — week 3, quiet build. Have it ready before you need it.
4. Dashboard polish — week 4, iterate based on first 50 users' confusion points.

Then stop building and spend 30 days on distribution: outreach, content, Discord, creator DMs. Architecture is done.

---

**Confirm this ordering and I'll start with workstream 1 (Payout Proof). Or tell me which workstream to start with if you want a different order.**

## Workstream 2 — Reset Funnel (shipped)
- `src/lib/reset-bundles.ts` + `supabase/functions/_shared/reset-bundles.ts` — bundle SSOT (single $99, urgency $79, 3-pack $199), 24h urgency window helpers.
- `ResetOfferCard` — breach-moment CTA mounted in `AccountDetails` after `BreachExplainer`. Live countdown when urgency window is open.
- `/reset/:accountId` page (`ResetCheckout.tsx`) — bundle picker + order summary, calls `create-reset-checkout`.
- `create-reset-checkout` edge function — Stripe checkout session (price_data, no product lookup); pre-persists `pending` row in `reset_purchases`; server-side urgency-window enforcement.
- `reset_purchases` table — RLS: traders read own, admins/risk read all; no client writes.
- `ResetHistoryStrip` on trader dashboard — banked + recent reset bundles.

Deferred (Workstream 2b):
- Webhook handler to flip `pending → paid` and trigger reset application (will extend existing payment-webhook).
- Breach-trigger email sequence (rolls into email infra workstream).
