export interface PricingTier {
  id: string;
  name: string;
  price: number;
  accountSize: string;
  accountSizeNum: number;
  profitTarget: number;
  maxDailyLoss: number;
  maxTotalDrawdown: number;
  minTradingDays: number;
  payoutCooldown: number;
  firstPayoutCap: number;
  splitPercent: number;
  lifetimeCapMultiple: number;
  lifetimeCapAmount: number;
  resetFee: number;
  popular?: boolean;
  isLive: boolean;
}

/**
 * CANONICAL FRONTEND TIER DATA
 *
 * These values MUST match the DB cohorts table (Performance phase)
 * and supabase/functions/_shared/checkout/tier-economics.ts.
 *
 * Source of truth chain:
 *   DB cohorts (Performance phase) → tier-economics.ts → this file
 *
 * Base payout economics (Starter ladder, 0 clean payouts):
 *   - 80% split, $500 first payout cap, 10× lifetime cap, 14d cooldown
 *
 * Ladder progression (Pro/Elite tiers) is NOT reflected here —
 * those upgrades happen server-side at payout evaluation time.
 */
export const TIERS: PricingTier[] = [
  {
    id: "starter",
    name: "Starter",
    price: 149,
    accountSize: "$50,000",
    accountSizeNum: 50_000,
    profitTarget: 10,
    maxDailyLoss: 5,
    maxTotalDrawdown: 10,
    minTradingDays: 5,
    payoutCooldown: 14,
    firstPayoutCap: 500,
    splitPercent: 80,
    lifetimeCapMultiple: 10,
    lifetimeCapAmount: 1_490,
    resetFee: 99,
    isLive: true,
  },
  {
    id: "pro",
    name: "Pro",
    price: 199,
    accountSize: "$100,000",
    accountSizeNum: 100_000,
    profitTarget: 10,
    maxDailyLoss: 5,
    maxTotalDrawdown: 10,
    minTradingDays: 5,
    payoutCooldown: 14,
    firstPayoutCap: 500,
    splitPercent: 80,
    lifetimeCapMultiple: 10,
    lifetimeCapAmount: 1_990,
    resetFee: 99,
    isLive: false,
  },
  {
    id: "elite",
    name: "Elite",
    price: 349,
    accountSize: "$200,000",
    accountSizeNum: 200_000,
    profitTarget: 10,
    maxDailyLoss: 5,
    maxTotalDrawdown: 10,
    minTradingDays: 5,
    payoutCooldown: 14,
    firstPayoutCap: 500,
    splitPercent: 80,
    lifetimeCapMultiple: 10,
    lifetimeCapAmount: 3_490,
    resetFee: 99,
    isLive: false,
  },
  {
    id: "founders",
    name: "Founder's Edition",
    price: 99,
    accountSize: "$50,000",
    accountSizeNum: 50_000,
    profitTarget: 10,
    maxDailyLoss: 5,
    maxTotalDrawdown: 10,
    minTradingDays: 5,
    payoutCooldown: 14,
    firstPayoutCap: 300,
    splitPercent: 80,
    lifetimeCapMultiple: 7,
    lifetimeCapAmount: 693,
    resetFee: 99,
    popular: true,
    isLive: true,
  },
];

/** Returns only tiers that are currently purchasable. */
export const getLiveTiers = () => TIERS.filter((t) => t.isLive);
