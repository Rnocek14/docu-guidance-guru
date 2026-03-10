// ============================================================
// CANONICAL TIER ECONOMICS — Single Source of Truth
//
// Every edge function, admin tool, and frontend display MUST
// derive tier economics from this file. Do NOT duplicate these
// values elsewhere.
//
// Payout economics (split, cap, lifetime) reflect the BASE
// tier (Starter ladder, 0 clean payouts). Ladder progression
// (Pro/Elite tiers) is handled by the ladder-spec system at
// payout evaluation time, NOT here.
//
// Stripe IDs are environment-specific. These are PRODUCTION IDs.
// ============================================================

export interface TierEconomics {
  tierId: string
  name: string
  accountSize: number
  entryFee: number
  isLive: boolean
  // Base payout economics (Performance phase, Starter ladder)
  splitPercent: number
  firstPayoutCap: number
  lifetimeCapMultiple: number
  lifetimeCapAmount: number  // entryFee × lifetimeCapMultiple
  payoutCooldownDays: number
  resetFee: number
  // Rule parameters
  profitTargetPercent: number
  maxDailyLossPercent: number
  maxTotalDrawdownPercent: number
  minTradingDays: number
}

export interface TierStripeConfig {
  priceId: string
  productId: string
}

/**
 * Canonical tier definitions.
 * 
 * IMPORTANT: splitPercent, firstPayoutCap, and lifetimeCapMultiple here
 * are BASE values (Starter ladder tier, 0 clean payouts). The ladder
 * system (ladder-spec.ts) overrides these at payout time based on
 * clean payout count. These values MUST match the DB cohorts table
 * for the Performance phase.
 * 
 * Source of truth chain:
 *   DB cohorts (Performance phase) → this file → all consumers
 */
export const TIER_ECONOMICS: Record<string, TierEconomics> = {
  starter: {
    tierId: 'starter',
    name: 'Starter Evaluation',
    accountSize: 50_000,
    entryFee: 149,
    isLive: true,
    // Base payout economics (must match DB Performance cohort)
    splitPercent: 80,
    firstPayoutCap: 500,
    lifetimeCapMultiple: 10,
    lifetimeCapAmount: 1_490,  // 149 × 10
    payoutCooldownDays: 14,
    resetFee: 99,
    // Rule parameters
    profitTargetPercent: 10,
    maxDailyLossPercent: 5,
    maxTotalDrawdownPercent: 10,
    minTradingDays: 5,
  },
  pro: {
    tierId: 'pro',
    name: 'Pro Evaluation',
    accountSize: 100_000,
    entryFee: 199,
    isLive: false,
    splitPercent: 80,
    firstPayoutCap: 500,
    lifetimeCapMultiple: 10,
    lifetimeCapAmount: 1_990,  // 199 × 10
    payoutCooldownDays: 14,
    resetFee: 99,
    profitTargetPercent: 10,
    maxDailyLossPercent: 5,
    maxTotalDrawdownPercent: 10,
    minTradingDays: 5,
  },
  elite: {
    tierId: 'elite',
    name: 'Elite Evaluation',
    accountSize: 200_000,
    entryFee: 349,
    isLive: false,
    splitPercent: 80,
    firstPayoutCap: 500,
    lifetimeCapMultiple: 10,
    lifetimeCapAmount: 3_490,  // 349 × 10
    payoutCooldownDays: 14,
    resetFee: 99,
    profitTargetPercent: 10,
    maxDailyLossPercent: 5,
    maxTotalDrawdownPercent: 10,
    minTradingDays: 5,
  },
  founders: {
    tierId: 'founders',
    name: "Founder's Edition",
    accountSize: 50_000,
    entryFee: 199,
    isLive: true,
    // Proven-safe economics: tighter caps than Starter
    splitPercent: 80,
    firstPayoutCap: 300,
    lifetimeCapMultiple: 7,
    lifetimeCapAmount: 1_393,  // 199 × 7
    payoutCooldownDays: 14,
    resetFee: 99,
    profitTargetPercent: 10,
    maxDailyLossPercent: 5,
    maxTotalDrawdownPercent: 10,
    minTradingDays: 5,
  },
}

/**
 * Stripe configuration per tier.
 * Separated from economics because these are provider-specific
 * and may change without affecting business rules.
 */
export const TIER_STRIPE: Record<string, TierStripeConfig> = {
  starter: {
    priceId: 'price_1SxvRoLH4HmFKO8KSW3FUPzA',
    productId: 'prod_Tvn1elGTRKWmdC',
  },
  pro: {
    priceId: 'price_1SxvRpLH4HmFKO8KfvQtaGTV',
    productId: 'prod_Tvn1sJVvjM0QoF',
  },
  elite: {
    priceId: 'price_1SxvRqLH4HmFKO8KwCfeCx1C',
    productId: 'prod_Tvn1vcoJGH3uwR',
  },
  founders: {
    priceId: 'price_1T9XmhLH4HmFKO8KTdwnuSPL',
    productId: 'prod_U7nNSpm3mImjr0',
  },
}

/** Tier → Cohort mapping for fulfillment */
export const TIER_COHORT_MAP: Record<string, { accountSize: number; cohortName: string }> = {
  starter: { accountSize: 50_000, cohortName: 'Starter' },
  pro: { accountSize: 100_000, cohortName: 'Pro' },
  elite: { accountSize: 200_000, cohortName: 'Elite' },
  founders: { accountSize: 50_000, cohortName: "Founder's Edition" },
}

/** Server-authoritative rules version — never trust client value */
export const RULES_VERSION = 'v1.0'
