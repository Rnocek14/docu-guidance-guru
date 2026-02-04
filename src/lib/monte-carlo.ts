/**
 * Monte Carlo Simulation Engine for Prop Trading Platform Economics
 * 
 * Seeded by default for reproducible results (CI/regression-safe).
 * Pure functions, no side effects, no UI dependencies.
 * 
 * CRITICAL FIXES (v2):
 * 1. Account IDs persist across months (true lifetime tracking)
 * 2. Payout split applied BEFORE caps (so $300 cap = trader receives $300)
 * 3. Binding stats aggregated from real iteration data, not biased re-run
 * 4. Cohort model: existing accounts can request payouts in future months
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
  firstPayoutCap: number | null;        // e.g., 300 = first payout max $300 (trader receives)
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

  // Payout diagnostics for cap analysis
  payoutDiagnostics: {
    totalPayoutsPaidMean: number;
    totalPayoutsPaidP95: number;
    avgPayoutSize: number;
    avgPayoutsPerAccount: number;
    payoutRequestsTotal: number;
    payoutsApprovedTotal: number;
    
    // First payout cap metrics
    firstPayoutCapBindingRate: number;  // % of first payouts that hit the cap
    avgFirstPayoutBeforeCap: number;
    avgFirstPayoutAfterCap: number;
    
    // Lifetime cap metrics (aggregated from real iteration data)
    lifetimeCapBindingRate: number;     // % of accounts that hit lifetime cap
    avgLifetimePaidPerAccount: number;
    avgLifetimeHeadroomAtEnd: number;
    payoutsRejectedDueToLifetimeCap: number;
    accountsCompletedByCap: number;
    
    // Distribution data for confidence
    lifetimePaidP50: number;
    lifetimePaidP90: number;
    lifetimePaidP95: number;
    payoutsClippedByLifetimeCap: number;
    avgClippedAmount: number;
  };
  
  // Cohort/steady-state diagnostics
  cohortDiagnostics: {
    avgActiveCohortSize: number;           // average active (not completed) accounts per month
    avgEligibleCohortSize: number;         // average eligible (active + past eligibility gate) accounts
    activeCohortSizeByMonth: number[];     // active cohort size over time (last iteration)
    eligibleCohortSizeByMonth: number[];   // eligible cohort size over time (last iteration)
    payoutToRevenueRatioByMonth: number[]; // payout/revenue ratio over time
    resetRevenue: number;                  // total revenue from resets
    resetsThisRun: number;                 // count of resets
    zombieAccountsCompleted: number;       // accounts completed due to headroom < minimum
    fraudScaling: 'perEligibleAccount';    // clarifies fraud scales with eligible cohort
    chargebackScaling: 'perNewSalesRevenue'; // clarifies chargebacks scale with new sales
  };

  rawSamples?: number[][]; // optional: all monthly profits per iteration
}

export interface MonthResult {
  revenue: number;
  resetRevenue: number;         // NEW: revenue from resets
  payouts: number;
  fraudLoss: number;
  chargebacks: number;
  variableCosts: number;
  fixedCosts: number;
  netProfit: number;
  
  // Cohort tracking
  activeCohortSize: number;     // active (not completed) accounts at end of month
  eligibleCohortSize: number;   // accounts eligible for payout (active + past eligibility gate)
  resetsThisMonth: number;      // count of resets
  
  // Detailed payout tracking
  payoutDetails: {
    requestCount: number;
    approvedCount: number;
    totalPaid: number;
    firstPayoutCapHits: number;
    lifetimeCapHits: number;
    lifetimeCapRejections: number;
    accountsCompletedByCap: number;
    zombieAccountsCompleted: number;  // NEW: completed due to headroom < $50
    payoutSizes: number[];
    firstPayoutSizes: number[];  // before/after cap pairs
    lifetimeCapClippedAmounts: number[]; // amount clipped by lifetime cap
  };
}

// Per-account state tracking for lifetime caps
// CRITICAL: lifetimePaidTotal is PER USER and NEVER resets
// attemptPaid resets when account is recycled
export interface AccountState {
  id: number;
  createdMonth: number;
  eligibleMonth: number;       // first month account can request payout
  lifetimePaidTotal: number;   // NEVER resets - enforces per-user lifetime cap
  attemptPaid: number;         // resets on reset - tracks current attempt
  payoutCount: number;         // resets on reset
  resetCount: number;          // how many times this account has reset
  isCompleted: boolean;        // true when lifetime cap reached or zombie completed
  isActive: boolean;           // false if failed/churned
}

// Iteration-level account stats for aggregation
interface IterationAccountStats {
  totalEverCreated: number;           // all accounts ever created
  totalEverCompleted: number;         // accounts terminated (cap hit or zombie)
  accountsHitLifetimeCap: number;     // specifically due to cap
  totalLifetimePaid: number;
  totalHeadroomAtEnd: number;
  lifetimePaidValues: number[];       // for distribution
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
 */
function logNormal(random: () => number, mean: number, stdDev: number): number {
  const variance = stdDev * stdDev;
  const mu = Math.log(mean * mean / Math.sqrt(variance + mean * mean));
  const sigma = Math.sqrt(Math.log(1 + variance / (mean * mean)));
  
  const u1 = random();
  const u2 = random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  
  return Math.exp(mu + sigma * z);
}

/**
 * Beta distribution - good for rates/probabilities
 */
function beta(random: () => number, alpha: number, betaParam: number): number {
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
 */
function triangularToBeta(random: () => number, min: number, mode: number, max: number): number {
  const normalizedMode = (mode - min) / (max - min);
  const concentration = 4;
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
  
  const modified = JSON.parse(JSON.stringify(assumptions)) as MonteCarloAssumptions;
  
  const passRateMultiplier = 1 + (0.5 * intensity);
  const fraudAttemptMultiplier = 1 + (1.0 * intensity);
  const fraudSuccessMultiplier = 1 + (0.5 * intensity);
  const chargebackMultiplier = 1 + (0.6 * intensity);
  const payoutMultiplier = 1 + (0.3 * intensity);
  
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
// SINGLE MONTH SIMULATION (with persistent account IDs + cohort logic)
// ============================================================================

interface SimulateMonthContext {
  accountStates: Map<number, AccountState>;
  nextAccountId: number;          // mutable counter for unique IDs
  totalEverCreated: number;       // running total of all accounts created
  totalEverCompleted: number;     // running total of all accounts terminated
}

function simulateMonth(
  assumptions: MonteCarloAssumptions,
  random: () => number,
  ctx: SimulateMonthContext,
  monthIndex: number
): MonthResult {
  const { knobs } = assumptions;
  
  // Revenue from NEW accounts this month
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
  
  // =========================================================================
  // NEW ACCOUNTS THIS MONTH
  // =========================================================================
  const newPassedAccounts = Math.round(assumptions.accountsPerMonth * passRate);
  
  // Calculate eligibility month based on avgDaysToFirstPayout
  const eligibilityLag = Math.ceil(assumptions.avgDaysToFirstPayout / 30);
  
  // Create new accounts with persistent IDs
  for (let i = 0; i < newPassedAccounts; i++) {
    const accountId = ctx.nextAccountId++;
    ctx.accountStates.set(accountId, {
      id: accountId,
      createdMonth: monthIndex,
      eligibleMonth: monthIndex + eligibilityLag,
      lifetimePaidTotal: 0,  // NEVER resets - enforces per-user lifetime cap
      attemptPaid: 0,        // resets on reset
      payoutCount: 0,
      resetCount: 0,
      isCompleted: false,
      isActive: true,
    });
    ctx.totalEverCreated++;
  }
  
  // =========================================================================
  // LIFECYCLE EVENTS (resets, zombies) - BEFORE payout processing
  // CRITICAL: Resets are independent of payout requests!
  // =========================================================================
  let resetsThisMonth = 0;
  let resetRevenue = 0;
  let zombieAccountsCompleted = 0;
  
  const lifetimeCap = knobs.lifetimeCapPerUser;
  
  // Proper hazard rate conversion: p_month = 1 - (1 - p_annual)^(1/12)
  const monthlyResetProb = 1 - Math.pow(1 - assumptions.resetRate, 1/12);
  
  // Process lifecycle events for ALL active accounts (not just eligible ones)
  ctx.accountStates.forEach(state => {
    if (!state.isActive || state.isCompleted) return;
    
    // 1. Check for zombie accounts (headroom < $50)
    if (lifetimeCap !== null) {
      const headroom = lifetimeCap - state.lifetimePaidTotal;
      if (headroom > 0 && headroom < 50) {
        state.isCompleted = true;
        state.isActive = false;  // Mark inactive for clean exit
        zombieAccountsCompleted++;
        ctx.totalEverCompleted++;
        return; // Skip further processing for this account
      }
    }
    
    // 2. Reset hazard check - INDEPENDENT of payout request
    // Resets can happen to any active account, not just those requesting payouts
    if (random() < monthlyResetProb) {
      resetsThisMonth++;
      resetRevenue += knobs.resetPrice;
      
      // Reset ONLY current attempt counters - lifetimePaidTotal is PRESERVED
      state.attemptPaid = 0;
      state.payoutCount = 0;
      state.resetCount++;
      state.eligibleMonth = monthIndex + eligibilityLag; // Must wait again
      // Account remains active, just restarted
    }
  });
  
  // =========================================================================
  // PAYOUT REQUESTS FROM ELIGIBLE ACCOUNTS (new + existing cohorts)
  // =========================================================================
  let totalPayouts = 0;
  let firstPayoutCapHits = 0;
  let lifetimeCapHits = 0;
  let lifetimeCapRejections = 0;
  let accountsCompletedThisMonth = 0;
  const payoutSizes: number[] = [];
  const firstPayoutSizes: number[] = [];
  const lifetimeCapClippedAmounts: number[] = [];
  let payoutRequestCount = 0;
  let payoutApprovedCount = 0;
  
  // All active, non-completed accounts that have reached eligibility can request payouts
  const eligibleAccounts: AccountState[] = [];
  ctx.accountStates.forEach(state => {
    if (state.isActive && !state.isCompleted && monthIndex >= state.eligibleMonth) {
      eligibleAccounts.push(state);
    }
  });
  
  // Each eligible account has payoutRequestRate chance of requesting this month
  for (const account of eligibleAccounts) {
    // Probability of requesting payout this month
    if (random() > payoutRequestRate) {
      continue; // Didn't request this month
    }
    
    // NOTE: Reset check already happened above in lifecycle processing
    // If account just reset, eligibleMonth is now in the future, so they won't be here
    
    const numPayouts = Math.max(1, Math.round(payoutsPerAccount));
    
    for (let j = 0; j < numPayouts; j++) {
      payoutRequestCount++;
      
      // Check lifetime cap headroom using lifetimePaidTotal (per-user cap)
      const headroom = lifetimeCap !== null 
        ? lifetimeCap - account.lifetimePaidTotal 
        : Infinity;
      
      // If no headroom, reject immediately
      if (headroom <= 0) {
        lifetimeCapRejections++;
        account.isCompleted = true;
        account.isActive = false;
        ctx.totalEverCompleted++;
        continue;
      }
      
      // Calculate raw payout amount (gross profit share)
      const rawPayoutAmount = logNormal(
        random,
        assumptions.avgPayoutAmount.mean,
        assumptions.avgPayoutAmount.stdDev
      );
      
      // =====================================================================
      // CORRECT ORDER: Split FIRST, then apply caps
      // This means $300 cap = trader RECEIVES $300
      // =====================================================================
      let traderPayout = rawPayoutAmount * knobs.payoutSplitPercent;
      
      const isFirstPayout = account.payoutCount === 0;
      
      // Apply first payout cap (only on first payout of each ATTEMPT)
      if (isFirstPayout && knobs.firstPayoutCap !== null) {
        firstPayoutSizes.push(traderPayout); // track before cap
        if (traderPayout > knobs.firstPayoutCap) {
          traderPayout = knobs.firstPayoutCap;
          firstPayoutCapHits++;
        }
        firstPayoutSizes.push(traderPayout); // track after cap
      }
      
      // Apply lifetime cap using lifetimePaidTotal (per-user, never resets)
      if (lifetimeCap !== null && traderPayout > headroom) {
        const clippedAmount = traderPayout - headroom;
        lifetimeCapClippedAmounts.push(clippedAmount);
        lifetimeCapHits++;
        traderPayout = headroom; // cap to remaining headroom
        
        // Check if this completes the account
        if (account.lifetimePaidTotal + traderPayout >= lifetimeCap) {
          account.isCompleted = true;
          account.isActive = false;
          accountsCompletedThisMonth++;
          ctx.totalEverCompleted++;
        }
      }
      
      // Ensure minimum payout threshold ($50)
      if (traderPayout < 50) {
        continue; // Skip payouts below minimum
      }
      
      totalPayouts += traderPayout;
      payoutSizes.push(traderPayout);
      payoutApprovedCount++;
      
      // Update account state - both total and attempt
      account.lifetimePaidTotal += traderPayout;
      account.attemptPaid += traderPayout;
      account.payoutCount++;
    }
  }
  
  // Count cohort sizes at end of month
  let activeCohortSize = 0;
  let eligibleCohortSize = 0;
  ctx.accountStates.forEach(state => {
    if (state.isActive && !state.isCompleted) {
      activeCohortSize++;
      if (monthIndex >= state.eligibleMonth) {
        eligibleCohortSize++;
      }
    }
  });
  
  // Fraud loss (successful fraud attempts) - scaled by ELIGIBLE cohort size
  const fraudAttempts = eligibleAccounts.length * fraudAttemptRate;
  const successfulFrauds = fraudAttempts * fraudSuccessRate;
  const avgFraudPayout = logNormal(
    random,
    assumptions.avgPayoutAmount.mean * 1.3,
    assumptions.avgPayoutAmount.stdDev * 1.5
  );
  const fraudLoss = successfulFrauds * avgFraudPayout * knobs.payoutSplitPercent;
  
  // Chargebacks - tied to NEW account revenue only
  const chargebacks = revenue * chargebackRate;
  
  // Costs
  const variableCosts = assumptions.accountsPerMonth * assumptions.variableCostPerAccount;
  const fixedCosts = assumptions.fixedMonthlyCosts;
  
  // Net profit - now includes reset revenue
  const netProfit = revenue + resetRevenue - totalPayouts - fraudLoss - chargebacks - variableCosts - fixedCosts;
  
  return {
    revenue,
    resetRevenue,
    payouts: totalPayouts,
    fraudLoss,
    chargebacks,
    variableCosts,
    fixedCosts,
    netProfit,
    activeCohortSize,
    eligibleCohortSize,
    resetsThisMonth,
    payoutDetails: {
      requestCount: payoutRequestCount,
      approvedCount: payoutApprovedCount,
      totalPaid: totalPayouts,
      firstPayoutCapHits,
      lifetimeCapHits,
      lifetimeCapRejections,
      accountsCompletedByCap: accountsCompletedThisMonth,
      zombieAccountsCompleted,
      payoutSizes,
      firstPayoutSizes,
      lifetimeCapClippedAmounts,
    },
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
  
  // Aggregate payout diagnostics
  let totalFirstCapHits = 0;
  let totalFirstPayouts = 0;
  let totalLifetimeCapHits = 0;
  let totalLifetimeCapRejections = 0;
  let totalAccountsCompletedByCap = 0;
  let totalPayoutsRequested = 0;
  let totalPayoutsApproved = 0;
  let allPayoutSizes: number[] = [];
  let allFirstPayoutsBefore: number[] = [];
  let allFirstPayoutsAfter: number[] = [];
  let allLifetimeClippedAmounts: number[] = [];
  
  // NEW: Aggregate account stats from REAL iteration data
  const allIterationStats: IterationAccountStats[] = [];
  
  for (let iter = 0; iter < iterations; iter++) {
    const random = createRng(iter);
    const monthProfits: number[] = [];
    const monthResults: MonthResult[] = [];
    
    // Fresh account state map for each iteration
    // CRITICAL: Account IDs now persist ACROSS months within this iteration
    const ctx: SimulateMonthContext = {
      accountStates: new Map<number, AccountState>(),
      nextAccountId: 1,
      totalEverCreated: 0,
      totalEverCompleted: 0,
    };
    
    for (let month = 0; month < monthsPerIteration; month++) {
      const result = simulateMonth(effectiveAssumptions, random, ctx, month);
      monthProfits.push(result.netProfit);
      monthResults.push(result);
      
      // Aggregate payout diagnostics
      const pd = result.payoutDetails;
      totalFirstCapHits += pd.firstPayoutCapHits;
      totalLifetimeCapHits += pd.lifetimeCapHits;
      totalLifetimeCapRejections += pd.lifetimeCapRejections;
      totalAccountsCompletedByCap += pd.accountsCompletedByCap;
      totalPayoutsRequested += pd.requestCount;
      totalPayoutsApproved += pd.approvedCount;
      allPayoutSizes.push(...pd.payoutSizes);
      allLifetimeClippedAmounts.push(...pd.lifetimeCapClippedAmounts);
      
      // Track first payout sizes (pairs of before/after)
      for (let i = 0; i < pd.firstPayoutSizes.length; i += 2) {
        if (i + 1 < pd.firstPayoutSizes.length) {
          allFirstPayoutsBefore.push(pd.firstPayoutSizes[i]);
          allFirstPayoutsAfter.push(pd.firstPayoutSizes[i + 1]);
          totalFirstPayouts++;
        }
      }
    }
    
    allMonthlyProfits.push(monthProfits);
    allMonthResults.push(monthResults);
    
    // =========================================================================
    // AGGREGATE ACCOUNT STATS FROM REAL ITERATION DATA (no biased re-run!)
    // =========================================================================
    const lifetimeCap = effectiveAssumptions.knobs.lifetimeCapPerUser;
    let accountsHitCap = 0;
    let totalLifetimePaid = 0;
    let totalHeadroom = 0;
    const lifetimePaidValues: number[] = [];
    
    ctx.accountStates.forEach(state => {
      lifetimePaidValues.push(state.lifetimePaidTotal);
      totalLifetimePaid += state.lifetimePaidTotal;
      
      if (state.isCompleted) {
        accountsHitCap++;
      }
      
      if (lifetimeCap !== null) {
        totalHeadroom += Math.max(0, lifetimeCap - state.lifetimePaidTotal);
      }
    });
    
    allIterationStats.push({
      totalEverCreated: ctx.totalEverCreated,
      totalEverCompleted: ctx.totalEverCompleted,
      accountsHitLifetimeCap: accountsHitCap,
      totalLifetimePaid,
      totalHeadroomAtEnd: totalHeadroom,
      lifetimePaidValues,
    });
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
  const avgResetRevenue = allResults.reduce((s, r) => s + r.resetRevenue, 0) / allResults.length;
  const avgPayouts = allResults.reduce((s, r) => s + r.payouts, 0) / allResults.length;
  const avgFraudLoss = allResults.reduce((s, r) => s + r.fraudLoss, 0) / allResults.length;
  const avgChargebacks = allResults.reduce((s, r) => s + r.chargebacks, 0) / allResults.length;
  const avgCosts = allResults.reduce((s, r) => s + r.variableCosts + r.fixedCosts, 0) / allResults.length;
  
  // Cohort diagnostics
  const totalResets = allResults.reduce((s, r) => s + r.resetsThisMonth, 0);
  const totalResetRevenue = allResults.reduce((s, r) => s + r.resetRevenue, 0);
  const totalZombieAccountsCompleted = allResults.reduce((s, r) => s + r.payoutDetails.zombieAccountsCompleted, 0);
  const avgActiveCohortSize = allResults.reduce((s, r) => s + r.activeCohortSize, 0) / allResults.length;
  const avgEligibleCohortSize = allResults.reduce((s, r) => s + r.eligibleCohortSize, 0) / allResults.length;
  
  // Get cohort size over time from last iteration (for visualization)
  const lastIterResults = allMonthResults[allMonthResults.length - 1] || [];
  const activeCohortSizeByMonth = lastIterResults.map(r => r.activeCohortSize);
  const eligibleCohortSizeByMonth = lastIterResults.map(r => r.eligibleCohortSize);
  const payoutToRevenueRatioByMonth = lastIterResults.map(r => 
    r.revenue > 0 ? r.payouts / (r.revenue + r.resetRevenue) : 0
  );
  
  // Payout diagnostics
  const sortedPayoutTotals = allResults.map(r => r.payouts).sort((a, b) => a - b);
  const avgPayoutSize = allPayoutSizes.length > 0 
    ? allPayoutSizes.reduce((a, b) => a + b, 0) / allPayoutSizes.length 
    : 0;
  
  const avgFirstPayoutBefore = allFirstPayoutsBefore.length > 0
    ? allFirstPayoutsBefore.reduce((a, b) => a + b, 0) / allFirstPayoutsBefore.length
    : 0;
  const avgFirstPayoutAfter = allFirstPayoutsAfter.length > 0
    ? allFirstPayoutsAfter.reduce((a, b) => a + b, 0) / allFirstPayoutsAfter.length
    : 0;
  
  // =========================================================================
  // AGGREGATE LIFETIME CAP STATS FROM REAL ITERATION DATA
  // =========================================================================
  const totalAccountsEverCreated = allIterationStats.reduce((s, i) => s + i.totalEverCreated, 0);
  const totalAccountsHitCap = allIterationStats.reduce((s, i) => s + i.accountsHitLifetimeCap, 0);
  const totalLifetimePaidSum = allIterationStats.reduce((s, i) => s + i.totalLifetimePaid, 0);
  const totalHeadroomSum = allIterationStats.reduce((s, i) => s + i.totalHeadroomAtEnd, 0);
  
  // Collect all lifetime paid values for distribution
  const allLifetimePaidValues = allIterationStats.flatMap(i => i.lifetimePaidValues);
  const sortedLifetimePaid = [...allLifetimePaidValues].sort((a, b) => a - b);
  
  const lifetimeCapBindingRate = totalAccountsEverCreated > 0 
    ? totalAccountsHitCap / totalAccountsEverCreated 
    : 0;
  const avgLifetimePaidPerAccount = totalAccountsEverCreated > 0
    ? totalLifetimePaidSum / totalAccountsEverCreated
    : 0;
  const avgLifetimeHeadroomAtEnd = totalAccountsEverCreated > 0
    ? totalHeadroomSum / totalAccountsEverCreated
    : (effectiveAssumptions.knobs.lifetimeCapPerUser === null ? Infinity : 0);
  
  // Lifetime paid distribution
  const lifetimePaidP50 = sortedLifetimePaid.length > 0 
    ? sortedLifetimePaid[Math.floor(sortedLifetimePaid.length * 0.50)] 
    : 0;
  const lifetimePaidP90 = sortedLifetimePaid.length > 0 
    ? sortedLifetimePaid[Math.floor(sortedLifetimePaid.length * 0.90)] 
    : 0;
  const lifetimePaidP95 = sortedLifetimePaid.length > 0 
    ? sortedLifetimePaid[Math.floor(sortedLifetimePaid.length * 0.95)] 
    : 0;
  
  // Clipped amounts
  const payoutsClippedByLifetimeCap = allLifetimeClippedAmounts.length;
  const avgClippedAmount = allLifetimeClippedAmounts.length > 0
    ? allLifetimeClippedAmounts.reduce((a, b) => a + b, 0) / allLifetimeClippedAmounts.length
    : 0;
  
  // Average payouts per account
  const avgPayoutsPerAccount = totalAccountsEverCreated > 0
    ? totalPayoutsApproved / totalAccountsEverCreated
    : 0;
  
  // Total revenue including resets
  const avgTotalRevenue = avgRevenue + avgResetRevenue;
  
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
      avgMonthlyRevenue: avgTotalRevenue, // Now includes reset revenue
      avgMonthlyPayouts: avgPayouts,
      avgMonthlyFraudLoss: avgFraudLoss,
      avgMonthlyChargebacks: avgChargebacks,
      avgMonthlyCosts: avgCosts,
      payoutToRevenueRatio: avgPayouts / avgTotalRevenue,
      effectiveMargin: mean / avgTotalRevenue,
    },
    payoutDiagnostics: {
      totalPayoutsPaidMean: avgPayouts,
      totalPayoutsPaidP95: sortedPayoutTotals[Math.floor(sortedPayoutTotals.length * 0.95)] || 0,
      avgPayoutSize,
      avgPayoutsPerAccount,
      payoutRequestsTotal: totalPayoutsRequested,
      payoutsApprovedTotal: totalPayoutsApproved,
      
      firstPayoutCapBindingRate: totalFirstPayouts > 0 ? totalFirstCapHits / totalFirstPayouts : 0,
      avgFirstPayoutBeforeCap: avgFirstPayoutBefore,
      avgFirstPayoutAfterCap: avgFirstPayoutAfter,
      
      lifetimeCapBindingRate,
      avgLifetimePaidPerAccount,
      avgLifetimeHeadroomAtEnd,
      payoutsRejectedDueToLifetimeCap: totalLifetimeCapRejections,
      accountsCompletedByCap: totalAccountsCompletedByCap,
      
      lifetimePaidP50,
      lifetimePaidP90,
      lifetimePaidP95,
      payoutsClippedByLifetimeCap,
      avgClippedAmount,
    },
    cohortDiagnostics: {
      avgActiveCohortSize,
      avgEligibleCohortSize,
      activeCohortSizeByMonth,
      eligibleCohortSizeByMonth,
      payoutToRevenueRatioByMonth,
      resetRevenue: totalResetRevenue,
      resetsThisRun: totalResets,
      zombieAccountsCompleted: totalZombieAccountsCompleted,
      fraudScaling: 'perEligibleAccount' as const,
      chargebackScaling: 'perNewSalesRevenue' as const,
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
  pricePerAccount: 149, // Updated to match pricing decision

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

  // Default knobs (with $300 first payout cap)
  knobs: {
    firstPayoutCap: 300,            // $300 first payout cap (trader receives)
    payoutSplitPercent: 0.80,       // 80% to trader
    maxPayoutPercent: 0.80,         // max 80% of profits
    resetPrice: 99,                 // $99 reset
    lifetimeCapPerUser: null,       // no lifetime cap by default
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
    passRate: { min: 0.06, mode: 0.10, max: 0.16 },
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
  
  // Lifetime cap scenarios for testing
  withLifetimeCap3x: {
    ...DEFAULT_ASSUMPTIONS,
    knobs: {
      ...DEFAULT_ASSUMPTIONS.knobs,
      lifetimeCapPerUser: 149 * 3, // 3× entry = $447
    },
  },
  
  withLifetimeCap5x: {
    ...DEFAULT_ASSUMPTIONS,
    knobs: {
      ...DEFAULT_ASSUMPTIONS.knobs,
      lifetimeCapPerUser: 149 * 5, // 5× entry = $745
    },
  },
  
  withLifetimeCap7x: {
    ...DEFAULT_ASSUMPTIONS,
    knobs: {
      ...DEFAULT_ASSUMPTIONS.knobs,
      lifetimeCapPerUser: 149 * 7, // 7× entry = $1,043
    },
  },
  
  withLifetimeCap10x: {
    ...DEFAULT_ASSUMPTIONS,
    knobs: {
      ...DEFAULT_ASSUMPTIONS.knobs,
      lifetimeCapPerUser: 149 * 10, // 10× entry = $1,490
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

// ============================================================================
// LIFETIME CAP SWEEP ANALYSIS (with real binding diagnostics)
// ============================================================================

export interface LifetimeCapSweepResult {
  multiple: number | null; // null = unlimited
  capDollars: number | null;
  result: MonteCarloResult;
  capBindingRate: number;
  accountsCompletedByCap: number;
  avgLifetimePaidPerAccount: number;
  avgHeadroomAtEnd: number;
  payoutsRejected: number;
  marginDelta: number; // vs unlimited baseline
  profitDelta: number; // vs unlimited baseline
  
  // NEW: Distribution data
  lifetimePaidP50: number;
  lifetimePaidP90: number;
  lifetimePaidP95: number;
  payoutsClipped: number;
  avgClippedAmount: number;
}

export function runLifetimeCapSweep(
  config: MonteCarloConfig,
  baseAssumptions: MonteCarloAssumptions,
  multiples: (number | null)[] = [null, 15, 10, 7, 5, 3]
): LifetimeCapSweepResult[] {
  const results: LifetimeCapSweepResult[] = [];
  let baselineMargin = 0;
  let baselineProfit = 0;
  
  for (const multiple of multiples) {
    const assumptions = JSON.parse(JSON.stringify(baseAssumptions)) as MonteCarloAssumptions;
    assumptions.knobs.lifetimeCapPerUser = multiple !== null 
      ? assumptions.pricePerAccount * multiple 
      : null;
    
    const result = runMonteCarlo(config, assumptions);
    const pd = result.payoutDiagnostics;
    
    // First result (unlimited) is baseline
    if (multiple === null) {
      baselineMargin = result.diagnostics.effectiveMargin;
      baselineProfit = result.profit.mean;
    }
    
    results.push({
      multiple,
      capDollars: multiple !== null ? assumptions.pricePerAccount * multiple : null,
      result,
      capBindingRate: pd.lifetimeCapBindingRate,
      accountsCompletedByCap: pd.accountsCompletedByCap,
      avgLifetimePaidPerAccount: pd.avgLifetimePaidPerAccount,
      avgHeadroomAtEnd: pd.avgLifetimeHeadroomAtEnd,
      payoutsRejected: pd.payoutsRejectedDueToLifetimeCap,
      marginDelta: result.diagnostics.effectiveMargin - baselineMargin,
      profitDelta: result.profit.mean - baselineProfit,
      
      lifetimePaidP50: pd.lifetimePaidP50,
      lifetimePaidP90: pd.lifetimePaidP90,
      lifetimePaidP95: pd.lifetimePaidP95,
      payoutsClipped: pd.payoutsClippedByLifetimeCap,
      avgClippedAmount: pd.avgClippedAmount,
    });
  }
  
  return results;
}
