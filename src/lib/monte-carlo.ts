/**
 * Monte Carlo Simulation Engine for Prop Trading Platform Economics
 * 
 * Seeded by default for reproducible results (CI/regression-safe).
 * Pure functions, no side effects, no UI dependencies.
 */

// ============================================================================
// TYPES
// ============================================================================

export interface MonteCarloAssumptions {
  // Acquisition
  accountsPerMonth: number;
  pricePerAccount: number;

  // Trading funnel (rates as decimals, e.g., 0.12 = 12%)
  passRate: { min: number; mode: number; max: number };
  payoutRequestRate: { min: number; mode: number; max: number };
  avgDaysToFirstPayout: number;

  // Payout behavior
  avgPayoutAmount: { mean: number; stdDev: number }; // log-normal params
  payoutsPerPaidAccountPerMonth: { min: number; mode: number; max: number };

  // Abuse & friction
  fraudAttemptRate: { min: number; mode: number; max: number };
  fraudSuccessRate: { min: number; mode: number; max: number };
  chargebackRate: { min: number; mode: number; max: number };
  resetRate: number; // fixed for simplicity

  // Costs
  variableCostPerAccount: number;
  fixedMonthlyCosts: number;

  // Tunable knobs
  knobs: SimulationKnobs;
}

export interface SimulationKnobs {
  firstPayoutCap: number | null;        // e.g., 300 = first payout max $300
  payoutSplitPercent: number;           // e.g., 0.80 = 80% to trader
  maxPayoutPercent: number;             // e.g., 0.80 = max 80% of profits
  resetPrice: number;                   // price for reset accounts
  lifetimeCapPerUser: number | null;    // max total payouts per user lifetime
  attackIntensity: number;              // 0 = none, 1 = baseline, 2+ = coordinated
}

export interface MonteCarloConfig {
  iterations: number;
  monthsPerIteration: number;
  seed?: number; // undefined = use default seed for reproducibility
  randomSeed?: boolean; // true = ignore seed, use Math.random()
}

export interface MonteCarloResult {
  config: MonteCarloConfig;
  assumptions: MonteCarloAssumptions;
  
  profit: {
    mean: number;
    p5: number;
    p50: number;
    p95: number;
    stdDev: number;
    annualized: {
      mean: number;
      p5: number;
      p95: number;
    };
  };

  risk: {
    probabilityOfLoss: number;      // % of months with negative profit
    maxDrawdown: number;            // worst peak-to-trough in any iteration
    worstMonth: number;             // single worst month across all iterations
    bestMonth: number;              // single best month
    consecutiveLossMonths: number;  // max consecutive loss months seen
  };

  diagnostics: {
    avgMonthlyRevenue: number;
    avgMonthlyPayouts: number;
    avgMonthlyFraudLoss: number;
    avgMonthlyChargebacks: number;
    avgMonthlyCosts: number;
    payoutToRevenueRatio: number;
    effectiveMargin: number;
  };

  rawSamples?: number[][]; // optional: all monthly profits per iteration
}

export interface MonthResult {
  revenue: number;
  payouts: number;
  fraudLoss: number;
  chargebacks: number;
  variableCosts: number;
  fixedCosts: number;
  netProfit: number;
}

// ============================================================================
// SEEDED PRNG (Mulberry32 - fast, good distribution)
// ============================================================================

function mulberry32(seed: number): () => number {
  return function() {
    let t = seed += 0x6D2B79F5;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// ============================================================================
// DISTRIBUTION FUNCTIONS
// ============================================================================

/**
 * Triangular distribution - good for bounded rates with a most likely value
 * @param random - RNG function returning [0,1)
 * @param min - minimum value
 * @param mode - most likely value  
 * @param max - maximum value
 */
function triangular(random: () => number, min: number, mode: number, max: number): number {
  const u = random();
  const fc = (mode - min) / (max - min);
  
  if (u < fc) {
    return min + Math.sqrt(u * (max - min) * (mode - min));
  } else {
    return max - Math.sqrt((1 - u) * (max - min) * (max - mode));
  }
}

/**
 * Log-normal distribution - good for payout amounts (right-skewed, always positive)
 * Uses Box-Muller transform
 * @param random - RNG function
 * @param mean - desired mean of the distribution
 * @param stdDev - desired standard deviation
 */
function logNormal(random: () => number, mean: number, stdDev: number): number {
  // Convert mean/stdDev to log-space parameters
  const variance = stdDev * stdDev;
  const mu = Math.log(mean * mean / Math.sqrt(variance + mean * mean));
  const sigma = Math.sqrt(Math.log(1 + variance / (mean * mean)));
  
  // Box-Muller transform for normal distribution
  const u1 = random();
  const u2 = random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  
  return Math.exp(mu + sigma * z);
}

/**
 * Beta distribution - good for rates/probabilities
 * Uses Johnk's algorithm
 */
function beta(random: () => number, alpha: number, betaParam: number): number {
  // Simple rejection sampling for beta distribution
  let u1: number, u2: number, sum: number;
  
  do {
    u1 = Math.pow(random(), 1 / alpha);
    u2 = Math.pow(random(), 1 / betaParam);
    sum = u1 + u2;
  } while (sum > 1);
  
  return u1 / sum;
}

/**
 * Convert triangular params to approximate beta distribution
 * Maps min/mode/max to alpha/beta parameters
 */
function triangularToBeta(random: () => number, min: number, mode: number, max: number): number {
  // Normalize to [0,1] range
  const normalizedMode = (mode - min) / (max - min);
  
  // Estimate alpha/beta from mode (simplified approach)
  // For triangular-like behavior: use mode to set shape
  const concentration = 4; // controls "peakiness"
  const alpha = 1 + concentration * normalizedMode;
  const betaParam = 1 + concentration * (1 - normalizedMode);
  
  const sample = beta(random, alpha, betaParam);
  return min + sample * (max - min);
}

// ============================================================================
// ATTACK INTENSITY MODIFIERS
// ============================================================================

function applyAttackIntensity(
  assumptions: MonteCarloAssumptions,
  random: () => number
): MonteCarloAssumptions {
  const intensity = assumptions.knobs.attackIntensity;
  
  if (intensity <= 0) return assumptions;
  
  // Clone to avoid mutation
  const modified = JSON.parse(JSON.stringify(assumptions)) as MonteCarloAssumptions;
  
  // Scale factors based on intensity
  const passRateMultiplier = 1 + (0.5 * intensity);      // +50% per intensity level
  const fraudAttemptMultiplier = 1 + (1.0 * intensity);  // +100% per intensity level
  const fraudSuccessMultiplier = 1 + (0.5 * intensity);  // +50% per intensity level
  const chargebackMultiplier = 1 + (0.6 * intensity);    // +60% per intensity level
  const payoutMultiplier = 1 + (0.3 * intensity);        // +30% per intensity level
  
  // Apply multipliers (capped at reasonable maximums)
  modified.passRate = {
    min: Math.min(modified.passRate.min * passRateMultiplier, 0.35),
    mode: Math.min(modified.passRate.mode * passRateMultiplier, 0.40),
    max: Math.min(modified.passRate.max * passRateMultiplier, 0.50),
  };
  
  modified.fraudAttemptRate = {
    min: Math.min(modified.fraudAttemptRate.min * fraudAttemptMultiplier, 0.40),
    mode: Math.min(modified.fraudAttemptRate.mode * fraudAttemptMultiplier, 0.50),
    max: Math.min(modified.fraudAttemptRate.max * fraudAttemptMultiplier, 0.60),
  };
  
  modified.fraudSuccessRate = {
    min: Math.min(modified.fraudSuccessRate.min * fraudSuccessMultiplier, 0.08),
    mode: Math.min(modified.fraudSuccessRate.mode * fraudSuccessMultiplier, 0.10),
    max: Math.min(modified.fraudSuccessRate.max * fraudSuccessMultiplier, 0.15),
  };
  
  modified.chargebackRate = {
    min: Math.min(modified.chargebackRate.min * chargebackMultiplier, 0.08),
    mode: Math.min(modified.chargebackRate.mode * chargebackMultiplier, 0.10),
    max: Math.min(modified.chargebackRate.max * chargebackMultiplier, 0.12),
  };
  
  modified.avgPayoutAmount = {
    mean: modified.avgPayoutAmount.mean * payoutMultiplier,
    stdDev: modified.avgPayoutAmount.stdDev * payoutMultiplier,
  };
  
  return modified;
}

// ============================================================================
// SINGLE MONTH SIMULATION
// ============================================================================

function simulateMonth(
  assumptions: MonteCarloAssumptions,
  random: () => number
): MonthResult {
  const { knobs } = assumptions;
  
  // Revenue
  const revenue = assumptions.accountsPerMonth * assumptions.pricePerAccount;
  
  // Sample rates from distributions
  const passRate = triangularToBeta(
    random,
    assumptions.passRate.min,
    assumptions.passRate.mode,
    assumptions.passRate.max
  );
  
  const payoutRequestRate = triangularToBeta(
    random,
    assumptions.payoutRequestRate.min,
    assumptions.payoutRequestRate.mode,
    assumptions.payoutRequestRate.max
  );
  
  const fraudAttemptRate = triangularToBeta(
    random,
    assumptions.fraudAttemptRate.min,
    assumptions.fraudAttemptRate.mode,
    assumptions.fraudAttemptRate.max
  );
  
  const fraudSuccessRate = triangularToBeta(
    random,
    assumptions.fraudSuccessRate.min,
    assumptions.fraudSuccessRate.mode,
    assumptions.fraudSuccessRate.max
  );
  
  const chargebackRate = triangularToBeta(
    random,
    assumptions.chargebackRate.min,
    assumptions.chargebackRate.mode,
    assumptions.chargebackRate.max
  );
  
  const payoutsPerAccount = triangularToBeta(
    random,
    assumptions.payoutsPerPaidAccountPerMonth.min,
    assumptions.payoutsPerPaidAccountPerMonth.mode,
    assumptions.payoutsPerPaidAccountPerMonth.max
  );
  
  // Calculate passed accounts
  const passedAccounts = Math.round(assumptions.accountsPerMonth * passRate);
  
  // Accounts requesting payout
  const accountsRequestingPayout = Math.round(passedAccounts * payoutRequestRate);
  
  // Sample payout amounts
  let totalPayouts = 0;
  for (let i = 0; i < accountsRequestingPayout; i++) {
    const numPayouts = Math.max(1, Math.round(payoutsPerAccount));
    
    for (let j = 0; j < numPayouts; j++) {
      let payoutAmount = logNormal(
        random,
        assumptions.avgPayoutAmount.mean,
        assumptions.avgPayoutAmount.stdDev
      );
      
      // Apply first payout cap (only on first payout of each account)
      if (j === 0 && knobs.firstPayoutCap !== null) {
        payoutAmount = Math.min(payoutAmount, knobs.firstPayoutCap);
      }
      
      // Apply payout split
      payoutAmount = payoutAmount * knobs.payoutSplitPercent;
      
      totalPayouts += payoutAmount;
    }
  }
  
  // Fraud loss (successful fraud attempts)
  const fraudAttempts = accountsRequestingPayout * fraudAttemptRate;
  const successfulFrauds = fraudAttempts * fraudSuccessRate;
  const avgFraudPayout = logNormal(
    random,
    assumptions.avgPayoutAmount.mean * 1.3, // fraudsters aim higher
    assumptions.avgPayoutAmount.stdDev * 1.5
  );
  const fraudLoss = successfulFrauds * avgFraudPayout * knobs.payoutSplitPercent;
  
  // Chargebacks
  const chargebacks = revenue * chargebackRate;
  
  // Costs
  const variableCosts = assumptions.accountsPerMonth * assumptions.variableCostPerAccount;
  const fixedCosts = assumptions.fixedMonthlyCosts;
  
  // Net profit
  const netProfit = revenue - totalPayouts - fraudLoss - chargebacks - variableCosts - fixedCosts;
  
  return {
    revenue,
    payouts: totalPayouts,
    fraudLoss,
    chargebacks,
    variableCosts,
    fixedCosts,
    netProfit,
  };
}

// ============================================================================
// MAIN SIMULATION
// ============================================================================

export function runMonteCarlo(
  config: MonteCarloConfig,
  assumptions: MonteCarloAssumptions
): MonteCarloResult {
  const { iterations, monthsPerIteration, seed = 42, randomSeed = false } = config;
  
  // Apply attack intensity
  const effectiveAssumptions = applyAttackIntensity(assumptions, () => 0.5);
  
  // Initialize RNG
  const createRng = randomSeed 
    ? () => Math.random 
    : (iterSeed: number) => mulberry32(seed + iterSeed);
  
  // Collect results
  const allMonthlyProfits: number[][] = [];
  const allMonthResults: MonthResult[][] = [];
  
  for (let iter = 0; iter < iterations; iter++) {
    const random = createRng(iter);
    const monthProfits: number[] = [];
    const monthResults: MonthResult[] = [];
    
    for (let month = 0; month < monthsPerIteration; month++) {
      const result = simulateMonth(effectiveAssumptions, random);
      monthProfits.push(result.netProfit);
      monthResults.push(result);
    }
    
    allMonthlyProfits.push(monthProfits);
    allMonthResults.push(monthResults);
  }
  
  // Flatten all months for aggregate stats
  const allProfits = allMonthlyProfits.flat();
  
  // Calculate profit statistics
  const sortedProfits = [...allProfits].sort((a, b) => a - b);
  const mean = allProfits.reduce((a, b) => a + b, 0) / allProfits.length;
  const p5 = sortedProfits[Math.floor(sortedProfits.length * 0.05)];
  const p50 = sortedProfits[Math.floor(sortedProfits.length * 0.50)];
  const p95 = sortedProfits[Math.floor(sortedProfits.length * 0.95)];
  const variance = allProfits.reduce((sum, p) => sum + Math.pow(p - mean, 2), 0) / allProfits.length;
  const stdDev = Math.sqrt(variance);
  
  // Risk metrics
  const lossMonths = allProfits.filter(p => p < 0).length;
  const probabilityOfLoss = lossMonths / allProfits.length;
  const worstMonth = Math.min(...allProfits);
  const bestMonth = Math.max(...allProfits);
  
  // Max drawdown (per iteration, then take worst)
  let maxDrawdown = 0;
  let maxConsecutiveLoss = 0;
  
  for (const iterProfits of allMonthlyProfits) {
    let cumulative = 0;
    let peak = 0;
    let consecutiveLoss = 0;
    
    for (const profit of iterProfits) {
      cumulative += profit;
      peak = Math.max(peak, cumulative);
      const drawdown = peak - cumulative;
      maxDrawdown = Math.max(maxDrawdown, drawdown);
      
      if (profit < 0) {
        consecutiveLoss++;
        maxConsecutiveLoss = Math.max(maxConsecutiveLoss, consecutiveLoss);
      } else {
        consecutiveLoss = 0;
      }
    }
  }
  
  // Diagnostics (averages across all months)
  const allResults = allMonthResults.flat();
  const avgRevenue = allResults.reduce((s, r) => s + r.revenue, 0) / allResults.length;
  const avgPayouts = allResults.reduce((s, r) => s + r.payouts, 0) / allResults.length;
  const avgFraudLoss = allResults.reduce((s, r) => s + r.fraudLoss, 0) / allResults.length;
  const avgChargebacks = allResults.reduce((s, r) => s + r.chargebacks, 0) / allResults.length;
  const avgCosts = allResults.reduce((s, r) => s + r.variableCosts + r.fixedCosts, 0) / allResults.length;
  
  return {
    config,
    assumptions,
    profit: {
      mean,
      p5,
      p50,
      p95,
      stdDev,
      annualized: {
        mean: mean * 12,
        p5: p5 * 12,
        p95: p95 * 12,
      },
    },
    risk: {
      probabilityOfLoss,
      maxDrawdown,
      worstMonth,
      bestMonth,
      consecutiveLossMonths: maxConsecutiveLoss,
    },
    diagnostics: {
      avgMonthlyRevenue: avgRevenue,
      avgMonthlyPayouts: avgPayouts,
      avgMonthlyFraudLoss: avgFraudLoss,
      avgMonthlyChargebacks: avgChargebacks,
      avgMonthlyCosts: avgCosts,
      payoutToRevenueRatio: avgPayouts / avgRevenue,
      effectiveMargin: mean / avgRevenue,
    },
    rawSamples: allMonthlyProfits,
  };
}

// ============================================================================
// DEFAULT ASSUMPTIONS (from your analysis)
// ============================================================================

export const DEFAULT_ASSUMPTIONS: MonteCarloAssumptions = {
  // Acquisition
  accountsPerMonth: 500,
  pricePerAccount: 150,

  // Trading funnel
  passRate: { min: 0.08, mode: 0.12, max: 0.18 },
  payoutRequestRate: { min: 0.55, mode: 0.65, max: 0.75 },
  avgDaysToFirstPayout: 18,

  // Payout behavior
  avgPayoutAmount: { mean: 420, stdDev: 150 },
  payoutsPerPaidAccountPerMonth: { min: 0.8, mode: 1.2, max: 1.8 },

  // Abuse & friction
  fraudAttemptRate: { min: 0.04, mode: 0.07, max: 0.12 },
  fraudSuccessRate: { min: 0.004, mode: 0.008, max: 0.015 },
  chargebackRate: { min: 0.015, mode: 0.025, max: 0.04 },
  resetRate: 0.18,

  // Costs
  variableCostPerAccount: 8,
  fixedMonthlyCosts: 18000,

  // Default knobs (conservative)
  knobs: {
    firstPayoutCap: null,           // no cap by default
    payoutSplitPercent: 0.80,       // 80% to trader
    maxPayoutPercent: 0.80,         // max 80% of profits
    resetPrice: 99,                 // $99 reset
    lifetimeCapPerUser: null,       // no lifetime cap
    attackIntensity: 0,             // no attack scenario
  },
};

// ============================================================================
// SCENARIO PRESETS
// ============================================================================

export const SCENARIO_PRESETS = {
  baseline: DEFAULT_ASSUMPTIONS,
  
  growthSpike: {
    ...DEFAULT_ASSUMPTIONS,
    accountsPerMonth: 1000,
    passRate: { min: 0.10, mode: 0.14, max: 0.20 },
  },
  
  coordinatedAttack: {
    ...DEFAULT_ASSUMPTIONS,
    knobs: {
      ...DEFAULT_ASSUMPTIONS.knobs,
      attackIntensity: 2,
    },
  },
  
  tiktokViral: {
    ...DEFAULT_ASSUMPTIONS,
    accountsPerMonth: 2000,
    passRate: { min: 0.06, mode: 0.10, max: 0.16 }, // more noise, lower quality
    fraudAttemptRate: { min: 0.08, mode: 0.12, max: 0.18 },
    chargebackRate: { min: 0.03, mode: 0.04, max: 0.06 },
    knobs: {
      ...DEFAULT_ASSUMPTIONS.knobs,
      attackIntensity: 1,
    },
  },
  
  withFirstPayoutCap: {
    ...DEFAULT_ASSUMPTIONS,
    knobs: {
      ...DEFAULT_ASSUMPTIONS.knobs,
      firstPayoutCap: 300,
    },
  },
  
  conservativeKnobs: {
    ...DEFAULT_ASSUMPTIONS,
    knobs: {
      ...DEFAULT_ASSUMPTIONS.knobs,
      firstPayoutCap: 300,
      payoutSplitPercent: 0.70,
      maxPayoutPercent: 0.70,
    },
  },
} as const;

// ============================================================================
// COMPARISON HELPER
// ============================================================================

export interface ScenarioComparison {
  scenario: string;
  result: MonteCarloResult;
  deltaFromBaseline?: {
    meanProfit: number;
    probabilityOfLoss: number;
    maxDrawdown: number;
  };
}

export function compareScenarios(
  config: MonteCarloConfig,
  scenarios: Record<string, MonteCarloAssumptions>
): ScenarioComparison[] {
  const results: ScenarioComparison[] = [];
  let baselineResult: MonteCarloResult | null = null;
  
  for (const [name, assumptions] of Object.entries(scenarios)) {
    const result = runMonteCarlo(config, assumptions);
    
    if (name === 'baseline') {
      baselineResult = result;
    }
    
    results.push({
      scenario: name,
      result,
      deltaFromBaseline: baselineResult && name !== 'baseline' ? {
        meanProfit: result.profit.mean - baselineResult.profit.mean,
        probabilityOfLoss: result.risk.probabilityOfLoss - baselineResult.risk.probabilityOfLoss,
        maxDrawdown: result.risk.maxDrawdown - baselineResult.risk.maxDrawdown,
      } : undefined,
    });
  }
  
  return results;
}

// ============================================================================
// SENSITIVITY ANALYSIS
// ============================================================================

export interface SensitivityResult {
  parameter: string;
  values: number[];
  profits: number[];
  lossProbs: number[];
}

export function runSensitivityAnalysis(
  config: MonteCarloConfig,
  baseAssumptions: MonteCarloAssumptions,
  parameter: keyof MonteCarloAssumptions | `knobs.${keyof SimulationKnobs}`,
  valueRange: number[]
): SensitivityResult {
  const profits: number[] = [];
  const lossProbs: number[] = [];
  
  for (const value of valueRange) {
    const modified = JSON.parse(JSON.stringify(baseAssumptions)) as MonteCarloAssumptions;
    
    // Handle nested knobs
    if (parameter.startsWith('knobs.')) {
      const knobKey = parameter.replace('knobs.', '') as keyof SimulationKnobs;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (modified.knobs as any)[knobKey] = value;
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (modified as any)[parameter] = value;
    }
    
    const result = runMonteCarlo(config, modified);
    profits.push(result.profit.mean);
    lossProbs.push(result.risk.probabilityOfLoss);
  }
  
  return {
    parameter,
    values: valueRange,
    profits,
    lossProbs,
  };
}
