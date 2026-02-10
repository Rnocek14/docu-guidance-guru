

# Customer-Facing Overhaul: Competitive Parity Plan

## The Problem

Your current site looks like an internal admin tool, not a product people buy. Comparing to Tradeify, Alpha Futures, and Funded Futures Family, you're missing every element that converts a visitor into a paying customer.

### Gap Analysis: What Competitors Have That You Don't

| Feature | Tradeify | Alpha Futures | FFF | You |
|---------|----------|--------------|-----|-----|
| High-impact landing page with hero imagery | Yes | Yes | Yes | Bare minimum |
| Pricing table with rules comparison | Yes (interactive) | Yes (tabbed) | Yes (multi-plan tabs) | Hidden in checkout only |
| "How it Works" 3-step flow | Yes | Yes | Yes | No |
| Social proof (Trustpilot, payout totals) | Yes ($110M+) | Yes ($25M+) | Yes ($14M+) | No |
| FAQ / Rules page | Yes | Yes | Yes | No |
| Promo/discount banner | Yes | Yes | Yes | No |
| Payout proof / certificates | Yes (carousel) | Yes (testimonials) | Yes (photos) | No |
| Trader dashboard with clear account status | Basic | Yes | Yes | Functional but plain |
| "Start Evaluation" purchase flow from landing page | Seamless | Seamless | Seamless | Exists but disconnected |
| Dark theme (trading terminal feel) | Yes | Yes | Yes | Supported but landing is light |

## Implementation Plan

This is broken into 4 workstreams, ordered by impact. Each can be done incrementally.

---

### Workstream 1: Landing Page Rebuild (Highest Impact)

**Goal:** A landing page that looks like a real product, not a placeholder.

#### 1a. New Hero Section
- Dark gradient background (use your existing dark mode palette)
- Bold headline: your existing "Simulated Trading Evaluation" messaging
- Key differentiators as bullet badges (like Tradeify's "Daily Payouts / No Consistency / EOD Drawdown")
- Primary CTA: "Start Your Evaluation" linking to the pricing section
- Secondary CTA: "Sign In" for returning users
- Social proof placeholder row (Trustpilot widget slot, payout counter slot)

#### 1b. "How It Works" Section
A 3-step visual flow (matches every competitor):
1. **Choose Your Plan** -- Pick your simulated account size
2. **Pass the Evaluation** -- Meet the profit target within the rules
3. **Get Paid** -- Request your performance-based reward

Each step gets an icon, short description, and a connecting visual line/arrow.

#### 1c. Pricing Section (on the landing page, not just checkout)
- Interactive tier selector (Starter / Pro / Elite) showing your existing 3 tiers
- Each tier shows: price, account size, profit target, max drawdown, payout split, lifetime cap, reset fee
- Rules comparison table below the cards
- "Most Popular" badge on Pro
- CTA button on each card goes directly to checkout with that tier pre-selected
- Regulatory disclaimer text at the bottom of the section

#### 1d. "Why Choose Us" / Differentiators Section
- Frozen rules (no mid-challenge changes)
- Human-in-the-loop (AI never auto-denies)
- Full audit trail / transparency
- Performance-based rewards with clear caps

#### 1e. FAQ Section
Collapsible accordion with the top 8-10 questions:
- "Is this real trading?" (No -- simulated environment)
- "How do payouts work?" (Performance-based rewards, not withdrawals)
- "What happens if I breach a rule?" (Human review, not auto-fail)
- "Can rules change during my challenge?" (No -- frozen at start)
- "What platforms can I use?" (Currently manual entry, broker integration coming)
- "What's the reset fee?" ($99)
- "What's the lifetime cap?" (Explain multiplier)
- "How fast are payouts?" (TBD -- placeholder)

#### 1f. Footer
- Mandatory sim-trading disclaimer (you already have this)
- Links: Terms, Privacy, FAQ, Contact
- Copyright

---

### Workstream 2: Dedicated Pages

#### 2a. Rules Page (`/rules`)
A standalone page explaining all evaluation rules clearly:
- Evaluation phase rules (profit target, drawdown, min days, position sizing)
- Performance phase rules (payout eligibility, cooling period, caps)
- Table comparing rules across the 3 tiers
- Links back to pricing/checkout

#### 2b. Enhanced Checkout Flow
The existing checkout page is solid but needs:
- URL support for pre-selected tier (`/checkout?tier=pro`)
- Tier cards should show rule details inline (not just features list)
- Add a "Back to Plans" link that goes to the landing page pricing section

---

### Workstream 3: Trader Dashboard Polish

#### 3a. Empty State Improvement
When a trader has no accounts, instead of "Contact support," show:
- "Start Your First Evaluation" card with a CTA to `/checkout`
- Brief explanation of what happens after purchase

#### 3b. Account Card Enhancements
- Add a visual progress ring or bar for profit target completion
- Show days remaining more prominently
- Color-code drawdown proximity to limit (green/yellow/red)

#### 3c. Navigation Polish
- Add a "Buy New Account" link in the trader sidebar
- Link back to the landing page from the dashboard logo

---

### Workstream 4: Design System & Polish

#### 4a. Dark-First Landing Page
- The landing page should default to dark mode (trading terminal aesthetic) regardless of system preference
- Use the existing dark mode CSS variables
- Add subtle gradient backgrounds and glow effects for visual polish

#### 4b. Component Additions
New reusable components needed:
- `StepCard` -- for the "How it Works" section
- `PricingTable` -- interactive tier comparison with rules
- `FAQAccordion` -- collapsible Q&A using the existing Accordion primitive
- `SocialProofBar` -- placeholder for Trustpilot + payout counter
- `PromoBar` -- dismissible top banner for discounts (future use)

---

## Technical Details

### New Files to Create
```text
src/pages/Index.tsx              -- Complete rewrite (landing page)
src/pages/Rules.tsx              -- New rules page
src/components/landing/Hero.tsx
src/components/landing/HowItWorks.tsx
src/components/landing/PricingSection.tsx
src/components/landing/Differentiators.tsx
src/components/landing/FAQ.tsx
src/components/landing/Footer.tsx
src/components/landing/SocialProofBar.tsx
```

### Files to Modify
```text
src/App.tsx                      -- Add /rules route
src/pages/Checkout.tsx           -- Support ?tier= query param
src/pages/trader/TraderDashboard.tsx  -- Improve empty state
src/pages/trader/TraderAccounts.tsx   -- Improve empty state + CTA
src/components/layout/DashboardLayout.tsx -- Add "Buy Account" nav item
```

### No Backend Changes Required
All changes are frontend-only. Pricing data is already hardcoded in the checkout page and will be shared via a constants file.

### Routing Updates
| Route | Page |
|-------|------|
| `/` | Rebuilt landing page |
| `/rules` | New rules page |
| `/checkout?tier=pro` | Existing checkout with pre-selection |

---

## Execution Order

1. **Landing page rebuild** (Hero + Pricing + How It Works + FAQ + Footer) -- this is the "money page"
2. **Checkout pre-selection** support
3. **Trader dashboard empty states** with purchase CTA
4. **Rules page**
5. **Design polish** (dark theme, gradients, animations)

This gets you from "internal tool" to "product someone would buy" in one focused sprint. No backend changes, no new dependencies, just making the existing product sellable.

