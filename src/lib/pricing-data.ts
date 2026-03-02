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
    splitPercent: 82,
    lifetimeCapMultiple: 9,
    lifetimeCapAmount: 1_791,
    resetFee: 99,
    popular: true,
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
    firstPayoutCap: 750,
    splitPercent: 85,
    lifetimeCapMultiple: 12,
    lifetimeCapAmount: 4_188,
    resetFee: 99,
    isLive: false,
  },
];

/** Returns only tiers that are currently purchasable. */
export const getLiveTiers = () => TIERS.filter((t) => t.isLive);
