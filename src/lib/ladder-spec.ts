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

// ============================================================
// SPEC-HARDENING DECISIONS (v1.0 — locked 2026-03-03)
// ============================================================
//
// Decision 1: Does L1 (Tighten) disqualify clean payouts?
//   NO. L1 is a structural risk control ("tighten seatbelt"), not a
//   trader behavior signal. Disqualifying L1 payouts would block
//   progress during normal volatility, feeling unfair. Only L2 (Freeze)
//   disqualifies — but L2 blocks payouts entirely, making it moot.
//
// Decision 2: Is "clean" evaluated at PAID time or REQUEST time?
//   AT PAID TIME. This is simpler (no request-time snapshot needed),
//   operationally unambiguous, and still fair. Deferral just delays
//   the payout; the clean evaluation happens once it actually settles.
//   No special deferral logic, no snapshot storage, no disputes.
//
// Decision 3: Ladder scope = per USER or per ACCOUNT LINEAGE?
//   PER ACCOUNT LINEAGE (root_account_id chain). This prevents gaming
//   via multi-account fast-tracking. Marketing tradeoff accepted:
//   power users with multiple lineages progress each independently.
//   UI should show ladder per-lineage, not aggregated.
// ============================================================

/**
 * A "clean payout" is one that, AT THE TIME IT REACHES TERMINAL PAID STATUS:
 * 1. Has terminal paid status (paid | paid_confirmed)
 * 2. Account had NO active compliance flags (pending | escalated) at paid time
 * 3. Breaker was NOT at L2 (Freeze) at paid time (L1 Tighten is OK)
 *
 * Note: Deferred payouts are NOT disqualified. Deferral delays the payout;
 * once it settles, it's evaluated like any other. If clean at paid time, it counts.
 * This means there is NO concept of "deferred but clean at request time" — simpler.
 *
 * Note: L1 (Tighten) does NOT disqualify. L1 is structural risk pacing.
 * Only L2 (Freeze) disqualifies, but L2 blocks payouts entirely, so in
 * practice this criterion is a safety net, not a regular gate.
 */
export interface CleanPayoutCriteria {
  /** Must be in TERMINAL_PAID_STATUSES */
  terminalPaid: true;
  /** No active compliance flags (pending | escalated) on account at paid time */
  noActiveComplianceFlags: true;
  /** Breaker NOT at L2 (Freeze) at paid time. L1 (Tighten) is OK. */
  noBreakerL2: true;
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
 * - Unlocks are PERMANENT once earned (no downgrade, no decay)
 * - Clean payout count never resets (monotonically increasing)
 * - Deferred payouts: evaluated at paid time like any other
 * - L1 (Tighten) does NOT disqualify — only L2 (Freeze) does
 * - Evaluated at PAID time, not request time (no snapshots needed)
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

// ----- Interaction with Pacing & Breaker (HARDENED) -----

/**
 * How ladder progression interacts with the risk system:
 *
 * EVALUATION TIMING:
 * - "Clean" is evaluated AT PAID TIME (when payout reaches terminal status).
 * - No request-time snapshots are needed. No special deferral logic.
 * - This is simpler, operationally unambiguous, and non-disputable.
 *
 * SOFT PACING (Layer 1):
 * - Deferral just delays the payout. It doesn't create special logic.
 * - Once a deferred payout settles to paid, it's evaluated like any other.
 * - If clean at paid time → counts. If not → doesn't count (no reset).
 *
 * HARD BREAKER:
 * - L1 (Tighten): does NOT disqualify. L1 is structural risk pacing,
 *   not a trader behavior signal. Blocking progress during L1 would
 *   punish traders for market conditions they don't control.
 * - L2 (Freeze): would disqualify, but L2 blocks payouts entirely,
 *   so no payout can reach paid status during L2. Safety net only.
 *
 * FLAGS:
 * - Any active compliance flag (pending | escalated) on the account
 *   AT THE TIME the payout reaches terminal paid → disqualifies.
 * - Flags cleared before paid time: payout can still be clean.
 * - Flags created after paid time: irrelevant to that payout.
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
 * - Clean payout count is PER ROOT ACCOUNT LINEAGE (root_account_id chain).
 * - A trader with multiple accounts has separate ladder progress per lineage.
 * - Rationale: Prevents gaming via multi-account to fast-track unlocks.
 * - UI shows ladder per-lineage, not aggregated across lineages.
 *
 * DATA REQUIREMENTS:
 * - Payouts table needs: is_clean_payout boolean (set at paid time)
 * - Clean count can be derived: COUNT(*) WHERE is_clean_payout = true
 *   AND account_id IN (lineage accounts) AND status IN terminal_paid
 * - Alternatively, store clean_payout_count on the root account for perf.
 * - Breaker state check: query econ_breaker_state.breaker_level at paid time
 * - Flag check: query flags WHERE account_id = X AND status IN ('pending','escalated')
 */
