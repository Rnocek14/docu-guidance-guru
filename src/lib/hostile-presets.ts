/**
 * Hostile Simulation Presets
 * 
 * Source of truth for adversarial economic scenarios.
 * Maps directly to docs/COLLAPSE_SIMULATION_SCENARIOS.md
 * 
 * Each preset includes:
 * - Simulation input overrides
 * - Expected breaker assertions (what MUST happen)
 * - Scenario metadata for audit trail
 */

import type { SimOverrides } from '@/components/admin/SimulationControls';

// ============================================================================
// ASSERTION TYPES
// ============================================================================

export type BreakerAssertionType =
  | 'PASS_RATE_BELOW'         // pass rate stays below threshold
  | 'ANNUAL_PROFIT_POSITIVE'  // annual mean profit > 0
  | 'ANNUAL_LOSS_PROB_BELOW'  // annual loss probability < threshold
  | 'RESERVE_BREACH_BELOW'    // reserve breach probability < threshold
  | 'WORST_MONTH_ABOVE'       // worst month > threshold
  | 'MONTHLY_PROFIT_POSITIVE' // monthly mean profit > 0
  | 'BREAKER_SHOULD_TRIP'     // breaker should trip at this pass rate (informational)
  | 'MARGIN_ABOVE'            // effective margin > threshold
  | 'MAX_PAYOUT_OUTFLOW_BELOW'    // p95 peak monthly payout outflow < threshold
  | 'MAX_PAYOUT_OUTFLOW_P99_BELOW' // p99 peak monthly payout outflow < threshold (advisory)
  | 'PAYOUT_REQUESTS_ABOVE'       // total payout requests > threshold (validates flow is exercised)
  | 'PAY_REV_P95_BELOW'           // payout-to-revenue ratio P95 < threshold (tail control)
  | 'DEFERRAL_RATE_BELOW';        // payout deferral rate < threshold (UX quality — too many deferrals = bad UX)

export interface BreakerAssertion {
  type: BreakerAssertionType;
  threshold?: number;
  description: string;
  /** If true, excluded from overall pass/fail — purely advisory */
  isInformational?: boolean;
}

export interface AssertionResult {
  assertion: BreakerAssertion;
  passed: boolean;
  observedValue: number | null;
  detail: string;
  /** Mirrors assertion.isInformational for easy filtering */
  isInformational: boolean;
}

// ============================================================================
// PRESET TYPE
// ============================================================================

export interface HostilePreset {
  presetId: string;
  name: string;
  description: string;
  scenarioVersion: string;
  severity: 'warning' | 'critical' | 'existential';
  inputs: SimOverrides;
  expectedAssertions: BreakerAssertion[];
}

// ============================================================================
// PRESETS (from docs/COLLAPSE_SIMULATION_SCENARIOS.md)
// ============================================================================

export const HOSTILE_PRESETS: HostilePreset[] = [
  {
    presetId: 'hostile-elevated-pass',
    name: 'Hostile: Elevated Pass Rate',
    description: 'Pass rate stabilizes at 18% instead of modeled 10-12%. Tests sustained high pass rate over 12 months.',
    scenarioVersion: 'v1.0',
    severity: 'warning',
    inputs: {
      accountsPerMonth: 100,
      fixedMonthlyCosts: 6000,
      entryFee: 149,
      resetFee: 99,
      horizon: 12,
      attackIntensity: 0.35,
      iterations: 2000,
      reserveThreshold: 15000,
    },
    expectedAssertions: [
      { type: 'ANNUAL_PROFIT_POSITIVE', description: 'Platform remains profitable at 18% pass rate' },
      { type: 'RESERVE_BREACH_BELOW', threshold: 0.15, description: 'Reserve breach probability < 15%' },
      { type: 'WORST_MONTH_ABOVE', threshold: -10000, description: 'No single month worse than -$10k' },
      { type: 'BREAKER_SHOULD_TRIP', threshold: 0.18, description: 'Breaker should fire at elevated level around 18% pass rate', isInformational: true },
    ],
  },
  {
    presetId: 'hostile-mass-correlation',
    name: 'Hostile: Mass Correlation Event',
    description: 'Market spike causes 30% of active accounts to pass in same period. Tests spike event over 3 months.',
    scenarioVersion: 'v1.0',
    severity: 'critical',
    inputs: {
      accountsPerMonth: 100,
      fixedMonthlyCosts: 6000,
      entryFee: 149,
      resetFee: 99,
      horizon: 3,
      attackIntensity: 0.7,
      iterations: 2000,
      reserveThreshold: 15000,
    },
    expectedAssertions: [
      { type: 'RESERVE_BREACH_BELOW', threshold: 0.30, description: 'Reserve breach < 30% (survivable with $15k reserve)' },
      { type: 'WORST_MONTH_ABOVE', threshold: -15000, description: 'Worst month > -$15k (payable from reserve)' },
      { type: 'BREAKER_SHOULD_TRIP', threshold: 0.30, description: 'Breaker fires to critical at 30% pass rate', isInformational: true },
    ],
  },
  {
    presetId: 'hostile-revenue-drought',
    name: 'Hostile: Revenue Drought',
    description: 'Marketing stops working, evaluations drop 80%. Existing passers still request payouts.',
    scenarioVersion: 'v1.0',
    severity: 'warning',
    inputs: {
      accountsPerMonth: 25,
      fixedMonthlyCosts: 6000,
      entryFee: 149,
      resetFee: 99,
      horizon: 6,
      attackIntensity: 0,
      iterations: 2000,
      reserveThreshold: 15000,
    },
    expectedAssertions: [
      { type: 'ANNUAL_PROFIT_POSITIVE', description: 'Still net-positive (or slow bleed, not sudden death)' },
      { type: 'RESERVE_BREACH_BELOW', threshold: 0.25, description: 'Reserve survives 6 months of drought' },
    ],
  },
  {
    presetId: 'hostile-scale-stress',
    name: 'Hostile: Solo-Operator Ceiling',
    description: 'Tests at 500 evals/month — solo-operator ceiling. Validates economics at scale.',
    scenarioVersion: 'v1.0',
    severity: 'warning',
    inputs: {
      accountsPerMonth: 500,
      fixedMonthlyCosts: 18000,
      entryFee: 149,
      resetFee: 99,
      horizon: 12,
      attackIntensity: 0,
      iterations: 2000,
      reserveThreshold: 15000,
    },
    expectedAssertions: [
      { type: 'ANNUAL_PROFIT_POSITIVE', description: 'Profitable at 500 evals/month' },
      { type: 'ANNUAL_LOSS_PROB_BELOW', threshold: 0.05, description: 'Annual loss probability < 5%' },
      { type: 'RESERVE_BREACH_BELOW', threshold: 0.05, description: 'Reserve breach < 5%' },
      { type: 'WORST_MONTH_ABOVE', threshold: -50000, description: 'No month worse than -$50k' },
    ],
  },
  {
    presetId: 'hostile-black-swan',
    name: 'Hostile: Black Swan (50% Pass)',
    description: 'Unprecedented market move — 50% of accounts pass in one period. Tests single catastrophic event + payout clustering.',
    scenarioVersion: 'v1.2',
    severity: 'existential',
    inputs: {
      accountsPerMonth: 100,
      fixedMonthlyCosts: 6000,
      entryFee: 149,
      resetFee: 99,
      horizon: 4,
      attackIntensity: 1.0,
      iterations: 2000,
      reserveThreshold: 15000,
    },
    expectedAssertions: [
      { type: 'WORST_MONTH_ABOVE', threshold: -30000, description: 'Single month loss < $30k (payable from reserve + revenue)' },
      { type: 'PAYOUT_REQUESTS_ABOVE', threshold: 1, description: 'Scenario must generate payout requests (validates payout flow is exercised)' },
      { type: 'MAX_PAYOUT_OUTFLOW_BELOW', threshold: 20000, description: 'P95 peak monthly payout outflow < $20k (reserve + revenue buffer)' },
      { type: 'MAX_PAYOUT_OUTFLOW_P99_BELOW', threshold: 35000, description: 'P99 peak monthly payout outflow < $35k (cohort shock buffer)', isInformational: true },
      { type: 'BREAKER_SHOULD_TRIP', threshold: 0.50, description: 'Breaker fires to emergency at 50% pass rate', isInformational: true },
    ],
  },
  {
    presetId: 'hostile-dispute-wave',
    name: 'Hostile: Dispute Rate Wave',
    description: 'Chargeback attack: 5% dispute rate spike with coordinated payout extraction.',
    scenarioVersion: 'v1.0',
    severity: 'critical',
    inputs: {
      accountsPerMonth: 100,
      fixedMonthlyCosts: 6000,
      entryFee: 149,
      resetFee: 99,
      horizon: 3,
      attackIntensity: 0.8,
      iterations: 2000,
      reserveThreshold: 15000,
    },
    expectedAssertions: [
      { type: 'RESERVE_BREACH_BELOW', threshold: 0.40, description: 'Reserve survives dispute wave' },
      { type: 'WORST_MONTH_ABOVE', threshold: -15000, description: 'Worst month payable from reserve' },
    ],
  },

  // ========================================================================
  // EXCITEMENT STRESS TESTS — quantify how much generosity the geometry affords
  // ========================================================================

  {
    presetId: 'excitement-85-split',
    name: 'Excitement: 85% Split Baseline',
    description: 'Tests raising Starter split from 80% → 85%. All other guards unchanged. 12-month horizon at Growth scale.',
    scenarioVersion: 'v1.1',
    severity: 'warning',
    inputs: {
      accountsPerMonth: 200,
      fixedMonthlyCosts: 12000,
      entryFee: 149,
      resetFee: 99,
      horizon: 12,
      attackIntensity: 0,
      iterations: 2000,
      reserveThreshold: 15000,
      payoutSplitPercent: 0.85,
    },
    expectedAssertions: [
      { type: 'ANNUAL_PROFIT_POSITIVE', description: 'Still profitable at 85% split' },
      { type: 'ANNUAL_LOSS_PROB_BELOW', threshold: 0.10, description: 'Annual loss probability < 10%' },
      { type: 'MARGIN_ABOVE', threshold: 0.15, description: 'Effective margin stays above 15%' },
      { type: 'RESERVE_BREACH_BELOW', threshold: 0.10, description: 'Reserve breach < 10%' },
      { type: 'PAY_REV_P95_BELOW', threshold: 0.45, description: 'Pay/Rev P95 < 45% (tail control)' },
    ],
  },
  {
    presetId: 'excitement-85-split-clustered',
    name: 'Excitement: 85% Split + Clustering',
    description: '85% split under correlated payout timing (1.4× frequency, 1.15× size). Tests split increase under worst-case payout bunching.',
    scenarioVersion: 'v1.1',
    severity: 'critical',
    inputs: {
      accountsPerMonth: 200,
      fixedMonthlyCosts: 12000,
      entryFee: 149,
      resetFee: 99,
      horizon: 12,
      attackIntensity: 0.5,
      iterations: 2000,
      reserveThreshold: 15000,
      payoutSplitPercent: 0.85,
    },
    expectedAssertions: [
      { type: 'ANNUAL_PROFIT_POSITIVE', description: 'Profitable at 85% split even with clustering' },
      { type: 'RESERVE_BREACH_BELOW', threshold: 0.20, description: 'Reserve breach < 20% under clustering' },
      { type: 'WORST_MONTH_ABOVE', threshold: -20000, description: 'Worst month > -$20k' },
      { type: 'MAX_PAYOUT_OUTFLOW_BELOW', threshold: 25000, description: 'P95 peak outflow < $25k' },
      { type: 'PAY_REV_P95_BELOW', threshold: 0.55, description: 'Pay/Rev P95 < 55% under clustering' },
    ],
  },
  {
    presetId: 'excitement-750-cap',
    name: 'Excitement: $750 First Payout Cap',
    description: 'Raises first payout cap from $500 → $750 (Elite-tier level). Tests early extraction increase at Growth scale.',
    scenarioVersion: 'v1.1',
    severity: 'warning',
    inputs: {
      accountsPerMonth: 200,
      fixedMonthlyCosts: 12000,
      entryFee: 149,
      resetFee: 99,
      horizon: 12,
      attackIntensity: 0,
      iterations: 2000,
      reserveThreshold: 15000,
      firstPayoutCap: 750,
    },
    expectedAssertions: [
      { type: 'ANNUAL_PROFIT_POSITIVE', description: 'Profitable with $750 first cap' },
      { type: 'ANNUAL_LOSS_PROB_BELOW', threshold: 0.08, description: 'Annual loss probability < 8%' },
      { type: 'MARGIN_ABOVE', threshold: 0.20, description: 'Margin stays above 20%' },
      { type: 'RESERVE_BREACH_BELOW', threshold: 0.08, description: 'Reserve breach < 8%' },
      { type: 'PAY_REV_P95_BELOW', threshold: 0.45, description: 'Pay/Rev P95 < 45%' },
    ],
  },
  {
    presetId: 'excitement-1000-cap',
    name: 'Excitement: $1,000 First Payout Cap',
    description: 'Raises first payout cap from $500 → $1,000. Tests aggressive early extraction. Requires guard rail change. Analysis only — not a launch candidate.',
    scenarioVersion: 'v1.1',
    severity: 'critical',
    inputs: {
      accountsPerMonth: 200,
      fixedMonthlyCosts: 12000,
      entryFee: 149,
      resetFee: 99,
      horizon: 12,
      attackIntensity: 0,
      iterations: 2000,
      reserveThreshold: 15000,
      firstPayoutCap: 1000,
    },
    expectedAssertions: [
      { type: 'ANNUAL_PROFIT_POSITIVE', description: 'Profitable with $1k first cap' },
      { type: 'ANNUAL_LOSS_PROB_BELOW', threshold: 0.12, description: 'Annual loss probability < 12%' },
      { type: 'MARGIN_ABOVE', threshold: 0.15, description: 'Margin stays above 15%' },
      { type: 'RESERVE_BREACH_BELOW', threshold: 0.12, description: 'Reserve breach < 12%' },
      { type: 'PAY_REV_P95_BELOW', threshold: 0.50, description: 'Pay/Rev P95 < 50%' },
    ],
  },
  {
    presetId: 'excitement-fast-cooldown',
    name: 'Excitement: Accelerated Cooldown',
    description: 'Reduces payout cooldown from ~1 month → 0 (sub-monthly payouts allowed). Static gate relaxation — does NOT model conditional "$3k profit" trigger.',
    scenarioVersion: 'v1.1',
    severity: 'warning',
    inputs: {
      accountsPerMonth: 200,
      fixedMonthlyCosts: 12000,
      entryFee: 149,
      resetFee: 99,
      horizon: 12,
      attackIntensity: 0,
      iterations: 2000,
      reserveThreshold: 15000,
      minMonthsBetweenPayouts: 0,
    },
    expectedAssertions: [
      { type: 'ANNUAL_PROFIT_POSITIVE', description: 'Profitable with faster cooldown' },
      { type: 'ANNUAL_LOSS_PROB_BELOW', threshold: 0.08, description: 'Annual loss probability < 8%' },
      { type: 'MAX_PAYOUT_OUTFLOW_BELOW', threshold: 20000, description: 'P95 peak outflow < $20k (velocity stable)' },
      { type: 'RESERVE_BREACH_BELOW', threshold: 0.10, description: 'Reserve breach < 10%' },
      { type: 'PAY_REV_P95_BELOW', threshold: 0.45, description: 'Pay/Rev P95 < 45%' },
    ],
  },
  {
    presetId: 'excitement-full-stack',
    name: 'Excitement: Full Stack (All Levers)',
    description: '85% split + $750 cap + 0-month cooldown + clustering. The "max excitement" stress test — all levers pulled simultaneously.',
    scenarioVersion: 'v1.1',
    severity: 'existential',
    inputs: {
      accountsPerMonth: 200,
      fixedMonthlyCosts: 12000,
      entryFee: 149,
      resetFee: 99,
      horizon: 12,
      attackIntensity: 0.5,
      iterations: 2000,
      reserveThreshold: 15000,
      payoutSplitPercent: 0.85,
      firstPayoutCap: 750,
      minMonthsBetweenPayouts: 0,
    },
    expectedAssertions: [
      { type: 'ANNUAL_PROFIT_POSITIVE', description: 'Still profitable with ALL excitement levers + clustering' },
      { type: 'ANNUAL_LOSS_PROB_BELOW', threshold: 0.20, description: 'Annual loss probability < 20%' },
      { type: 'RESERVE_BREACH_BELOW', threshold: 0.25, description: 'Reserve breach < 25%' },
      { type: 'WORST_MONTH_ABOVE', threshold: -25000, description: 'Worst month > -$25k' },
      { type: 'MAX_PAYOUT_OUTFLOW_BELOW', threshold: 30000, description: 'P95 peak outflow < $30k' },
      { type: 'PAY_REV_P95_BELOW', threshold: 0.60, description: 'Pay/Rev P95 < 60% (full-stack stress ceiling)' },
    ],
  },


  // ========================================================================
  // PAYOUT BUDGETING (TAIL SMOOTHER) — tests soft pacing at various targets
  // ========================================================================

  {
    presetId: 'pacing-baseline-040',
    name: 'Pacing: Baseline + 40% Budget',
    description: 'Baseline economics with soft monthly payout budget at 40% of revenue. Tests whether tail smoother brings Pay/Rev P95 under 45% without wrecking UX.',
    scenarioVersion: 'v1.2',
    severity: 'warning',
    inputs: {
      accountsPerMonth: 200,
      fixedMonthlyCosts: 12000,
      entryFee: 149,
      resetFee: 99,
      horizon: 15,
      attackIntensity: 0,
      iterations: 2000,
      reserveThreshold: 15000,
      targetPayRevSoft: 0.40,
    },
    expectedAssertions: [
      { type: 'ANNUAL_PROFIT_POSITIVE', description: 'Profitable with payout pacing' },
      { type: 'PAY_REV_P95_BELOW', threshold: 0.45, description: 'Pay/Rev P95 < 45% (tail controlled by budget)' },
      { type: 'DEFERRAL_RATE_BELOW', threshold: 0.20, description: 'Deferral rate < 20% (UX quality — most payouts still go through)' },
      { type: 'MARGIN_ABOVE', threshold: 0.20, description: 'Margin stays above 20%' },
      { type: 'RESERVE_BREACH_BELOW', threshold: 0.05, description: 'Reserve breach < 5%' },
    ],
  },
  {
    presetId: 'pacing-baseline-035',
    name: 'Pacing: Baseline + 35% Budget',
    description: 'Tighter payout budget at 35% of revenue. Tests aggressive tail control — may increase deferral rate.',
    scenarioVersion: 'v1.2',
    severity: 'warning',
    inputs: {
      accountsPerMonth: 200,
      fixedMonthlyCosts: 12000,
      entryFee: 149,
      resetFee: 99,
      horizon: 15,
      attackIntensity: 0,
      iterations: 2000,
      reserveThreshold: 15000,
      targetPayRevSoft: 0.35,
    },
    expectedAssertions: [
      { type: 'ANNUAL_PROFIT_POSITIVE', description: 'Profitable with tighter pacing' },
      { type: 'PAY_REV_P95_BELOW', threshold: 0.40, description: 'Pay/Rev P95 < 40% (aggressive clamp)' },
      { type: 'DEFERRAL_RATE_BELOW', threshold: 0.30, description: 'Deferral rate < 30% (UX ceiling — too much deferral = bad experience)' },
      { type: 'MARGIN_ABOVE', threshold: 0.22, description: 'Margin stays above 22%' },
    ],
  },
  {
    presetId: 'pacing-clustered-040',
    name: 'Pacing: Clustering + 40% Budget',
    description: 'Payout budgeting under correlated payout timing (clustering attack). Tests whether soft pacing absorbs payout spikes.',
    scenarioVersion: 'v1.2',
    severity: 'critical',
    inputs: {
      accountsPerMonth: 200,
      fixedMonthlyCosts: 12000,
      entryFee: 149,
      resetFee: 99,
      horizon: 15,
      attackIntensity: 0.5,
      iterations: 2000,
      reserveThreshold: 15000,
      targetPayRevSoft: 0.40,
    },
    expectedAssertions: [
      { type: 'ANNUAL_PROFIT_POSITIVE', description: 'Profitable with pacing + clustering' },
      { type: 'PAY_REV_P95_BELOW', threshold: 0.50, description: 'Pay/Rev P95 < 50% under clustering' },
      { type: 'DEFERRAL_RATE_BELOW', threshold: 0.35, description: 'Deferral rate < 35% under clustering' },
      { type: 'RESERVE_BREACH_BELOW', threshold: 0.15, description: 'Reserve breach < 15% under clustering' },
      { type: 'WORST_MONTH_ABOVE', threshold: -15000, description: 'Worst month > -$15k' },
    ],
  },
  {
    presetId: 'pacing-excitement-040',
    name: 'Pacing: 85% Split + $750 Cap + 40% Budget',
    description: 'Full excitement stack WITH payout budgeting. Tests whether soft pacing makes excitement levers launch-safe.',
    scenarioVersion: 'v1.2',
    severity: 'critical',
    inputs: {
      accountsPerMonth: 200,
      fixedMonthlyCosts: 12000,
      entryFee: 149,
      resetFee: 99,
      horizon: 15,
      attackIntensity: 0,
      iterations: 2000,
      reserveThreshold: 15000,
      payoutSplitPercent: 0.85,
      firstPayoutCap: 750,
      targetPayRevSoft: 0.40,
    },
    expectedAssertions: [
      { type: 'ANNUAL_PROFIT_POSITIVE', description: 'Profitable with excitement + pacing' },
      { type: 'PAY_REV_P95_BELOW', threshold: 0.45, description: 'Pay/Rev P95 < 45% (excitement controlled by budget)' },
      { type: 'DEFERRAL_RATE_BELOW', threshold: 0.25, description: 'Deferral rate < 25%' },
      { type: 'MARGIN_ABOVE', threshold: 0.15, description: 'Margin stays above 15%' },
      { type: 'RESERVE_BREACH_BELOW', threshold: 0.10, description: 'Reserve breach < 10%' },
    ],
  },
];

// ============================================================================
// REQUIRED METRIC PATHS — assertion won't silently pass on missing data
// ============================================================================

const METRIC_EXTRACTORS: Record<string, (r: SimResultForAssertions) => number | undefined> = {
  ANNUAL_PROFIT_POSITIVE: (r) => r.annual?.mean,
  ANNUAL_LOSS_PROB_BELOW: (r) => r.annual?.lossProb,
  RESERVE_BREACH_BELOW: (r) => r.reserve?.breachProbability,
  WORST_MONTH_ABOVE: (r) => r.risk?.worstMonth,
  MONTHLY_PROFIT_POSITIVE: (r) => r.profit?.mean,
  MARGIN_ABOVE: (r) => r.diagnostics?.effectiveMargin,
  MAX_PAYOUT_OUTFLOW_BELOW: (r) => r.risk?.maxPayoutOutflowMonth?.p95,
  MAX_PAYOUT_OUTFLOW_P99_BELOW: (r) => r.risk?.maxPayoutOutflowMonth?.p99,
  PAYOUT_REQUESTS_ABOVE: (r) => r.diagnostics?.totalPayoutRequests,
  PAY_REV_P95_BELOW: (r) => {
    // Use TRUE P95 from per-month distribution (not aggregate mean ratio)
    const trueP95 = r.diagnostics?.payoutToRevenueP95;
    if (trueP95 != null && typeof trueP95 === 'number') return trueP95;
    // Fallback: aggregate mean ratio (labeled as such in detail string)
    const rev = r.revenueBreakdown?.total;
    const payouts = r.costBreakdown?.payouts;
    if (rev != null && rev > 0 && payouts != null) return payouts / rev;
    return undefined;
  },
  DEFERRAL_RATE_BELOW: (r) => r.diagnostics?.deferralRate,
};

// ============================================================================
// ASSERTION EVALUATOR
// ============================================================================

interface SimResultForAssertions {
  annual: { mean: number; lossProb: number };
  profit: { mean: number };
  risk: { worstMonth: number; maxPayoutOutflowMonth?: { p95: number; p99: number; max: number } };
  reserve: { breachProbability: number };
  diagnostics: Record<string, any> | null;
  revenueBreakdown?: { entry: number; resets: number; total: number };
  costBreakdown?: { payouts: number; fraud: number; chargebacks: number; variable: number; fixed: number; total: number };
}

export function evaluateAssertions(
  preset: HostilePreset,
  results: SimResultForAssertions,
): AssertionResult[] {
  return preset.expectedAssertions.map((assertion) => {
    const informational = assertion.isInformational === true;

    // Informational assertions (BREAKER_SHOULD_TRIP, PASS_RATE_BELOW) — always advisory
    if (assertion.type === 'BREAKER_SHOULD_TRIP' || assertion.type === 'PASS_RATE_BELOW') {
      return {
        assertion,
        passed: true, // doesn't count toward overall
        observedValue: assertion.threshold ?? null,
        detail: `Advisory: ${assertion.description}`,
        isInformational: true,
      };
    }

    // Guard: verify metric exists in results — missing = FAIL
    const extractor = METRIC_EXTRACTORS[assertion.type];
    if (!extractor) {
      return {
        assertion,
        passed: false,
        observedValue: null,
        detail: `Unknown assertion type: ${assertion.type}`,
        isInformational: informational,
      };
    }

    const value = extractor(results);
    if (value === undefined || value === null || Number.isNaN(value)) {
      return {
        assertion,
        passed: false,
        observedValue: null,
        detail: `MISSING METRIC in sim output — cannot evaluate "${assertion.type}"`,
        isInformational: informational,
      };
    }

    // Evaluate the actual assertion
    let passed = false;
    let detail = '';

    switch (assertion.type) {
      case 'ANNUAL_PROFIT_POSITIVE':
        passed = value > 0;
        detail = `Annual mean profit: $${Math.round(value).toLocaleString()}`;
        break;
      case 'ANNUAL_LOSS_PROB_BELOW':
        passed = value < (assertion.threshold ?? 0.1);
        detail = `Annual loss prob: ${(value * 100).toFixed(1)}% (threshold: ${((assertion.threshold ?? 0.1) * 100).toFixed(1)}%)`;
        break;
      case 'RESERVE_BREACH_BELOW':
        passed = value < (assertion.threshold ?? 0.1);
        detail = `Reserve breach: ${(value * 100).toFixed(1)}% (threshold: ${((assertion.threshold ?? 0.1) * 100).toFixed(1)}%)`;
        break;
      case 'WORST_MONTH_ABOVE':
        passed = value > (assertion.threshold ?? -50000);
        detail = `Worst month: $${Math.round(value).toLocaleString()} (threshold: $${Math.round(assertion.threshold ?? -50000).toLocaleString()})`;
        break;
      case 'MONTHLY_PROFIT_POSITIVE':
        passed = value > 0;
        detail = `Monthly mean profit: $${Math.round(value).toLocaleString()}`;
        break;
      case 'MARGIN_ABOVE':
        passed = value > (assertion.threshold ?? 0);
        detail = `Effective margin: ${(value * 100).toFixed(1)}% (threshold: ${((assertion.threshold ?? 0) * 100).toFixed(1)}%)`;
        break;
      case 'MAX_PAYOUT_OUTFLOW_BELOW':
        passed = value < (assertion.threshold ?? 20000);
        detail = `P95 of per-iteration peak monthly payout outflow (nearest-rank): $${Math.round(value).toLocaleString()} (threshold: $${Math.round(assertion.threshold ?? 20000).toLocaleString()})`;
        break;
      case 'MAX_PAYOUT_OUTFLOW_P99_BELOW':
        passed = value < (assertion.threshold ?? 35000);
        detail = `P99 of per-iteration peak monthly payout outflow (nearest-rank): $${Math.round(value).toLocaleString()} (threshold: $${Math.round(assertion.threshold ?? 35000).toLocaleString()})`;
        break;
      case 'PAYOUT_REQUESTS_ABOVE':
        passed = value > (assertion.threshold ?? 1);
        detail = `Total payout requests: ${Math.round(value).toLocaleString()} (minimum required: ${Math.round(assertion.threshold ?? 1).toLocaleString()})`;
        break;
      case 'PAY_REV_P95_BELOW': {
        passed = value < (assertion.threshold ?? 0.45);
        const source = results.diagnostics?.payoutToRevenueP95 != null ? 'true P95 (per-month distribution)' : 'FALLBACK: aggregate mean ratio';
        detail = `Pay/Rev [${source}]: ${(value * 100).toFixed(1)}% (threshold: ${((assertion.threshold ?? 0.45) * 100).toFixed(1)}%)`;
        break;
      }
      case 'DEFERRAL_RATE_BELOW':
        passed = value < (assertion.threshold ?? 0.20);
        detail = `Deferral rate: ${(value * 100).toFixed(1)}% (threshold: ${((assertion.threshold ?? 0.20) * 100).toFixed(1)}%) — ${results.diagnostics?.totalDeferredRequests?.toLocaleString() ?? '?'} deferred, ~$${Math.round(results.diagnostics?.deferredDollarsPerIteration ?? 0).toLocaleString()}/iter`;
        break;
    }

    return { assertion, passed, observedValue: value, detail, isInformational: informational };
  });
}

/**
 * Compute overall pass/fail excluding informational assertions.
 * Returns 'incomplete' if no binding assertions exist.
 */
export type OverallVerdict = 'pass' | 'fail' | 'incomplete';

export function computeOverallVerdict(
  assertionResults: AssertionResult[] | null,
  breakerValidation: { overallPass: boolean } | null,
): OverallVerdict {
  const bindingAssertions = assertionResults?.filter(r => !r.isInformational) ?? [];

  // If we have a preset active but no binding assertions or no breaker validation → incomplete
  if (bindingAssertions.length === 0 && !breakerValidation) return 'incomplete';
  if (assertionResults && assertionResults.length > 0 && !breakerValidation) return 'incomplete';
  if (breakerValidation && (!assertionResults || assertionResults.length === 0)) return 'incomplete';

  const assertionsPassed = bindingAssertions.every(r => r.passed);
  const breakerPassed = breakerValidation?.overallPass ?? true;

  return (assertionsPassed && breakerPassed) ? 'pass' : 'fail';
}
