

# Trader Dashboard Clarity Components

## Overview

Add three small, high-leverage UI elements to the Trader Dashboard to eliminate trader confusion about their account phase, first payout milestone, and lifetime headroom. This is NOT a redesign - it's targeted transparency work.

## The Problem

The backend is mathematically sound (KYC, velocity limits, lifetime caps, race-condition-safe RPCs), but traders don't experience backend correctness. They experience:
- "Why can't I request a payout?"
- "What's this $300 limit?"
- "Is this legit or am I getting scammed?"

The biggest risk is user confusion, not system abuse.

## The Solution: 3 Targeted Components

### 1. Phase Indicator Banner

A prominent banner at the top of the dashboard showing:

```
Challenge Phase         ->  "Keep trading to hit your profit target"
  OR
Performance Account     ->  "You're payout-eligible!"
```

**Logic:**
- `status === 'active'` = Challenge Phase (evaluation)
- `status === 'passed'` or any `payout_*` status = Performance Account (PA)
- Show different icons and colors for each phase

**Placement:** Top of TraderDashboard, immediately after the welcome section.

### 2. First Payout Milestone Card

A small card (only visible in PA phase) showing:

```
First Payout Milestone: $300
(Higher payouts unlock after your first withdrawal)
```

**Data source:** `cohort.first_payout_cap_amount` (already in the accounts query)

**Key framing:**
- Call it "Milestone" not "Cap"
- Explain that subsequent payouts are not limited to $300
- Only show for PA-phase accounts

### 3. Lifetime Headroom Display

A read-only display showing:

```
Lifetime Payout Remaining: $X,XXX
```

**Data source:** Call `calculate_payout_eligibility` RPC which returns:
- `lifetime_cap_amount`
- `lifetime_paid_total`
- `lifetime_headroom`

**Framing:**
- Show this as a simple progress bar (paid vs remaining)
- Only visible for PA-phase accounts with lifetime caps configured
- If uncapped cohort, hide this entirely

## Technical Implementation

### New Component: `AccountPhaseIndicator.tsx`

Location: `src/components/trader/AccountPhaseIndicator.tsx`

```text
+------------------------------------------------------+
| [Icon] CHALLENGE PHASE                               |
| Hit your 10% profit target to unlock your            |
| Performance Account                                  |
+------------------------------------------------------+

OR

+------------------------------------------------------+
| [Checkmark] PERFORMANCE ACCOUNT                      |
| You've passed! Request payouts from your profits     |
+------------------------------------------------------+
```

Props:
- `status: AccountStatus`
- `profitTargetPercent: number`

### New Component: `PayoutMilestoneCard.tsx`

Location: `src/components/trader/PayoutMilestoneCard.tsx`

```text
+--------------------------------------+
| FIRST PAYOUT MILESTONE               |
| $300                                 |
| Subsequent payouts are uncapped      |
| once consistency is demonstrated.    |
+--------------------------------------+
```

Props:
- `firstPayoutCapAmount: number | null`
- `isFirstPayoutInCycle: boolean`

### New Component: `LifetimeHeadroomCard.tsx`

Location: `src/components/trader/LifetimeHeadroomCard.tsx`

```text
+--------------------------------------+
| LIFETIME PAYOUT HEADROOM             |
| [===========================----]    |
| $650 remaining of $700 total         |
+--------------------------------------+
```

Props:
- `lifetimeCapAmount: number | null`
- `lifetimePaidTotal: number`
- `lifetimeHeadroom: number | null`

### Modified: `TraderDashboard.tsx`

Changes:
1. Add query for payout eligibility (for PA-phase accounts only)
2. Insert `AccountPhaseIndicator` after welcome section
3. Add new section with `PayoutMilestoneCard` and `LifetimeHeadroomCard` (PA-phase only)

### Data Flow

```text
TraderDashboard
  |
  +-- accounts query (existing)
  |     |-- status
  |     |-- cohort.first_payout_cap_amount
  |     |-- cohort.entry_fee
  |     |-- cohort.lifetime_cap_multiple
  |
  +-- eligibility query (new, only for PA-phase)
        |-- is_first_payout_in_cycle
        |-- lifetime_headroom
        |-- lifetime_paid_total
        |-- lifetime_cap_amount
```

## File Changes Summary

| File | Action | Description |
|------|--------|-------------|
| `src/components/trader/AccountPhaseIndicator.tsx` | Create | Phase banner (Challenge vs PA) |
| `src/components/trader/PayoutMilestoneCard.tsx` | Create | First payout milestone display |
| `src/components/trader/LifetimeHeadroomCard.tsx` | Create | Lifetime headroom progress |
| `src/pages/trader/TraderDashboard.tsx` | Modify | Integrate all three components |
| `src/lib/types.ts` | Modify | Add `PayoutEligibility` interface |

## Copy Guidelines

| Element | Avoid | Use |
|---------|-------|-----|
| $300 limit | "First payout cap" | "First Payout Milestone" |
| Phase name | "Evaluation" | "Challenge Phase" |
| Funded phase | "Funded" | "Performance Account (PA)" |
| Lifetime limit | "Lifetime cap" | "Lifetime Payout Headroom" |

## Out of Scope (Postpone)

- Tier ladder comparison UI
- PA rule deep dives
- AI-driven personalization
- Advanced payout analytics
- Challenge → PA transition celebration modal

## Verification Steps

After implementation:
1. View dashboard with `active` status account - should show "Challenge Phase"
2. View dashboard with `passed` status account - should show "Performance Account"
3. Confirm first payout milestone shows cohort's `first_payout_cap_amount`
4. Confirm lifetime headroom shows correct values from eligibility RPC
5. Confirm components don't appear for uncapped cohorts

