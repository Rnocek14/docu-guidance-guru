/**
 * Monte Carlo Simulation Engine for Simulated Evaluation Platform Economics
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

import {
  type BreakerPolicy,
  type BreakerState,
  type BreakerDiagnostics,
  createBreakerState,
  computeRollingPayRevAvg3Prev,
  aggregateBreakerDiagnostics,
} from './breaker-policy';

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
  firstPayoutCapCount: number;          // how many payouts the cap applies to (default 1 = first only; Apex uses 5)
  payoutSplitPercent: number;           // e.g., 0.80 = 80% to trader
  maxPayoutPercent: number;             // e.g., 0.80 = max 80% of profits
  resetPrice: number;                   // price for reset accounts
  lifetimeCapPerUser: number | null;    // max total payouts per user lifetime
  attackIntensity: number;              // 0 = none, 1 = baseline, 2+ = coordinated
  
  // Payout velocity gates (Tradeify/Topstep/Alpha Futures style)
  minWinningDaysPerPayout: number;      // 0 = disabled. Min winning trading days since last payout
  minProfitSinceLastPayout: number;     // 0 = disabled. Min $ profit accumulated since last payout to request another
  minMonthsBetweenPayouts: number;      // 0 = disabled. Min months between payouts (replaces cadenceDays)
  
  // Verification cohort (liability-maturity brake)
  verificationMonths: number;           // 0 = disabled. Months in verification phase before payout eligibility
  verificationFailRate: number;         // 0-1. Fraction that fail/churn during verification (monthly hazard)
  
  // Breaker: explicit payout freeze (set by engine when L2 is active)
  freezePayouts?: boolean;              // true = skip all payout processing this month (revenue/costs still computed)
}

export interface MonteCarloConfig {
  iterations: number;
  monthsPerIteration: number;
  seed?: number; // undefined = use default seed for reproducibility
  randomSeed?: boolean; // true = ignore seed, use Math.random()
  breakerPolicy?: BreakerPolicy | null; // optional dynamic breaker
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
    
    // Cap pressure: avgLifetimePaid / cap (only meaningful if cap set)
    // Gives immediate "how close to saturation" signal
    capPressure: number | null;
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
    expectedResetsThisRun: number;         // expected resets based on hazard rate
    resetRateErrorRatio: number;           // observed/expected for sanity check
    zombieAccountsCompleted: number;       // accounts completed due to headroom < minimum
    resetScope: 'allActive';               // documents that resets apply to all active accounts
    fraudScaling: 'perEligibleAccount';    // clarifies fraud scales with eligible cohort
    chargebackScaling: 'perNewSalesRevenue'; // clarifies chargebacks scale with new sales
    
    // Per-month event series for steady-state analysis
    capHitsByMonth: number[];              // accounts hitting cap each month
    zombiesByMonth: number[];              // zombie completions each month
    resetsByMonth: number[];               // resets each month
    newPassedByMonth: number[];            // new passed accounts each month (for test bounds)
    
    // Completion breakdown diagnostic
    capHitShareOfCompletions: number;      // cap-hit completions / total completions
  };

  rawSamples?: number[][]; // optional: all monthly profits per iteration
  rawMonthResults?: MonthResult[][]; // optional: full per-month breakdown per iteration
  breakerDiagnostics?: BreakerDiagnostics; // populated when breakerPolicy is set
}

export interface MonthResult {
  revenue: number;
  resetRevenue: number;
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
  expectedResetsThisMonth: number; // expected resets based on hazard rate (for sanity checks)
  newPassedAccountsThisMonth: number; // new accounts that passed this month (for test bounds)
  
  // Breaker state (populated when breakerPolicy is set)
  breakerLevel: number; // 0 | 1 | 2 — BreakerLevel from breaker-policy
  breakerApplied: boolean;      // true if knobs were overridden this month
  payRevRatio: number;           // Pay/Rev for this month
  payoutsSuppressedByBreaker: number; // payout requests skipped due to L2 freeze
  
  // Detailed payout tracking
  payoutDetails: {
    requestCount: number;
    approvedCount: number;
    totalPaid: number;
    firstPayoutCapHits: number;
    lifetimeCapHits: number;
    lifetimeCapRejections: number;
    accountsCompletedByCap: number;  // cap-hit completions this month
    zombieAccountsCompleted: number; // zombie completions this month
    payoutSizes: number[];
    firstPayoutSizes: number[];
    lifetimeCapClippedAmounts: number[];
  };
}

// Completion reason enum for type safety
type CompletionReason = 'cap' | 'zombie' | 'other';

/**
 * Helper function to complete an account with proper tracking.
 * Centralizes completion logic to prevent "forgot to set completedByCapHit" regressions.
 */
function completeAccount(
  state: AccountState, 
  reason: CompletionReason, 
  ctx: SimulateMonthContext
): void {
  if (state.isCompleted) return; // Already completed, no double-counting
  
  state.isCompleted = true;
  state.isActive = false;
  state.completedByCapHit = reason === 'cap';
  ctx.totalEverCompleted++;
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
  completedByCapHit: boolean;  // TRUE only if completed due to hitting lifetime cap
  
  // Velocity gate tracking
  profitSinceLastPayout: number;        // simulated profit accumulated since last payout ($)
  monthsSinceLastPayout: number;        // months since last payout, reset to 0 on payout
  winningDaysSinceLastPayout: number;   // accumulated each month, reset to 0 on payout
  
  // Verification phase
  phase: 'verification' | 'funded';     // verification = can't request payouts yet
  verificationStartMonth: number;       // when verification started
}

// Iteration-level account stats for aggregation
interface IterationAccountStats {
  totalEverCreated: number;           // all accounts ever created
  totalEverCompleted: number;         // accounts terminated (cap hit or zombie)
  accountsHitLifetimeCap: number;     // specifically due to cap (NOT zombies or other exits)
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
    const useVerification = knobs.verificationMonths > 0;
    ctx.accountStates.set(accountId, {
      id: accountId,
      createdMonth: monthIndex,
      eligibleMonth: useVerification 
        ? monthIndex + eligibilityLag + knobs.verificationMonths  // verification delays eligibility
        : monthIndex + eligibilityLag,
      lifetimePaidTotal: 0,
      attemptPaid: 0,
      payoutCount: 0,
      resetCount: 0,
      isCompleted: false,
      isActive: true,
      completedByCapHit: false,
      profitSinceLastPayout: 0,
      monthsSinceLastPayout: 0,
      winningDaysSinceLastPayout: 0,
      phase: useVerification ? 'verification' : 'funded',
      verificationStartMonth: monthIndex,
    });
    ctx.totalEverCreated++;
  }
  
  // =========================================================================
  // LIFECYCLE EVENTS (resets, zombies) - BEFORE payout processing
  // CRITICAL: Resets apply to ALL active accounts (resetScope: 'allActive')
  // This means accounts can reset even before reaching eligibility
  // =========================================================================
  let resetsThisMonth = 0;
  let resetRevenue = 0;
  let zombieAccountsCompleted = 0;
  
  const lifetimeCap = knobs.lifetimeCapPerUser;
  
  // Proper hazard rate conversion: p_month = 1 - (1 - p_annual)^(1/12)
  const monthlyResetProb = 1 - Math.pow(1 - assumptions.resetRate, 1/12);
  
  // Count active accounts at START of lifecycle processing (for expected resets calc)
  let activeCountBeforeLifecycle = 0;
  ctx.accountStates.forEach(state => {
    if (state.isActive && !state.isCompleted) activeCountBeforeLifecycle++;
  });
  
  // Process lifecycle events for ALL active accounts (not just eligible ones)
  ctx.accountStates.forEach(state => {
    if (!state.isActive || state.isCompleted) return;
    
    // 1. Check for zombie accounts (headroom < $50)
    if (lifetimeCap !== null) {
      const headroom = lifetimeCap - state.lifetimePaidTotal;
      if (headroom > 0 && headroom < 50) {
        completeAccount(state, 'zombie', ctx);
        zombieAccountsCompleted++;
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
      state.profitSinceLastPayout = 0;
      state.monthsSinceLastPayout = 0;
      state.winningDaysSinceLastPayout = 0;
      // Account remains active, just restarted
    }
  });
  
  // =========================================================================
  // VERIFICATION PHASE PROCESSING + PROFIT ACCUMULATION FOR ALL ACTIVE
  // =========================================================================
  let verificationFailures = 0;
  ctx.accountStates.forEach(state => {
    if (!state.isActive || state.isCompleted) return;
    
    // Verification phase: check if accounts graduate or fail
    if (state.phase === 'verification' && knobs.verificationMonths > 0) {
      const monthsInVerification = monthIndex - state.verificationStartMonth;
      
      // Monthly hazard of failing verification
      if (knobs.verificationFailRate > 0 && random() < knobs.verificationFailRate) {
        state.isActive = false;
        verificationFailures++;
        return;
      }
      
      // Graduate to funded after verificationMonths
      if (monthsInVerification >= knobs.verificationMonths) {
        state.phase = 'funded';
        // eligibleMonth was already set at creation to account for verification delay
      }
    }
    
    // Accumulate monthly simulated P&L for all active funded accounts
    if (state.phase === 'funded') {
      // Simulate monthly profit: mean ~$200/month with high variance
      // This gives a realistic profit path for the profit-since-last-payout gate
      const monthlyPnl = logNormal(random, 200, 180) * (random() < 0.65 ? 1 : -0.7);
      state.profitSinceLastPayout += monthlyPnl;
      state.monthsSinceLastPayout++;
      
      // Accumulate winning days (~22 trading days/month, ~55% win rate)
      const tradingDaysThisMonth = 22;
      let winningDays = 0;
      for (let d = 0; d < tradingDaysThisMonth; d++) {
        if (random() < 0.55) winningDays++;
      }
      state.winningDaysSinceLastPayout += winningDays;
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
  let velocityGateBlocks = 0;
  
  // Only funded, active, non-completed accounts past eligibility can request payouts
  const eligibleAccounts: AccountState[] = [];
  ctx.accountStates.forEach(state => {
    if (state.isActive && !state.isCompleted && state.phase === 'funded' && monthIndex >= state.eligibleMonth) {
      eligibleAccounts.push(state);
    }
  });
  
  // ── FREEZE PAYOUTS: if freezePayouts is set, skip all payout processing ──
  // Revenue, costs, resets, and lifecycle events still run normally.
  // NOTE: A/B runs are DISTRIBUTIONAL comparisons, not path-coupled counterfactuals.
  // Same seed ⇒ reproducible within a config, but breakers alter control flow and
  // RNG draw count (freeze skips payout RNG), so the two configs produce independent
  // distributions from the same seed — not "same world with/without breaker."
  const payoutsFrozen = knobs.freezePayouts === true;
  
  if (!payoutsFrozen) {
  // Each eligible account has payoutRequestRate chance of requesting this month
  for (const account of eligibleAccounts) {
    if (random() > payoutRequestRate) {
      continue;
    }
    
    // =====================================================================
    // VELOCITY GATES: throttle repeat payout requests (don't block first payouts)
    // =====================================================================
    
    // Gate 1: Minimum winning days since last payout
    if (knobs.minWinningDaysPerPayout > 0 && account.payoutCount > 0) {
      if (account.winningDaysSinceLastPayout < knobs.minWinningDaysPerPayout) {
        velocityGateBlocks++;
        continue;
      }
    }
    
    // Gate 2: Minimum profit since last payout (tracked, not random)
    if (knobs.minProfitSinceLastPayout > 0 && account.payoutCount > 0) {
      if (account.profitSinceLastPayout < knobs.minProfitSinceLastPayout) {
        velocityGateBlocks++;
        continue;
      }
    }
    
    // Gate 3: Minimum months between payouts
    if (knobs.minMonthsBetweenPayouts > 0 && account.payoutCount > 0) {
      if (account.monthsSinceLastPayout < knobs.minMonthsBetweenPayouts) {
        velocityGateBlocks++;
        continue;
      }
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
        completeAccount(account, 'cap', ctx);
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
      
      const capCount = knobs.firstPayoutCap !== null ? (knobs.firstPayoutCapCount ?? 1) : 0;
      const isCapEligible = capCount > 0 && account.payoutCount < capCount;
      
      // Apply first-N payout cap (e.g., Apex: first 5 payouts capped at $2k)
      if (isCapEligible) {
        const beforeCap = traderPayout;
        if (traderPayout > knobs.firstPayoutCap!) {
          traderPayout = knobs.firstPayoutCap!;
          firstPayoutCapHits++;
        }
        // Track after-cap size only (single entry per payout, no double-counting)
        firstPayoutSizes.push(traderPayout);
      }
      
      // Apply lifetime cap using lifetimePaidTotal (per-user, never resets)
      if (lifetimeCap !== null && traderPayout > headroom) {
        const clippedAmount = traderPayout - headroom;
        lifetimeCapClippedAmounts.push(clippedAmount);
        lifetimeCapHits++;
        traderPayout = headroom; // cap to remaining headroom
        
        // Check if this completes the account
        if (account.lifetimePaidTotal + traderPayout >= lifetimeCap) {
          completeAccount(account, 'cap', ctx);
          accountsCompletedThisMonth++;
        }
      }
      
      // Ensure minimum payout threshold ($50)
      if (traderPayout < 50) {
        continue; // Skip payouts below minimum
      }
      
      // =====================================================================
      // HARD GUARD AT COMMIT POINT: Lifetime cap violation check
      // This guard fires right before state updates, catching any path bugs
      // =====================================================================
      if (lifetimeCap !== null && account.lifetimePaidTotal + traderPayout > lifetimeCap + 1e-6) {
        throw new Error(`[Monte Carlo] Lifetime cap violated: account ${account.id} would have ${account.lifetimePaidTotal + traderPayout} but cap is ${lifetimeCap}`);
      }
      
      totalPayouts += traderPayout;
      payoutSizes.push(traderPayout);
      payoutApprovedCount++;
      
      // Update account state - both total and attempt
      account.lifetimePaidTotal += traderPayout;
      account.attemptPaid += traderPayout;
      account.payoutCount++;
      
      // Reset velocity gate counters after successful payout
      account.profitSinceLastPayout = 0;
      account.monthsSinceLastPayout = 0;
      account.winningDaysSinceLastPayout = 0;
    }
  }
  } // end if (!payoutsFrozen)
  
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
  
  // Expected resets = activeCount * monthlyResetProb (for sanity checking)
  const expectedResetsThisMonth = activeCountBeforeLifecycle * monthlyResetProb;
  
  // Net profit - now includes reset revenue
  const netProfit = revenue + resetRevenue - totalPayouts - fraudLoss - chargebacks - variableCosts - fixedCosts;
  
  // =========================================================================
  // INVARIANT: monthlyPnl must NOT appear in platform profit calculation.
  // Platform profit = fees - payouts - costs. Trader P&L only gates eligibility.
  // Assert: profit cannot exceed total revenue (revenue + resetRevenue)
  // =========================================================================
  const totalRevenueThisMonth = revenue + resetRevenue;
  if (netProfit > totalRevenueThisMonth + 1e-6) {
    throw new Error(
      `[Monte Carlo] INVARIANT VIOLATION: netProfit ($${netProfit.toFixed(2)}) exceeds ` +
      `totalRevenue ($${totalRevenueThisMonth.toFixed(2)}) in month ${monthIndex}. ` +
      `This means a non-revenue term is leaking into profit.`
    );
  }
  
  const totalRevenueForPayRev = revenue + resetRevenue;
  const payRevRatio = totalRevenueForPayRev > 0 ? totalPayouts / totalRevenueForPayRev : 0;

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
    expectedResetsThisMonth,
    newPassedAccountsThisMonth: newPassedAccounts,
    // Breaker fields — defaults; overridden by caller when policy is active
    breakerLevel: 0,
    breakerApplied: false,
    payRevRatio,
    payoutsSuppressedByBreaker: 0,
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
  const { iterations, monthsPerIteration, seed = 42, randomSeed = false, breakerPolicy = null } = config;
  
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
  
  // Breaker state collection (one per iteration, only when policy is set)
  const allBreakerStates: BreakerState[] = [];
  
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
    
    // Breaker state for this iteration
    const breakerState = breakerPolicy ? createBreakerState() : null;
    const payRevHistory: number[] = [];
    
    for (let month = 0; month < monthsPerIteration; month++) {
      // ── BREAKER POLICY: evaluate and apply knob overrides ──────────
      let monthAssumptions = effectiveAssumptions;
      let breakerApplied = false;
      
      if (breakerPolicy && breakerState) {
        // Rolling avg uses only COMPLETED months (reactive policy)
        const rollingPayRevAvg3Prev = computeRollingPayRevAvg3Prev(payRevHistory);
        
        // Hysteresis counters are updated INSIDE evaluate() (policy-owned)
        const evaluation = breakerPolicy.evaluate({
          monthIndex: month,
          rollingPayRevAvg3Prev,
          currentLevel: breakerState.level,
          state: breakerState,
        });
        
        // Record transition
        if (evaluation.nextLevel !== breakerState.level) {
          breakerState.events.push({
            monthIndex: month,
            fromLevel: breakerState.level,
            toLevel: evaluation.nextLevel,
            reason: evaluation.reason,
            knobOverrides: evaluation.knobOverrides,
          });
        }
        
        breakerState.level = evaluation.nextLevel;
        breakerState.levelByMonth.push(evaluation.nextLevel);
        
        // breakerApplied = true whenever level != 0 (L1 or L2)
        breakerApplied = evaluation.nextLevel !== 0;
        
        // Apply knob overrides for L1
        if (evaluation.knobOverrides && evaluation.nextLevel === 1) {
          monthAssumptions = {
            ...effectiveAssumptions,
            knobs: { ...effectiveAssumptions.knobs, ...evaluation.knobOverrides },
          };
        }
        
        // L2 = freeze: pass explicit freezePayouts flag (not zeroing request rate)
        if (evaluation.nextLevel === 2) {
          monthAssumptions = {
            ...effectiveAssumptions,
            knobs: { ...effectiveAssumptions.knobs, freezePayouts: true },
          };
        }
      }
      
      const result = simulateMonth(monthAssumptions, random, ctx, month);
      
      // ── Stamp breaker metadata onto result ─────────────────────────
      if (breakerState) {
        result.breakerLevel = breakerState.level;
        result.breakerApplied = breakerApplied;
        
        // Count suppressed requests and estimate suppressed dollars at L2
        if (breakerState.level === 2) {
          // Requests suppressed: eligible cohort × baseline request rate mode
          const suppressedRequests = Math.round(
            result.eligibleCohortSize * effectiveAssumptions.payoutRequestRate.mode
          );
          result.payoutsSuppressedByBreaker = suppressedRequests;
          breakerState.requestsSuppressedByBreaker += suppressedRequests;
          
          // Shadow-mode dollar estimate: suppressed requests × expected payout size × split
          // Clip factors are named constants, not magic numbers — visible in diagnostics.
          const SUPPRESSED_CLIP_FIRST_CAP = 0.75;  // conservative: first-payout cap + lifetime cap clipping
          const SUPPRESSED_CLIP_NO_FIRST_CAP = 0.90; // no first-payout cap
          if (import.meta.env.DEV && month === 0 && iter === 0) {
            console.info(`[Breaker] Suppressed $ clip factor: ${effectiveAssumptions.knobs.firstPayoutCap !== null ? SUPPRESSED_CLIP_FIRST_CAP : SUPPRESSED_CLIP_NO_FIRST_CAP} (firstPayoutCap: ${effectiveAssumptions.knobs.firstPayoutCap})`);
          }
          const expectedPayoutSize = effectiveAssumptions.avgPayoutAmount.mean *
            effectiveAssumptions.knobs.payoutSplitPercent;
          const capClipFactor = effectiveAssumptions.knobs.firstPayoutCap !== null
            ? SUPPRESSED_CLIP_FIRST_CAP : SUPPRESSED_CLIP_NO_FIRST_CAP;
          const suppressedDollars = suppressedRequests * expectedPayoutSize * capClipFactor;
          breakerState.dollarsSuppressedByBreaker += suppressedDollars;
        }
      }
      
      // Track Pay/Rev for rolling window
      payRevHistory.push(result.payRevRatio);
      
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
    
    if (breakerState) allBreakerStates.push(breakerState);
    
    allMonthlyProfits.push(monthProfits);
    allMonthResults.push(monthResults);
    
    // =========================================================================
    // AGGREGATE ACCOUNT STATS FROM REAL ITERATION DATA (no biased re-run!)
    // =========================================================================
    const lifetimeCap = effectiveAssumptions.knobs.lifetimeCapPerUser;
    let accountsHitCap = 0;  // ONLY counts accounts completed by hitting cap, not zombies
    let totalLifetimePaid = 0;
    let totalHeadroom = 0;
    const lifetimePaidValues: number[] = [];
    
    ctx.accountStates.forEach(state => {
      lifetimePaidValues.push(state.lifetimePaidTotal);
      totalLifetimePaid += state.lifetimePaidTotal;
      
      // CRITICAL: Only count cap-hit completions, not zombies or other exits
      if (state.completedByCapHit) {
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
  const totalExpectedResets = allResults.reduce((s, r) => s + r.expectedResetsThisMonth, 0);
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
  const totalEverCompletedAcrossIterations = allIterationStats.reduce((s, i) => s + i.totalEverCompleted, 0);
  const totalLifetimePaidSum = allIterationStats.reduce((s, i) => s + i.totalLifetimePaid, 0);
  const totalHeadroomSum = allIterationStats.reduce((s, i) => s + i.totalHeadroomAtEnd, 0);
  
  // Cap-hit share of all completions (future-proof for any completion reason)
  const capHitShareOfCompletions = totalEverCompletedAcrossIterations > 0
    ? totalAccountsCompletedByCap / totalEverCompletedAcrossIterations
    : 0;
  
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
  
  // =========================================================================
  // GLOBAL INVARIANT: annualized profit must not exceed annualized revenue
  // This catches any systematic accounting leak across the full simulation
  // =========================================================================
  const annualizedProfit = mean * 12;
  const annualizedRevenue = avgTotalRevenue * 12;
  if (annualizedProfit > annualizedRevenue + 1) {
    throw new Error(
      `[Monte Carlo] GLOBAL INVARIANT VIOLATION: annualized profit ($${annualizedProfit.toFixed(0)}) ` +
      `exceeds annualized revenue ($${annualizedRevenue.toFixed(0)}). ` +
      `Accounting leak detected.`
    );
  }
  
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
      
      // Cap pressure: avgLifetimePaid / cap (only meaningful if cap set)
      capPressure: effectiveAssumptions.knobs.lifetimeCapPerUser !== null 
        ? avgLifetimePaidPerAccount / effectiveAssumptions.knobs.lifetimeCapPerUser 
        : null,
    },
    cohortDiagnostics: {
      avgActiveCohortSize,
      avgEligibleCohortSize,
      activeCohortSizeByMonth,
      eligibleCohortSizeByMonth,
      payoutToRevenueRatioByMonth,
      resetRevenue: totalResetRevenue,
      resetsThisRun: totalResets,
      expectedResetsThisRun: totalExpectedResets,
      resetRateErrorRatio: totalExpectedResets > 0 ? totalResets / totalExpectedResets : 1,
      zombieAccountsCompleted: totalZombieAccountsCompleted,
      resetScope: 'allActive' as const,
      fraudScaling: 'perEligibleAccount' as const,
      chargebackScaling: 'perNewSalesRevenue' as const,
      
      // Per-month event series for steady-state analysis (from last iteration)
      capHitsByMonth: lastIterResults.map(r => r.payoutDetails.accountsCompletedByCap),
      zombiesByMonth: lastIterResults.map(r => r.payoutDetails.zombieAccountsCompleted),
      resetsByMonth: lastIterResults.map(r => r.resetsThisMonth),
      newPassedByMonth: lastIterResults.map(r => r.newPassedAccountsThisMonth),
      
      // Completion breakdown: cap-hit share of ALL completions (not just cap+zombie)
      capHitShareOfCompletions,
    },
    rawSamples: allMonthlyProfits,
    rawMonthResults: allMonthResults,
    breakerDiagnostics: breakerPolicy && allBreakerStates.length > 0
      ? aggregateBreakerDiagnostics(breakerPolicy, allBreakerStates)
      : undefined,
  };
}

// ============================================================================
// DEFAULT ASSUMPTIONS (from your analysis)
// ============================================================================

export const DEFAULT_ASSUMPTIONS: MonteCarloAssumptions = {
  // Acquisition
  accountsPerMonth: 500,
  pricePerAccount: 149, // Starter tier

  // Trading funnel — CALIBRATED TO INDUSTRY REALITY (2026-03-02)
  // Industry pass rates: 5-10% (QuantVPS, Tradeify, Topstep benchmarks)
  // Payout request: only 20-30% of funded traders ever withdraw
  // Repeat withdrawal: even fewer request again after first payout
  passRate: { min: 0.04, mode: 0.07, max: 0.12 },
  payoutRequestRate: { min: 0.15, mode: 0.25, max: 0.40 },
  avgDaysToFirstPayout: 25,

  // Payout behavior — conservative; most funded traders withdraw small
  avgPayoutAmount: { mean: 350, stdDev: 120 },
  payoutsPerPaidAccountPerMonth: { min: 0.4, mode: 0.7, max: 1.2 },

  // Abuse & friction
  fraudAttemptRate: { min: 0.04, mode: 0.07, max: 0.12 },
  fraudSuccessRate: { min: 0.004, mode: 0.008, max: 0.015 },
  chargebackRate: { min: 0.015, mode: 0.025, max: 0.04 },
  resetRate: 0.18,

  // Costs
  variableCostPerAccount: 8,
  fixedMonthlyCosts: 18000,

  // V1 BALANCED CONFIG (frozen 2026-03-02)
  // $500 first payout cap, 10× lifetime cap, 14-day cooldown, 7-day eligibility delay
  // Velocity gates ENABLED: min 10 winning days + 1 month between payouts
  knobs: {
    firstPayoutCap: 500,            // $500 first payout cap (trader receives)
    firstPayoutCapCount: 1,         // applies to first payout only
    payoutSplitPercent: 0.80,       // 80% to trader
    maxPayoutPercent: 0.80,         // max 80% of profits
    resetPrice: 99,                 // $99 reset
    lifetimeCapPerUser: 149 * 10,   // 10× entry fee = $1,490 (V1 balanced)
    attackIntensity: 0,             // no attack scenario
    minWinningDaysPerPayout: 10,    // min 10 winning days between payouts (industry norm)
    minProfitSinceLastPayout: 0,    // disabled — winning days gate is sufficient
    minMonthsBetweenPayouts: 1,     // min 1 month between payouts (payout window)
    verificationMonths: 0,          // disabled by default (no verification phase)
    verificationFailRate: 0,        // no verification failures
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
      lifetimeCapPerUser: 149 * 10, // 10× entry = $1,490 (V1 default)
    },
  },
  
  // Velocity gate scenarios
  withVelocityGate5d: {
    ...DEFAULT_ASSUMPTIONS,
    knobs: {
      ...DEFAULT_ASSUMPTIONS.knobs,
      minWinningDaysPerPayout: 15,
    },
  },
  
  withProfitGate: {
    ...DEFAULT_ASSUMPTIONS,
    knobs: {
      ...DEFAULT_ASSUMPTIONS.knobs,
      minProfitSinceLastPayout: 300,
    },
  },
  
  withProfitGate_2mo: {
    ...DEFAULT_ASSUMPTIONS,
    knobs: {
      ...DEFAULT_ASSUMPTIONS.knobs,
      minProfitSinceLastPayout: 300,
      minMonthsBetweenPayouts: 2,
    },
  },
  
  withVerification1mo: {
    ...DEFAULT_ASSUMPTIONS,
    knobs: {
      ...DEFAULT_ASSUMPTIONS.knobs,
      verificationMonths: 1,
      verificationFailRate: 0.15,
    },
  },
  
  withVerification2mo: {
    ...DEFAULT_ASSUMPTIONS,
    knobs: {
      ...DEFAULT_ASSUMPTIONS.knobs,
      verificationMonths: 2,
      verificationFailRate: 0.15,
    },
  },
  
  withFullGateStack: {
    ...DEFAULT_ASSUMPTIONS,
    knobs: {
      ...DEFAULT_ASSUMPTIONS.knobs,
      minProfitSinceLastPayout: 300,
      minMonthsBetweenPayouts: 2,
      verificationMonths: 1,
      verificationFailRate: 0.15,
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
