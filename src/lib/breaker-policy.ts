/**
 * Dynamic Breaker Policy for Monte Carlo Simulation
 * 
 * Breakers are stateful within an iteration — they change knobs mid-run
 * and persist until release conditions are met (hysteresis).
 * 
 * Designed to answer: "Do breakers actually stabilize tails, or just delay insolvency?"
 */

import type { SimulationKnobs } from './monte-carlo';

// ============================================================================
// TYPES
// ============================================================================

export type BreakerLevel = 0 | 1 | 2;

export interface BreakerEvent {
  monthIndex: number;
  fromLevel: BreakerLevel;
  toLevel: BreakerLevel;
  reason: string;
  knobOverrides: Partial<SimulationKnobs> | null;
}

export interface BreakerState {
  level: BreakerLevel;
  /** How many consecutive months at or below each release threshold */
  monthsBelowL2Release: number;
  monthsBelowL1Release: number;
  events: BreakerEvent[];
  /** Per-month tracking for diagnostics */
  levelByMonth: BreakerLevel[];
  /** Count of payout requests suppressed by L2 freeze */
  requestsSuppressedByBreaker: number;
  /** Estimated dollar value of payouts suppressed by L2 freeze */
  dollarsSuppressedByBreaker: number;
}

export interface BreakerEvaluationContext {
  monthIndex: number;
  /**
   * 3-month rolling average of Pay/Rev ratio from COMPLETED months only.
   * For month t, this covers months [t-3, t-1] (i.e., the last 3 completed months).
   * The current month's Pay/Rev is NOT included — this is a reactive policy.
   */
  rollingPayRevAvg3Prev: number;
  /** Current breaker level */
  currentLevel: BreakerLevel;
  /** Current breaker state (for hysteresis counters) */
  state: BreakerState;
}

export interface BreakerEvaluationResult {
  nextLevel: BreakerLevel;
  knobOverrides: Partial<SimulationKnobs> | null;
  reason: string;
}

export interface BreakerPolicy {
  name: string;
  version: string;
  /**
   * Called each simulated month to decide breaker transitions.
   * MUST update hysteresis counters internally (policy-owned state).
   */
  evaluate(ctx: BreakerEvaluationContext): BreakerEvaluationResult;
}

// ============================================================================
// BREAKER DIAGNOSTICS (aggregated across iterations)
// ============================================================================

export interface BreakerDiagnostics {
  policyName: string;
  policyVersion: string;
  /** Fraction of total months spent at each level */
  timeInL0Pct: number;
  timeInL1Pct: number;
  timeInL2Pct: number;
  /** Average number of breaker transitions per iteration */
  avgTransitionsPerIteration: number;
  /** Total payout requests suppressed by L2 freeze across all iterations */
  totalRequestsSuppressed: number;
  /** Average payout requests suppressed per iteration */
  avgRequestsSuppressedPerIteration: number;
  /** Total estimated dollars suppressed by L2 freeze */
  totalDollarsSuppressed: number;
  /** Average estimated dollars suppressed per iteration */
  avgDollarsSuppressedPerIteration: number;
  /** Max consecutive months at L2 in any iteration */
  maxConsecutiveL2Months: number;
  /** Distribution of breaker engagement per iteration */
  iterationsWithAnyBreaker: number;
  iterationsWithL2: number;
}

// ============================================================================
// PAY/REV GUARDRAIL V1
// ============================================================================

/**
 * Thresholds & hysteresis for the Pay/Rev Guardrail.
 * 
 * Level 0 → 1: rollingPayRevAvg3Prev > 0.45 (tighten)
 * Level 1 → 2: rollingPayRevAvg3Prev > 0.60 (freeze)
 * Level 2 → 1: rollingPayRevAvg3Prev < 0.55 for 2 consecutive months
 * Level 1 → 0: rollingPayRevAvg3Prev < 0.40 for 3 consecutive months
 */
const PAYREV_V1 = {
  // Escalation thresholds
  l0ToL1Threshold: 0.45,
  l1ToL2Threshold: 0.60,
  // Release thresholds (with hysteresis gap)
  l2ToL1Threshold: 0.55,
  l1ToL0Threshold: 0.40,
  // Consecutive months required for release
  l2ReleaseMonths: 2,
  l1ReleaseMonths: 3,

  // Level 1 knob overrides: tighten velocity
  l1Overrides: {
    minMonthsBetweenPayouts: 2,       // was 1 → now 2 months
    minWinningDaysPerPayout: 15,       // was 10 → now 15
    minProfitSinceLastPayout: 200,     // was 0 → now $200
  } satisfies Partial<SimulationKnobs>,

  // Level 2: payouts effectively frozen (handled in engine via freezePayouts flag)
  // No knob overrides needed — engine checks breakerLevel === 2
} as const;

export const PAY_REV_GUARDRAIL_V1: BreakerPolicy = {
  name: 'Pay/Rev Guardrail',
  version: 'v1',

  evaluate(ctx: BreakerEvaluationContext): BreakerEvaluationResult {
    const { rollingPayRevAvg3Prev, currentLevel, state } = ctx;

    // ── UPDATE HYSTERESIS COUNTERS (policy-owned, not external helper) ──
    if (rollingPayRevAvg3Prev < PAYREV_V1.l2ToL1Threshold) {
      state.monthsBelowL2Release++;
    } else {
      state.monthsBelowL2Release = 0;
    }

    if (rollingPayRevAvg3Prev < PAYREV_V1.l1ToL0Threshold) {
      state.monthsBelowL1Release++;
    } else {
      state.monthsBelowL1Release = 0;
    }

    // ── ESCALATION ──────────────────────────────────────────────
    if (currentLevel === 0 && rollingPayRevAvg3Prev > PAYREV_V1.l0ToL1Threshold) {
      return {
        nextLevel: 1,
        knobOverrides: { ...PAYREV_V1.l1Overrides },
        reason: `Pay/Rev 3mo avg ${(rollingPayRevAvg3Prev * 100).toFixed(1)}% > ${PAYREV_V1.l0ToL1Threshold * 100}% → L1 (tighten)`,
      };
    }

    if (currentLevel === 1 && rollingPayRevAvg3Prev > PAYREV_V1.l1ToL2Threshold) {
      return {
        nextLevel: 2,
        knobOverrides: null, // L2 = freeze, handled by engine
        reason: `Pay/Rev 3mo avg ${(rollingPayRevAvg3Prev * 100).toFixed(1)}% > ${PAYREV_V1.l1ToL2Threshold * 100}% → L2 (freeze)`,
      };
    }

    // ── RELEASE (using counters already updated above — no +1 hack) ──
    if (currentLevel === 2) {
      if (state.monthsBelowL2Release >= PAYREV_V1.l2ReleaseMonths) {
        return {
          nextLevel: 1,
          knobOverrides: { ...PAYREV_V1.l1Overrides },
          reason: `Pay/Rev below ${PAYREV_V1.l2ToL1Threshold * 100}% for ${PAYREV_V1.l2ReleaseMonths} months → L1`,
        };
      }
      // Stay at L2
      return { nextLevel: 2, knobOverrides: null, reason: 'L2 hold' };
    }

    if (currentLevel === 1) {
      if (state.monthsBelowL1Release >= PAYREV_V1.l1ReleaseMonths) {
        return {
          nextLevel: 0,
          knobOverrides: null,
          reason: `Pay/Rev below ${PAYREV_V1.l1ToL0Threshold * 100}% for ${PAYREV_V1.l1ReleaseMonths} months → L0 (normal)`,
        };
      }
      // Stay at L1
      return { nextLevel: 1, knobOverrides: { ...PAYREV_V1.l1Overrides }, reason: 'L1 hold' };
    }

    // Level 0, no trigger
    return { nextLevel: 0, knobOverrides: null, reason: 'Normal' };
  },
};

// ============================================================================
// HELPERS
// ============================================================================

/** Create a fresh breaker state for a new iteration */
export function createBreakerState(): BreakerState {
  return {
    level: 0,
    monthsBelowL2Release: 0,
    monthsBelowL1Release: 0,
    events: [],
    levelByMonth: [],
    requestsSuppressedByBreaker: 0,
    dollarsSuppressedByBreaker: 0,
  };
}

/**
 * Compute 3-month rolling Pay/Rev average from COMPLETED months only.
 * For currentIndex = length of payRevHistory (i.e., before current month is pushed),
 * this returns the average of up to the last 3 entries.
 * 
 * NOTE: This is a REACTIVE signal — the policy sees only completed months,
 * never the month being simulated. This matches how a real operator would
 * observe and respond to trailing metrics.
 */
export function computeRollingPayRevAvg3Prev(
  payRevHistory: number[],
): number {
  const len = payRevHistory.length;
  if (len === 0) return 0;
  const start = Math.max(0, len - 3);
  const window = payRevHistory.slice(start, len);
  return window.reduce((a, b) => a + b, 0) / window.length;
}

/** Aggregate breaker diagnostics across all iterations */
export function aggregateBreakerDiagnostics(
  policy: BreakerPolicy,
  iterationStates: BreakerState[],
): BreakerDiagnostics {
  const iterations = iterationStates.length;
  if (iterations === 0) {
    return {
      policyName: policy.name,
      policyVersion: policy.version,
      timeInL0Pct: 1,
      timeInL1Pct: 0,
      timeInL2Pct: 0,
      avgTransitionsPerIteration: 0,
      totalRequestsSuppressed: 0,
      avgRequestsSuppressedPerIteration: 0,
      totalDollarsSuppressed: 0,
      avgDollarsSuppressedPerIteration: 0,
      maxConsecutiveL2Months: 0,
      iterationsWithAnyBreaker: 0,
      iterationsWithL2: 0,
    };
  }

  let totalMonths = 0;
  let totalL0 = 0;
  let totalL1 = 0;
  let totalL2 = 0;
  let totalTransitions = 0;
  let totalReqSuppressed = 0;
  let totalDolSuppressed = 0;
  let maxConsecL2 = 0;
  let itersWithBreaker = 0;
  let itersWithL2 = 0;

  for (const state of iterationStates) {
    const months = state.levelByMonth.length;
    totalMonths += months;

    let hadBreaker = false;
    let hadL2 = false;
    let consecL2 = 0;

    for (const level of state.levelByMonth) {
      if (level === 0) totalL0++;
      else if (level === 1) { totalL1++; hadBreaker = true; }
      else { totalL2++; hadBreaker = true; hadL2 = true; }

      if (level === 2) {
        consecL2++;
        maxConsecL2 = Math.max(maxConsecL2, consecL2);
      } else {
        consecL2 = 0;
      }
    }

    totalTransitions += state.events.length;
    totalReqSuppressed += state.requestsSuppressedByBreaker;
    totalDolSuppressed += state.dollarsSuppressedByBreaker;
    if (hadBreaker) itersWithBreaker++;
    if (hadL2) itersWithL2++;
  }

  return {
    policyName: policy.name,
    policyVersion: policy.version,
    timeInL0Pct: totalMonths > 0 ? totalL0 / totalMonths : 1,
    timeInL1Pct: totalMonths > 0 ? totalL1 / totalMonths : 0,
    timeInL2Pct: totalMonths > 0 ? totalL2 / totalMonths : 0,
    avgTransitionsPerIteration: totalTransitions / iterations,
    totalRequestsSuppressed: totalReqSuppressed,
    avgRequestsSuppressedPerIteration: totalReqSuppressed / iterations,
    totalDollarsSuppressed: totalDolSuppressed,
    avgDollarsSuppressedPerIteration: totalDolSuppressed / iterations,
    maxConsecutiveL2Months: maxConsecL2,
    iterationsWithAnyBreaker: itersWithBreaker,
    iterationsWithL2: itersWithL2,
  };
}
