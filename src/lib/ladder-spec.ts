// ============================================================
// Ladder Progression Specification — v1.0
// Defines unlock rules, streak mechanics, and downgrade logic
// for Starter → Pro → Elite progression.
//
// This is the SINGLE SOURCE OF TRUTH for ladder logic.
// UI components read from here. Backend enforcement references
// the same thresholds (duplicated in Edge Functions if needed).
// ============================================================

// ----- Core Definitions -----

/**
 * A "clean payout" is one that:
 * 1. Reached terminal paid status (paid | paid_confirmed)
 * 2. Was NOT deferred by soft pacing (budget deferral)
 * 3. Had no active breaker engagement (L1 or L2) at time of request
 * 4. Had no rule violations flagged on the account during that payout cycle
 *
 * Rationale: Deferred payouts are not the trader's fault, but they
 * don't demonstrate sustained clean behavior either. We don't penalize
 * (no streak reset), but we don't credit them.
 */
export interface CleanPayoutCriteria {
  /** Must be in TERMINAL_PAID_STATUSES */
  terminalPaid: true;
  /** Payout was not deferred by soft pacing budget */
  notDeferred: true;
  /** No breaker engagement (L1/L2) at time of payout request */
  noBreakerEngaged: true;
  /** No open flags on the account during the payout cycle */
  noActiveFlags: true;
}

// ----- Ladder Tiers -----

export interface LadderTier {
  id: string;
  name: string;
  /** Payout split percentage the trader receives */
  splitPercent: number;
  /** First payout cap amount (USD) */
  firstPayoutCap: number;
  /** Payout cooldown in days */
  cooldownDays: number;
  /** Number of clean payouts required to unlock this tier (cumulative) */
  cleanPayoutsRequired: number;
  /** Lifetime cap multiple applied to entry fee */
  lifetimeCapMultiple: number;
}

/**
 * Ladder tiers — progressive unlocks.
 *
 * Baseline (Starter Performance) is the entry point.
 * Each subsequent tier requires cumulative clean payouts.
 *
 * Key design decisions:
 * - Unlocks are PERMANENT once earned (no downgrade)
 * - Clean payout count never resets
 * - Deferred payouts don't count but don't reset streak
 * - Breaker engagement pauses progress (doesn't count) but doesn't reset
 */
export const LADDER_TIERS: LadderTier[] = [
  {
    id: 'starter',
    name: 'Starter',
    splitPercent: 80,
    firstPayoutCap: 500,
    cooldownDays: 14,
    cleanPayoutsRequired: 0,
    lifetimeCapMultiple: 10,
  },
  {
    id: 'pro',
    name: 'Pro',
    splitPercent: 82,
    firstPayoutCap: 500,
    cooldownDays: 14,
    cleanPayoutsRequired: 3,
    lifetimeCapMultiple: 10,
  },
  {
    id: 'elite',
    name: 'Elite',
    splitPercent: 85,
    firstPayoutCap: 750,
    cooldownDays: 10,
    cleanPayoutsRequired: 6,
    lifetimeCapMultiple: 12,
  },
];

// ----- Progression Logic -----

export interface LadderProgress {
  /** Current tier the trader has unlocked */
  currentTier: LadderTier;
  /** Index in LADDER_TIERS */
  currentTierIndex: number;
  /** Total clean payouts earned (lifetime, never resets) */
  cleanPayoutCount: number;
  /** Next tier to unlock (null if at max) */
  nextTier: LadderTier | null;
  /** Clean payouts still needed for next tier (0 if at max) */
  payoutsToNextTier: number;
  /** Whether the trader is at the highest tier */
  isMaxTier: boolean;
}

/**
 * Calculate a trader's current ladder position.
 *
 * Rules:
 * - Unlocks are permanent: once you hit 3 clean payouts, you're Pro forever
 * - Clean payout count is monotonically increasing (never decremented)
 * - We find the highest tier whose cleanPayoutsRequired <= cleanPayoutCount
 */
export function calculateLadderProgress(cleanPayoutCount: number): LadderProgress {
  let currentTierIndex = 0;

  for (let i = LADDER_TIERS.length - 1; i >= 0; i--) {
    if (cleanPayoutCount >= LADDER_TIERS[i].cleanPayoutsRequired) {
      currentTierIndex = i;
      break;
    }
  }

  const currentTier = LADDER_TIERS[currentTierIndex];
  const nextTierIndex = currentTierIndex + 1;
  const nextTier = nextTierIndex < LADDER_TIERS.length ? LADDER_TIERS[nextTierIndex] : null;
  const payoutsToNextTier = nextTier
    ? Math.max(0, nextTier.cleanPayoutsRequired - cleanPayoutCount)
    : 0;

  return {
    currentTier,
    currentTierIndex,
    cleanPayoutCount,
    nextTier,
    payoutsToNextTier,
    isMaxTier: nextTier === null,
  };
}

// ----- Unlock Benefits Summary (for UI) -----

export interface UnlockBenefit {
  icon: 'split' | 'cap' | 'cooldown' | 'lifetime';
  label: string;
  fromValue: string;
  toValue: string;
}

/**
 * Get the specific benefits unlocked when moving from one tier to the next.
 * Used by UI to show "what you get" at each level.
 */
export function getUnlockBenefits(fromTier: LadderTier, toTier: LadderTier): UnlockBenefit[] {
  const benefits: UnlockBenefit[] = [];

  if (toTier.splitPercent > fromTier.splitPercent) {
    benefits.push({
      icon: 'split',
      label: 'Payout Split',
      fromValue: `${fromTier.splitPercent}%`,
      toValue: `${toTier.splitPercent}%`,
    });
  }

  if (toTier.firstPayoutCap > fromTier.firstPayoutCap) {
    benefits.push({
      icon: 'cap',
      label: 'First Payout Cap',
      fromValue: `$${fromTier.firstPayoutCap}`,
      toValue: `$${toTier.firstPayoutCap}`,
    });
  }

  if (toTier.cooldownDays < fromTier.cooldownDays) {
    benefits.push({
      icon: 'cooldown',
      label: 'Payout Cooldown',
      fromValue: `${fromTier.cooldownDays} days`,
      toValue: `${toTier.cooldownDays} days`,
    });
  }

  if (toTier.lifetimeCapMultiple > fromTier.lifetimeCapMultiple) {
    benefits.push({
      icon: 'lifetime',
      label: 'Lifetime Cap',
      fromValue: `${fromTier.lifetimeCapMultiple}×`,
      toValue: `${toTier.lifetimeCapMultiple}×`,
    });
  }

  return benefits;
}

// ----- Interaction with Pacing & Breaker -----

/**
 * How ladder progression interacts with the risk system:
 *
 * SOFT PACING (Layer 1):
 * - If a payout is deferred due to budget: it does NOT count as clean
 * - It also does NOT reset the streak (neutral — not the trader's fault)
 * - Once the deferred payout is eventually paid, it counts as clean
 *   ONLY if the other clean criteria were met at original request time
 *
 * HARD BREAKER (Layer 2):
 * - If breaker is at L1 (Tighten) at time of payout request:
 *   payout does not count as clean (tightened rules were active)
 * - If breaker is at L2 (Freeze): payouts are blocked entirely,
 *   so no payout can occur — moot
 * - Breaker engagement does NOT reset clean count (no punishment)
 *
 * FLAGS:
 * - Any open flag (pending/escalated) on the account during the
 *   payout cycle disqualifies that payout from "clean" status
 * - Cleared flags before payout request: payout can still be clean
 *
 * DOWNGRADES:
 * - There are NO downgrades. Unlocks are permanent.
 * - Rationale: Downgrades create anxiety and churn. The clean payout
 *   requirement already ensures only consistent traders progress.
 *   If behavior degrades, they simply stop accumulating — they don't lose.
 *
 * INACTIVITY:
 * - No decay. A trader who takes 6 months off keeps their tier.
 * - Rationale: Punishing returning traders hurts retention.
 *
 * ACCOUNT SCOPE:
 * - Clean payout count is PER ROOT ACCOUNT LINEAGE, not per user.
 * - A trader with multiple accounts has separate ladder progress per lineage.
 * - Rationale: Prevents gaming via multi-account to fast-track unlocks.
 */
