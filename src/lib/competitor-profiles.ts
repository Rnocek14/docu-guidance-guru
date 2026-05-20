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
  firmId: 'apex' | 'ftmo' | 'mffu' | 'tradeify' | 'tpt' | 'fundednext';
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
  /**
   * Profile kind:
   *  - 'simulated': verified profile safe to feed treasury / Monte Carlo math
   *  - 'market_reference': landing-page intelligence only. DO NOT use to drive
   *    treasury decisions until promoted to 'simulated' after verification.
   */
  kind?: 'simulated' | 'market_reference';
  /** Source URL the profile was reverse-engineered from. */
  sourceUrl?: string;
  /** ISO timestamp the source was last checked. */
  lastCheckedAt?: string;
  /** Confidence in the rules captured. */
  confidence?: 'low' | 'medium' | 'high';
  /** Advertised list price (sticker, no promo). */
  listPrice?: number;
  /** Typical promo / discounted price observed in the market. */
  promoPrice?: number;
  /** Rules as advertised on the landing page. Free-form. */
  advertisedRules?: string;
  /** Rules verified from actual funded-trader experience. Free-form. */
  verifiedFundedRules?: string;
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
  firstPayoutCapCount?: number;
  lifetimeCapMultiple: number | null;
  minMonthsBetweenPayouts: number;
  minWinningDaysPerPayout: number;
  /** If true, price is adjusted for refund model: price × (1 − passMode) */
  refundModel?: boolean;
  /** Override payout size distribution (log-normal params) */
  avgPayoutAmount?: { mean: number; stdDev: number };
  /** Override payout cadence (triangular) */
  payoutsPerPaidAccountPerMonth?: { min: number; mode: number; max: number };
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

  // Payout sizing & cadence — firm-specific overrides
  if (overrides.avgPayoutAmount) {
    a.avgPayoutAmount = overrides.avgPayoutAmount;
  }
  if (overrides.payoutsPerPaidAccountPerMonth) {
    a.payoutsPerPaidAccountPerMonth = overrides.payoutsPerPaidAccountPerMonth;
  }

  a.knobs = {
    ...a.knobs,
    payoutSplitPercent: overrides.payoutSplit,
    firstPayoutCap: overrides.firstPayoutCap,
    firstPayoutCapCount: overrides.firstPayoutCapCount ?? 1,
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
  firstPayoutCapCount: 5,         // cap applies to first 5 payouts, not just first 1
  lifetimeCapMultiple: null,       // no explicit lifetime cap
  minMonthsBetweenPayouts: 0,      // 8-day cycles ≈ sub-monthly
  minWinningDaysPerPayout: 3,      // 30% consistency rule ≈ ~3 winning days
  // Apex traders on 50k accounts withdraw $3k–$5k typically; 8-day cycles ≈ 2.5 payouts/month
  avgPayoutAmount: { mean: 4000, stdDev: 2000 },
  payoutsPerPaidAccountPerMonth: { min: 1.5, mode: 2.5, max: 3.5 },
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
  // FTMO 100k accounts; institutional-size withdrawals, ~1 payout/month
  avgPayoutAmount: { mean: 5000, stdDev: 3000 },
  payoutsPerPaidAccountPerMonth: { min: 0.5, mode: 1.0, max: 1.5 },
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

// Lower pass-rate scenarios — finding the true survival boundary
export const APEX_SURVIVAL_3PCT: CompetitorScenario = {
  label: 'Apex 3% Pass',
  firmId: 'apex',
  firmLabel: 'Apex',
  variant: '3% pass',
  color: 'text-orange-300',
  passRate: 0.03,
  requestRate: 0.25,
  clusteringIntensity: 1.0,
  notes: '$50 effective, 3% pass, 25% request. Deep filtration test.',
  assumptions: buildProfile({
    price: 50,
    passMode: 0.03,
    requestMode: 0.25,
    ...APEX_BASE_KNOBS,
  }),
};

export const APEX_SURVIVAL_4PCT: CompetitorScenario = {
  label: 'Apex 4% Pass',
  firmId: 'apex',
  firmLabel: 'Apex',
  variant: '4% pass',
  color: 'text-orange-300',
  passRate: 0.04,
  requestRate: 0.25,
  clusteringIntensity: 1.0,
  notes: '$50 effective, 4% pass, 25% request. Mid filtration test.',
  assumptions: buildProfile({
    price: 50,
    passMode: 0.04,
    requestMode: 0.25,
    ...APEX_BASE_KNOBS,
  }),
};

export const APEX_SURVIVAL_5PCT: CompetitorScenario = {
  label: 'Apex 5% Pass',
  firmId: 'apex',
  firmLabel: 'Apex',
  variant: '5% pass',
  color: 'text-orange-300',
  passRate: 0.05,
  requestRate: 0.25,
  clusteringIntensity: 1.0,
  notes: '$50 effective, 5% pass, 25% request. Upper filtration boundary.',
  assumptions: buildProfile({
    price: 50,
    passMode: 0.05,
    requestMode: 0.25,
    ...APEX_BASE_KNOBS,
  }),
};

export const APEX_SCENARIOS: CompetitorScenario[] = [
  APEX_SURVIVAL_3PCT,
  APEX_SURVIVAL_4PCT,
  APEX_SURVIVAL_5PCT,
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

// ============================================================================
// MARKET REFERENCE PROFILES — landing-page intelligence, NOT treasury inputs
// ----------------------------------------------------------------------------
// These profiles capture what competitors advertise so the StructuralRiskMap
// can plot them honestly. They are intentionally EXCLUDED from
// ALL_COMPETITOR_SCENARIOS so they cannot accidentally drive Monte Carlo
// economics or treasury sizing. Promote to a real simulated scenario only
// after the rules are verified end-to-end (eval → funded → payout).
//
// Every entry MUST include: sourceUrl, lastCheckedAt, confidence, and keep
// listPrice separate from promoPrice. Advertised rules are NOT verified.
// ============================================================================

const REF_CHECKED_AT = '2026-05-20';

export const MFFU_REFERENCE: CompetitorScenario = {
  label: 'MyFundedFutures (ref)',
  firmId: 'mffu',
  firmLabel: 'MFFU',
  variant: 'market_reference',
  color: 'text-purple-400',
  passRate: 0.08,
  requestRate: 0.30,
  clusteringIntensity: 1.0,
  notes: 'Landing-page reference only. Advertised 90% split, $7.5k × 3 first-payout cap.',
  kind: 'market_reference',
  sourceUrl: 'https://myfundedfutures.com',
  lastCheckedAt: REF_CHECKED_AT,
  confidence: 'medium',
  listPrice: 165,
  promoPrice: 80,
  advertisedRules: '1-step $3k target, $2k EOD trailing, 90% split, $7.5k first-payout cap × 3.',
  verifiedFundedRules: undefined,
  assumptions: buildProfile({
    price: 165,
    passMode: 0.08,
    requestMode: 0.30,
    payoutSplit: 0.90,
    firstPayoutCap: 7500,
    firstPayoutCapCount: 3,
    lifetimeCapMultiple: null,
    minMonthsBetweenPayouts: 0,
    minWinningDaysPerPayout: 5,
  }),
};

export const TRADEIFY_REFERENCE: CompetitorScenario = {
  label: 'Tradeify (ref)',
  firmId: 'tradeify',
  firmLabel: 'Tradeify',
  variant: 'market_reference',
  color: 'text-emerald-400',
  passRate: 0.07,
  requestRate: 0.28,
  clusteringIntensity: 1.0,
  notes: 'Landing-page reference only. Advertised "uncapped" payouts after threshold.',
  kind: 'market_reference',
  sourceUrl: 'https://tradeify.co',
  lastCheckedAt: REF_CHECKED_AT,
  confidence: 'low',
  listPrice: 137,
  promoPrice: 55,
  advertisedRules: '1-step eval, 90% split, no daily cap advertised, fast payouts.',
  verifiedFundedRules: undefined,
  assumptions: buildProfile({
    price: 137,
    passMode: 0.07,
    requestMode: 0.28,
    payoutSplit: 0.90,
    firstPayoutCap: 2000,
    firstPayoutCapCount: 1,
    lifetimeCapMultiple: null,
    minMonthsBetweenPayouts: 0,
    minWinningDaysPerPayout: 5,
  }),
};

export const TPT_REFERENCE: CompetitorScenario = {
  label: 'TakeProfit Trader (ref)',
  firmId: 'tpt',
  firmLabel: 'TPT',
  variant: 'market_reference',
  color: 'text-cyan-400',
  passRate: 0.08,
  requestRate: 0.30,
  clusteringIntensity: 1.0,
  notes: 'Landing-page reference only. Advertised 80→90% split, $1.5k × 1 first-payout cap.',
  kind: 'market_reference',
  sourceUrl: 'https://takeprofittrader.com',
  lastCheckedAt: REF_CHECKED_AT,
  confidence: 'medium',
  listPrice: 150,
  promoPrice: 75,
  advertisedRules: '1-step, 80% split until $10k profit then 90%, $1.5k first-payout cap × 1.',
  verifiedFundedRules: undefined,
  assumptions: buildProfile({
    price: 150,
    passMode: 0.08,
    requestMode: 0.30,
    payoutSplit: 0.80,
    firstPayoutCap: 1500,
    firstPayoutCapCount: 1,
    lifetimeCapMultiple: null,
    minMonthsBetweenPayouts: 0,
    minWinningDaysPerPayout: 5,
  }),
};

export const FUNDEDNEXT_REFERENCE: CompetitorScenario = {
  label: 'FundedNext Futures (ref)',
  firmId: 'fundednext',
  firmLabel: 'FundedNext',
  variant: 'market_reference',
  color: 'text-pink-400',
  passRate: 0.07,
  requestRate: 0.25,
  clusteringIntensity: 1.0,
  notes: 'Landing-page reference only. Newer entrant, terms shift frequently — re-verify.',
  kind: 'market_reference',
  sourceUrl: 'https://fundednext.com',
  lastCheckedAt: REF_CHECKED_AT,
  confidence: 'low',
  listPrice: 199,
  promoPrice: 99,
  advertisedRules: '1-step futures eval, 90% split advertised, fast payout cadence.',
  verifiedFundedRules: undefined,
  assumptions: buildProfile({
    price: 199,
    passMode: 0.07,
    requestMode: 0.25,
    payoutSplit: 0.90,
    firstPayoutCap: 2000,
    firstPayoutCapCount: 1,
    lifetimeCapMultiple: null,
    minMonthsBetweenPayouts: 0,
    minWinningDaysPerPayout: 5,
  }),
};

/**
 * Market-reference profiles. NOT included in ALL_COMPETITOR_SCENARIOS on
 * purpose — these must not drive treasury math until verified and promoted.
 */
export const MARKET_REFERENCE_PROFILES: CompetitorScenario[] = [
  MFFU_REFERENCE,
  TRADEIFY_REFERENCE,
  TPT_REFERENCE,
  FUNDEDNEXT_REFERENCE,
];
