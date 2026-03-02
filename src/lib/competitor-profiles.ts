/**
 * Competitor Profiles for Structural Risk Map Overlay
 *
 * Each profile reverse-engineers a competitor's public terms into
 * MonteCarloAssumptions the engine can simulate.
 *
 * Three key mechanics are modeled per-firm:
 *   1. Effective entry price (after discounts / refund adjustments)
 *   2. First-N payout cap as a structural throttle
 *   3. Clustering intensity multiplier (firm-specific behavioral risk)
 *
 * Revenue adjustment for refund models (FTMO):
 *   effectivePrice = entryFee × (1 − passRate)
 *   because passers get refunded — only non-passers generate net revenue.
 */

import {
  DEFAULT_ASSUMPTIONS,
  type MonteCarloAssumptions,
} from './monte-carlo';

// ============================================================================
// TYPES
// ============================================================================

export interface CompetitorScenario {
  label: string;              // e.g., "Apex Conservative"
  firmId: 'apex' | 'ftmo';
  firmLabel: string;
  variant: string;            // "conservative" | "base" | "aggressive"
  color: string;              // tailwind token for grid marker
  /** Pass rate MODE for grid axis (the single point plotted) */
  passRate: number;
  /** Payout request rate MODE for grid axis */
  requestRate: number;
  /** Full assumptions for standalone sim (used for summary stats) */
  assumptions: MonteCarloAssumptions;
  /** Clustering intensity multiplier: 1.0 = full, 0.8 = reduced */
  clusteringIntensity: number;
  notes: string;
}

// ============================================================================
// HELPERS
// ============================================================================

function clone(base: MonteCarloAssumptions): MonteCarloAssumptions {
  return JSON.parse(JSON.stringify(base));
}

function buildProfile(overrides: {
  price: number;
  passMode: number;
  requestMode: number;
  payoutSplit: number;
  firstPayoutCap: number | null;
  lifetimeCapMultiple: number | null;
  minMonthsBetweenPayouts: number;
  minWinningDaysPerPayout: number;
  /** If true, price is adjusted for refund model: price × (1 − passMode) */
  refundModel?: boolean;
}): MonteCarloAssumptions {
  const a = clone(DEFAULT_ASSUMPTIONS);

  // Revenue: refund model means only non-passers pay
  const effectivePrice = overrides.refundModel
    ? overrides.price * (1 - overrides.passMode)
    : overrides.price;

  a.pricePerAccount = effectivePrice;
  a.passRate = {
    min: Math.max(0.02, overrides.passMode - 0.02),
    mode: overrides.passMode,
    max: overrides.passMode + 0.03,
  };
  a.payoutRequestRate = {
    min: Math.max(0.05, overrides.requestMode - 0.05),
    mode: overrides.requestMode,
    max: Math.min(0.95, overrides.requestMode + 0.10),
  };

  a.knobs = {
    ...a.knobs,
    payoutSplitPercent: overrides.payoutSplit,
    firstPayoutCap: overrides.firstPayoutCap,
    lifetimeCapPerUser: overrides.lifetimeCapMultiple != null
      ? overrides.price * overrides.lifetimeCapMultiple
      : null,
    minMonthsBetweenPayouts: overrides.minMonthsBetweenPayouts,
    minWinningDaysPerPayout: overrides.minWinningDaysPerPayout,
  };

  return a;
}

// ============================================================================
// APEX SCENARIOS — $35-$50 effective, 100% split, $2k cap × first 5
// ============================================================================

const APEX_BASE_KNOBS = {
  payoutSplit: 1.00,              // 100% to trader (after 5th payout)
  firstPayoutCap: 2000,           // $2,000 cap first 5 payouts (structural throttle)
  lifetimeCapMultiple: null,       // no explicit lifetime cap
  minMonthsBetweenPayouts: 0,      // 8-day cycles ≈ sub-monthly
  minWinningDaysPerPayout: 3,      // 30% consistency rule ≈ ~3 winning days
};

export const APEX_CONSERVATIVE: CompetitorScenario = {
  label: 'Apex Conservative',
  firmId: 'apex',
  firmLabel: 'Apex',
  variant: 'conservative',
  color: 'text-orange-500',
  passRate: 0.06,
  requestRate: 0.25,
  clusteringIntensity: 1.0,
  notes: '$50 effective price, 6% pass, 25% request. Max throttling.',
  assumptions: buildProfile({
    price: 50,
    passMode: 0.06,
    requestMode: 0.25,
    ...APEX_BASE_KNOBS,
  }),
};

export const APEX_BASE: CompetitorScenario = {
  label: 'Apex Base',
  firmId: 'apex',
  firmLabel: 'Apex',
  variant: 'base',
  color: 'text-orange-400',
  passRate: 0.07,
  requestRate: 0.30,
  clusteringIntensity: 1.0,
  notes: '$40 effective price, 7% pass, 30% request. Realistic mid-case.',
  assumptions: buildProfile({
    price: 40,
    passMode: 0.07,
    requestMode: 0.30,
    ...APEX_BASE_KNOBS,
  }),
};

export const APEX_AGGRESSIVE: CompetitorScenario = {
  label: 'Apex Aggressive',
  firmId: 'apex',
  firmLabel: 'Apex',
  variant: 'aggressive',
  color: 'text-orange-600',
  passRate: 0.09,
  requestRate: 0.35,
  clusteringIntensity: 1.0,
  notes: '$35 effective price, 9% pass, 35% request. Stress case.',
  assumptions: buildProfile({
    price: 35,
    passMode: 0.09,
    requestMode: 0.35,
    ...APEX_BASE_KNOBS,
  }),
};

// ============================================================================
// FTMO SCENARIOS — €345 refundable, 80% split, 14-day cycles, institutional
// ============================================================================

const FTMO_BASE_KNOBS = {
  payoutSplit: 0.80,               // 80% to trader (90% on scaling)
  firstPayoutCap: null as number | null,  // no first payout cap
  lifetimeCapMultiple: null,        // no explicit lifetime cap
  minMonthsBetweenPayouts: 1,       // ~14-day cycle ≈ 1 month minimum
  minWinningDaysPerPayout: 10,      // strict consistency rule
  refundModel: true,                // refund on first payout → revenue = price × (1 − passRate)
};

export const FTMO_CONSERVATIVE: CompetitorScenario = {
  label: 'FTMO Conservative',
  firmId: 'ftmo',
  firmLabel: 'FTMO',
  variant: 'conservative',
  color: 'text-blue-500',
  passRate: 0.05,
  requestRate: 0.15,
  clusteringIntensity: 0.8,
  notes: '€345 (refund model), 5% pass, 15% request. Institutional discipline.',
  assumptions: buildProfile({
    price: 345,
    passMode: 0.05,
    requestMode: 0.15,
    ...FTMO_BASE_KNOBS,
  }),
};

export const FTMO_BASE: CompetitorScenario = {
  label: 'FTMO Base',
  firmId: 'ftmo',
  firmLabel: 'FTMO',
  variant: 'base',
  color: 'text-blue-400',
  passRate: 0.06,
  requestRate: 0.20,
  clusteringIntensity: 0.8,
  notes: '€345 (refund model), 6% pass, 20% request. Realistic mid-case.',
  assumptions: buildProfile({
    price: 345,
    passMode: 0.06,
    requestMode: 0.20,
    ...FTMO_BASE_KNOBS,
  }),
};

export const FTMO_AGGRESSIVE: CompetitorScenario = {
  label: 'FTMO Aggressive',
  firmId: 'ftmo',
  firmLabel: 'FTMO',
  variant: 'aggressive',
  color: 'text-blue-600',
  passRate: 0.07,
  requestRate: 0.25,
  clusteringIntensity: 0.8,
  notes: '€345 (refund model), 7% pass, 25% request. Upper-bound stress.',
  assumptions: buildProfile({
    price: 345,
    passMode: 0.07,
    requestMode: 0.25,
    ...FTMO_BASE_KNOBS,
  }),
};

// ============================================================================
// COLLECTIONS
// ============================================================================

export const APEX_SCENARIOS: CompetitorScenario[] = [
  APEX_CONSERVATIVE,
  APEX_BASE,
  APEX_AGGRESSIVE,
];

export const FTMO_SCENARIOS: CompetitorScenario[] = [
  FTMO_CONSERVATIVE,
  FTMO_BASE,
  FTMO_AGGRESSIVE,
];

export const ALL_COMPETITOR_SCENARIOS: CompetitorScenario[] = [
  ...APEX_SCENARIOS,
  ...FTMO_SCENARIOS,
];
