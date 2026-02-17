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
  | 'PAYOUT_REQUESTS_ABOVE';       // total payout requests > threshold (validates flow is exercised)

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
