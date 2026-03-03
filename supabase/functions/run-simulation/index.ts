import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
}

// ============================================================================
// TYPES
// ============================================================================

interface SimulationRequest {
  iterations?: number
  months?: number
  seed?: number
  reserve_threshold?: number
  overrides?: Partial<SimAssumptions>
  force_iterations?: boolean
}

interface CohortConfig {
  id: string; name: string; cohort_phase: string
  entry_fee: number | null; payout_split_percent: number
  first_payout_cap_amount: number | null; lifetime_cap_multiple: number | null
  max_payout_percent: number; max_payout_absolute: number | null
  payout_cooldown_days: number; payout_eligibility_delay_days: number
  min_trading_days_between_payouts: number; min_winning_days_between_payouts: number | null
  min_profit_buffer: number | null; profit_target_percent: number
  max_daily_loss_percent: number; max_total_drawdown_percent: number
  max_daily_profit_cap_percent: number | null; min_profitable_days: number
}

interface SimAssumptions {
  accountsPerMonth: number; pricePerAccount: number
  passRate: { min: number; mode: number; max: number }
  payoutRequestRate: { min: number; mode: number; max: number }
  avgDaysToFirstPayout: number
  avgPayoutAmount: { mean: number; stdDev: number }
  payoutsPerPaidAccountPerMonth: { min: number; mode: number; max: number }
  fraudAttemptRate: { min: number; mode: number; max: number }
  fraudSuccessRate: { min: number; mode: number; max: number }
  chargebackRate: { min: number; mode: number; max: number }
  resetRate: number; variableCostPerAccount: number; fixedMonthlyCosts: number
  knobs: SimKnobs
}

interface SimKnobs {
  firstPayoutCap: number | null; payoutSplitPercent: number
  maxPayoutPercent: number; resetPrice: number
  lifetimeCapPerUser: number | null; attackIntensity: number
  minWinningDaysPerPayout: number; minProfitSinceLastPayout: number
  minMonthsBetweenPayouts: number; verificationMonths: number
  verificationFailRate: number
  /** Monthly payout budget as fraction of revenue. null = disabled (no soft pacing). */
  targetPayRevSoft: number | null
  /** Pay/Rev threshold to engage budgeting. null = always-on when targetPayRevSoft set. */
  payRevEngageThreshold: number | null
}

interface AccountState {
  id: number
  createdMonth: number
  eligibleMonth: number
  lifetimePaidTotal: number
  attemptPaid: number
  payoutCount: number
  cleanPayoutCount: number  // tracks clean payouts for ladder split modeling
  resetCount: number
  isCompleted: boolean
  isActive: boolean
  completedByCapHit: boolean
  profitSinceLastPayout: number
  monthsSinceLastPayout: number
  winningDaysSinceLastPayout: number
  phase: 'verification' | 'funded'
  verificationStartMonth: number
}

// Ladder split tiers — must match ladder-spec.ts
// At N clean payouts, split upgrades. This models real payout outflow increase.
const LADDER_SPLITS: Array<{ cleanPayoutsRequired: number; splitPercent: number }> = [
  { cleanPayoutsRequired: 0, splitPercent: 0.80 },
  { cleanPayoutsRequired: 3, splitPercent: 0.82 },
  { cleanPayoutsRequired: 6, splitPercent: 0.85 },
]

function getLadderSplit(cleanPayoutCount: number, baseSplit: number): number {
  let split = baseSplit
  for (const tier of LADDER_SPLITS) {
    if (cleanPayoutCount >= tier.cleanPayoutsRequired) {
      split = Math.max(split, tier.splitPercent)
    }
  }
  return split
}

interface SimulateMonthContext {
  accountStates: Map<number, AccountState>
  nextAccountId: number
  totalEverCreated: number
  totalEverCompleted: number
  totalPassedAccounts: number // NEW: track total passed for diagnostics
}

interface CohortState {
  eligiblePool: number
  firstPayoutPool: number
  monthsActive: number
  totalPaid: number
  totalAccounts: number
}

// ============================================================================
// PRE-SAMPLED MACRO DRAWS (shared between engines for cross-check)
// ============================================================================

interface MacroDraws {
  passRate: number
  payoutReqRate: number
  fraudAttemptRate: number
  fraudSuccessRate: number
  chargebackRate: number
  payoutsPerAcct: number
  // NOTE: payout amounts are NOT shared at macro level.
  // Each engine draws its own per-payout lognormal to preserve fat tails.
  // Only rates are shared to isolate accounting-logic differences in cross-check.
}

/** Pre-sample ONLY macro rates (shared between engines for cross-check).
 *  Payout/fraud dollar amounts are NOT pre-sampled — each engine draws its own
 *  per-payout lognormal to preserve fat-tail behavior. */
function preSampleMacroDraws(
  random: () => number,
  months: number,
  assumptions: SimAssumptions,
): MacroDraws[] {
  const draws: MacroDraws[] = []
  for (let m = 0; m < months; m++) {
    // Always use true triangular for both engines.
    // Cross-check compares accounting logic, not distribution shape.
    draws.push({
      passRate: triangular(random, assumptions.passRate.min, assumptions.passRate.mode, assumptions.passRate.max),
      payoutReqRate: triangular(random, assumptions.payoutRequestRate.min, assumptions.payoutRequestRate.mode, assumptions.payoutRequestRate.max),
      fraudAttemptRate: triangular(random, assumptions.fraudAttemptRate.min, assumptions.fraudAttemptRate.mode, assumptions.fraudAttemptRate.max),
      fraudSuccessRate: triangular(random, assumptions.fraudSuccessRate.min, assumptions.fraudSuccessRate.mode, assumptions.fraudSuccessRate.max),
      chargebackRate: triangular(random, assumptions.chargebackRate.min, assumptions.chargebackRate.mode, assumptions.chargebackRate.max),
      payoutsPerAcct: triangular(random, assumptions.payoutsPerPaidAccountPerMonth.min, assumptions.payoutsPerPaidAccountPerMonth.mode, assumptions.payoutsPerPaidAccountPerMonth.max),
    })
  }
  return draws
}

// ============================================================================
// SEEDED PRNG (Mulberry32)
// ============================================================================

function mulberry32(seed: number): () => number {
  return function () {
    let t = seed += 0x6D2B79F5
    t = Math.imul(t ^ t >>> 15, t | 1)
    t ^= t + Math.imul(t ^ t >>> 7, t | 61)
    return ((t ^ t >>> 14) >>> 0) / 4294967296
  }
}

// ============================================================================
// DISTRIBUTIONS
// ============================================================================

function normal(random: () => number): number {
  const u1 = random() || 1e-10
  const u2 = random()
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
}

/** True inverse-CDF triangular distribution */
function triangular(random: () => number, min: number, mode: number, max: number): number {
  const u = random()
  const fc = (mode - min) / (max - min)
  if (u < fc) return min + Math.sqrt(u * (max - min) * (mode - min))
  return max - Math.sqrt((1 - u) * (max - min) * (max - mode))
}

/** Normal-approximated triangular (LEGACY — only used in shadow cross-check) */
function triangularDrawLegacy(random: () => number, min: number, mode: number, max: number): number {
  const mean = (min + mode + max) / 3
  const variance = (min * min + mode * mode + max * max - min * mode - min * max - mode * max) / 18
  const result = mean + Math.sqrt(variance) * normal(random)
  return Math.max(min, Math.min(max, result))
}

function logNormalDraw(random: () => number, mean: number, stdDev: number): number {
  const variance = stdDev * stdDev
  const mu = Math.log(mean * mean / Math.sqrt(variance + mean * mean))
  const sigma = Math.sqrt(Math.log(1 + variance / (mean * mean)))
  return Math.exp(mu + sigma * normal(random))
}

// ============================================================================
// ATTACK INTENSITY MODIFIERS
// ============================================================================

function applyAttackIntensity(assumptions: SimAssumptions): SimAssumptions {
  const intensity = assumptions.knobs.attackIntensity
  if (intensity <= 0) return assumptions

  const m = JSON.parse(JSON.stringify(assumptions)) as SimAssumptions
  const s = (base: number, mult: number, cap: number) => Math.min(base * (1 + mult * intensity), cap)

  m.passRate = { min: s(m.passRate.min, 0.5, 0.35), mode: s(m.passRate.mode, 0.5, 0.40), max: s(m.passRate.max, 0.5, 0.50) }
  m.fraudAttemptRate = { min: s(m.fraudAttemptRate.min, 1.0, 0.40), mode: s(m.fraudAttemptRate.mode, 1.0, 0.50), max: s(m.fraudAttemptRate.max, 1.0, 0.60) }
  m.fraudSuccessRate = { min: s(m.fraudSuccessRate.min, 0.5, 0.08), mode: s(m.fraudSuccessRate.mode, 0.5, 0.10), max: s(m.fraudSuccessRate.max, 0.5, 0.15) }
  m.chargebackRate = { min: s(m.chargebackRate.min, 0.6, 0.08), mode: s(m.chargebackRate.mode, 0.6, 0.10), max: s(m.chargebackRate.max, 0.6, 0.12) }
  m.avgPayoutAmount = { mean: m.avgPayoutAmount.mean * (1 + 0.3 * intensity), stdDev: m.avgPayoutAmount.stdDev * (1 + 0.3 * intensity) }
  return m
}

// ============================================================================
// COHORT → ASSUMPTIONS MAPPER
// ============================================================================

function cohortToAssumptions(cohorts: CohortConfig[], overrides?: Partial<SimAssumptions>): SimAssumptions {
  const perfCohort = cohorts.find(c => c.cohort_phase === 'performance') || cohorts[0]
  const evalCohort = cohorts.find(c => c.cohort_phase === 'evaluation') || cohorts[0]
  const entryFee = evalCohort?.entry_fee ?? 149

  const base: SimAssumptions = {
    accountsPerMonth: 500,
    pricePerAccount: entryFee,
    passRate: { min: 0.08, mode: 0.12, max: 0.18 },
    payoutRequestRate: { min: 0.55, mode: 0.65, max: 0.75 },
    avgDaysToFirstPayout: perfCohort?.payout_eligibility_delay_days ?? 7,
    avgPayoutAmount: { mean: 420, stdDev: 150 },
    payoutsPerPaidAccountPerMonth: { min: 0.8, mode: 1.2, max: 1.8 },
    fraudAttemptRate: { min: 0.04, mode: 0.07, max: 0.12 },
    fraudSuccessRate: { min: 0.004, mode: 0.008, max: 0.015 },
    chargebackRate: { min: 0.015, mode: 0.025, max: 0.04 },
    resetRate: 0.18,
    variableCostPerAccount: 8,
    fixedMonthlyCosts: 18000,
    knobs: {
      firstPayoutCap: perfCohort?.first_payout_cap_amount ?? 300,
      payoutSplitPercent: (perfCohort?.payout_split_percent ?? 80) / 100,
      maxPayoutPercent: (perfCohort?.max_payout_percent ?? 80) / 100,
      resetPrice: 99,
      // HARD FLOOR: Lifetime cap can never exceed the production baseline (10×
      // entry fee), even if cohort config is misconfigured or a "promo"
      // experiment sets it higher.  Lower caps are fine.
      // NOTE: Must match TIERS[].lifetimeCapMultiple in pricing-data.ts.
      // Previous value (7×) understated tail risk — fixed 2026-03-03.
      lifetimeCapPerUser: perfCohort?.lifetime_cap_multiple != null
        ? Math.min(entryFee * perfCohort.lifetime_cap_multiple, entryFee * 10)
        : null,
      attackIntensity: 0,
      minWinningDaysPerPayout: perfCohort?.min_winning_days_between_payouts ?? 0,
      minProfitSinceLastPayout: perfCohort?.min_profit_buffer ?? 0,
      minMonthsBetweenPayouts: Math.ceil((perfCohort?.payout_cooldown_days ?? 30) / 30),
      verificationMonths: cohorts.some(c => c.cohort_phase === 'verification') ? 1 : 0,
      verificationFailRate: 0.15,
      targetPayRevSoft: null,  // disabled by default — enable via preset/override
      payRevEngageThreshold: null, // null = always-on when targetPayRevSoft set
    },
  }

  if (overrides) return { ...base, ...overrides, knobs: { ...base.knobs, ...overrides.knobs } }
  return base
}

// ============================================================================
// ACCOUNT COMPLETION HELPER
// ============================================================================

function completeAccount(state: AccountState, reason: 'cap' | 'zombie', ctx: SimulateMonthContext): void {
  if (state.isCompleted) return
  state.isCompleted = true
  state.isActive = false
  state.completedByCapHit = reason === 'cap'
  ctx.totalEverCompleted++
}

// ============================================================================
// PER-ACCOUNT SIMULATION ENGINE (HIGH FIDELITY)
// ============================================================================

interface MonthResult {
  netProfit: number
  payoutDollars: number      // total $ paid to traders
  payoutCount: number        // total individual payouts approved
  payoutRequests: number     // total payout attempts (before gates/caps)
  capCompletions: number     // accounts fully exhausting cap
  capClips: number           // payouts clipped to remaining headroom
  capRejections: number      // payouts rejected (headroom <= 0)
  totalAccounts: number
  eligiblePool: number
  firstPayoutPool: number
  zombieCompletions: number
  resets: number
  // Revenue/cost breakdown for auditability
  revenueBreakdown: { entry: number; resets: number; total: number }
  costBreakdown: { payouts: number; fraud: number; chargebacks: number; variable: number; fixed: number; total: number }
  // Payout budgeting (soft pacing) diagnostics
  deferredPayoutDollars: number
  deferredPayoutRequests: number
  // Ladder split evidence
  ladderSplits: number[]     // all effective splits used this month
  // "Ever reached" milestone crossings this month
  newlyReachedPro: number    // accounts that crossed cleanPayoutCount == 3 this month
  newlyReachedElite: number  // accounts that crossed cleanPayoutCount == 6 this month
}

function simulateMonthPerAccount(
  assumptions: SimAssumptions,
  random: () => number,       // micro RNG (per-account events)
  ctx: SimulateMonthContext,
  monthIndex: number,
  macro?: MacroDraws,         // pre-sampled macro draws (for cross-check)
): MonthResult {
  const { knobs } = assumptions

  const revenue = assumptions.accountsPerMonth * assumptions.pricePerAccount

  // Use pre-sampled macro draws if provided, otherwise sample fresh
  const passRate = macro?.passRate ?? triangular(random, assumptions.passRate.min, assumptions.passRate.mode, assumptions.passRate.max)
  const payoutReqRate = macro?.payoutReqRate ?? triangular(random, assumptions.payoutRequestRate.min, assumptions.payoutRequestRate.mode, assumptions.payoutRequestRate.max)
  const fraudAttemptRate = macro?.fraudAttemptRate ?? triangular(random, assumptions.fraudAttemptRate.min, assumptions.fraudAttemptRate.mode, assumptions.fraudAttemptRate.max)
  const fraudSuccessRate = macro?.fraudSuccessRate ?? triangular(random, assumptions.fraudSuccessRate.min, assumptions.fraudSuccessRate.mode, assumptions.fraudSuccessRate.max)
  const chargebackRate = macro?.chargebackRate ?? triangular(random, assumptions.chargebackRate.min, assumptions.chargebackRate.mode, assumptions.chargebackRate.max)
  const payoutsPerAcct = macro?.payoutsPerAcct ?? triangular(random, assumptions.payoutsPerPaidAccountPerMonth.min, assumptions.payoutsPerPaidAccountPerMonth.mode, assumptions.payoutsPerPaidAccountPerMonth.max)

  // --- New accounts ---
  const newPassed = Math.round(assumptions.accountsPerMonth * passRate)
  const eligibilityLag = Math.ceil(assumptions.avgDaysToFirstPayout / 30)
  const useVerification = knobs.verificationMonths > 0

  for (let i = 0; i < newPassed; i++) {
    const id = ctx.nextAccountId++
    ctx.accountStates.set(id, {
      id,
      createdMonth: monthIndex,
      eligibleMonth: useVerification
        ? monthIndex + eligibilityLag + knobs.verificationMonths
        : monthIndex + eligibilityLag,
      lifetimePaidTotal: 0,
      attemptPaid: 0,
      payoutCount: 0,
      cleanPayoutCount: 0,
      resetCount: 0,
      isCompleted: false,
      isActive: true,
      completedByCapHit: false,
      profitSinceLastPayout: 0,
      monthsSinceLastPayout: 0,
      winningDaysSinceLastPayout: 0,
      phase: useVerification ? 'verification' : 'funded',
      verificationStartMonth: monthIndex,
    })
    ctx.totalEverCreated++
    ctx.totalPassedAccounts++
  }

  // --- Lifecycle: resets, zombies ---
  const lifetimeCap = knobs.lifetimeCapPerUser
  const monthlyResetProb = 1 - Math.pow(1 - assumptions.resetRate, 1 / 12)
  let resetsThisMonth = 0
  let resetRevenue = 0
  let zombieCompletions = 0
  const toRemove: number[] = []

  ctx.accountStates.forEach((state, id) => {
    if (!state.isActive || state.isCompleted) {
      // Prune completed/inactive accounts to keep Map small
      toRemove.push(id)
      return
    }

    // Zombie check: headroom < $50
    if (lifetimeCap !== null) {
      const headroom = lifetimeCap - state.lifetimePaidTotal
      if (headroom > 0 && headroom < 50) {
        completeAccount(state, 'zombie', ctx)
        zombieCompletions++
        toRemove.push(id)
        return
      }
    }

    // Reset hazard
    if (random() < monthlyResetProb) {
      resetsThisMonth++
      resetRevenue += knobs.resetPrice
      state.attemptPaid = 0
      state.payoutCount = 0
      state.resetCount++
      state.eligibleMonth = monthIndex + eligibilityLag
      state.profitSinceLastPayout = 0
      state.monthsSinceLastPayout = 0
      state.winningDaysSinceLastPayout = 0
    }
  })
  // Prune dead accounts from Map
  for (const id of toRemove) ctx.accountStates.delete(id)

  // --- Verification + PnL accumulation ---
  ctx.accountStates.forEach(state => {
    if (!state.isActive || state.isCompleted) return

    if (state.phase === 'verification' && knobs.verificationMonths > 0) {
      if (knobs.verificationFailRate > 0 && random() < knobs.verificationFailRate) {
        state.isActive = false
        return
      }
      if (monthIndex - state.verificationStartMonth >= knobs.verificationMonths) {
        state.phase = 'funded'
      }
    }

    if (state.phase === 'funded') {
      const monthlyPnl = logNormalDraw(random, 200, 180) * (random() < 0.65 ? 1 : -0.7)
      state.profitSinceLastPayout += monthlyPnl
      state.monthsSinceLastPayout++

      // Binomial approximation for winning days (replaces 22 individual random() calls)
      // For n=22, p=0.55: mean=12.1, stddev=2.33
      // Use normal approximation + round + clamp
      const winningDays = Math.max(0, Math.min(22, Math.round(12.1 + 2.33 * normal(random))))
      state.winningDaysSinceLastPayout += winningDays
    }
  })

  // --- Payouts ---
  let payoutDollars = 0
  let payoutCount = 0
  let payoutRequests = 0
  let capCompletions = 0
  let capClips = 0
  let capRejections = 0
  let deferredPayoutDollars = 0
  let deferredPayoutRequests = 0
  const monthLadderSplits: number[] = []
  let newlyReachedPro = 0
  let newlyReachedElite = 0

  // Payout budget (conditional pacing): only engages when month is "hot"
  const monthTotalRevenue = revenue + resetRevenue
  const payoutBudget = knobs.targetPayRevSoft != null
    ? monthTotalRevenue * knobs.targetPayRevSoft
    : Infinity
  // Engagement uses RUNNING RATIO (payoutDollars / revenue), not absolute dollars.
  // This prevents premature engagement from a single large payout.
  const engageRatio = knobs.payRevEngageThreshold ?? 0  // 0 = always-on when targetPayRevSoft set
  let budgetEngaged = knobs.targetPayRevSoft == null ? false : (engageRatio <= 0)

  const eligibleAccounts: AccountState[] = []
  ctx.accountStates.forEach(state => {
    if (state.isActive && !state.isCompleted && state.phase === 'funded' && monthIndex >= state.eligibleMonth) {
      eligibleAccounts.push(state)
    }
  })

  // Priority sort: oldest unpaid first (fairness), with seeded shuffle as tie-breaker
  // First shuffle for randomness, then stable-sort by priority
  for (let i = eligibleAccounts.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    const tmp = eligibleAccounts[i]
    eligibleAccounts[i] = eligibleAccounts[j]
    eligibleAccounts[j] = tmp
  }
  // Stable sort: accounts waiting longest get paid first when budget is active
  eligibleAccounts.sort((a, b) => b.monthsSinceLastPayout - a.monthsSinceLastPayout)

  for (const account of eligibleAccounts) {
    if (random() > payoutReqRate) continue

    // Velocity gate 1: winning days
    if (knobs.minWinningDaysPerPayout > 0 && account.payoutCount > 0) {
      if (account.winningDaysSinceLastPayout < knobs.minWinningDaysPerPayout) continue
    }
    // Velocity gate 2: profit since last payout
    if (knobs.minProfitSinceLastPayout > 0 && account.payoutCount > 0) {
      if (account.profitSinceLastPayout < knobs.minProfitSinceLastPayout) continue
    }
    // Velocity gate 3: months between payouts
    if (knobs.minMonthsBetweenPayouts > 0 && account.payoutCount > 0) {
      if (account.monthsSinceLastPayout < knobs.minMonthsBetweenPayouts) continue
    }

    // Soft throttle: when budget is engaged, cap numPayouts to 1 per account
    const maxPayoutsThisAccount = budgetEngaged ? 1 : Math.max(1, Math.round(payoutsPerAcct))
    for (let j = 0; j < maxPayoutsThisAccount; j++) {
      payoutRequests++

      const headroom = lifetimeCap !== null ? lifetimeCap - account.lifetimePaidTotal : Infinity
      if (headroom <= 0) {
        capRejections++
        completeAccount(account, 'cap', ctx)
        capCompletions++
        continue
      }

      // Always draw per-payout lognormal from micro RNG to preserve fat tails
      const rawPayout = logNormalDraw(random, assumptions.avgPayoutAmount.mean, assumptions.avgPayoutAmount.stdDev)
      // Use ladder-aware split: accounts with more clean payouts get higher splits
      const effectiveSplit = getLadderSplit(account.cleanPayoutCount, knobs.payoutSplitPercent)
      let traderPayout = rawPayout * effectiveSplit

      // First payout cap
      if (account.payoutCount === 0 && knobs.firstPayoutCap !== null) {
        traderPayout = Math.min(traderPayout, knobs.firstPayoutCap)
      }

      // Lifetime cap clip
      if (lifetimeCap !== null && traderPayout > headroom) {
        traderPayout = headroom
        capClips++
      }

      // Min $50 threshold
      if (traderPayout < 50) continue

      // CONDITIONAL BUDGET CHECK: engage when running pay/rev RATIO crosses threshold
      // Using ratio instead of absolute dollars prevents premature engagement from
      // a single large payout in a high-revenue month.
      if (knobs.targetPayRevSoft != null && !budgetEngaged && monthTotalRevenue > 0) {
        const runningPayRev = (payoutDollars + traderPayout) / monthTotalRevenue
        if (runningPayRev > engageRatio) {
          budgetEngaged = true
        }
      }

      // PAYOUT BUDGET CHECK (hard ceiling — only when engaged)
      if (budgetEngaged && payoutDollars + traderPayout > payoutBudget && knobs.targetPayRevSoft != null) {
        deferredPayoutRequests++
        deferredPayoutDollars += traderPayout
        continue  // deferred — account retries next month naturally
      }

      // Hard guard
      if (lifetimeCap !== null && account.lifetimePaidTotal + traderPayout > lifetimeCap + 1e-6) {
        throw new Error(`Lifetime cap violated: account ${account.id}`)
      }

      payoutDollars += traderPayout
      payoutCount++
      monthLadderSplits.push(effectiveSplit)
      account.lifetimePaidTotal += traderPayout
      account.attemptPaid += traderPayout
      account.payoutCount++
      // In the sim, all executed payouts are "clean" — deferrals already
      // `continue` above and never reach here. L2 freeze blocks payouts
      // entirely (not modeled as partial). This matches the production
      // definition: clean is evaluated at paid_confirmed time.
      account.cleanPayoutCount++
      // Track milestone crossings for "ever reached" evidence
      if (account.cleanPayoutCount === 3) newlyReachedPro++
      if (account.cleanPayoutCount === 6) newlyReachedElite++

      // Reset velocity counters
      account.profitSinceLastPayout = 0
      account.monthsSinceLastPayout = 0
      account.winningDaysSinceLastPayout = 0

      // Check if cap-complete after payout
      if (lifetimeCap !== null && account.lifetimePaidTotal >= lifetimeCap - 1e-6) {
        completeAccount(account, 'cap', ctx)
        capCompletions++
      }
    }
  }

  // --- Fraud & chargebacks ---
  // Fraud payout always drawn from micro RNG (not macro-shared)
  const fraudPayoutBase = logNormalDraw(random, assumptions.avgPayoutAmount.mean * 1.3, assumptions.avgPayoutAmount.stdDev * 1.5)
  const fraudLoss = eligibleAccounts.length * fraudAttemptRate * fraudSuccessRate * fraudPayoutBase * knobs.payoutSplitPercent
  const chargebacks = revenue * chargebackRate
  const variableCosts = assumptions.accountsPerMonth * assumptions.variableCostPerAccount
  const fixedCosts = assumptions.fixedMonthlyCosts

  const totalRevenue = revenue + resetRevenue
  const totalCosts = payoutDollars + fraudLoss + chargebacks + variableCosts + fixedCosts
  const netProfit = totalRevenue - totalCosts

  // ACCOUNTING INVARIANT: netProfit can never exceed totalRevenue.
  // Violation means costs went negative (silent corruption). Fail loudly.
  if (netProfit > totalRevenue + 1e-6) {
    throw new Error(`ACCOUNTING_INVARIANT_VIOLATION: netProfit (${netProfit.toFixed(2)}) > totalRevenue (${totalRevenue.toFixed(2)}) in month ${monthIndex}`)
  }

  // Count pools
  let aggTotal = 0, aggEligible = 0, aggFirstPayout = 0
  ctx.accountStates.forEach(state => {
    if (!state.isActive || state.isCompleted) return
    aggTotal++
    if (monthIndex >= state.eligibleMonth && state.phase === 'funded') {
      aggEligible++
      if (state.payoutCount === 0) aggFirstPayout++
    }
  })

  return {
    netProfit, payoutDollars, payoutCount, payoutRequests,
    capCompletions, capClips, capRejections,
    totalAccounts: aggTotal, eligiblePool: aggEligible, firstPayoutPool: aggFirstPayout,
    zombieCompletions, resets: resetsThisMonth,
    revenueBreakdown: { entry: revenue, resets: resetRevenue, total: totalRevenue },
    costBreakdown: { payouts: payoutDollars, fraud: fraudLoss, chargebacks, variable: variableCosts, fixed: fixedCosts, total: totalCosts },
    deferredPayoutDollars,
    deferredPayoutRequests,
    ladderSplits: monthLadderSplits,
    newlyReachedPro,
    newlyReachedElite,
  }
}

// ============================================================================
// LEGACY COHORT-AGGREGATE ENGINE (kept for shadow cross-check only)
// ============================================================================

interface LegacyMonthResult {
  netProfit: number; totalPayouts: number; capHits: number
}

function simulateMonthLegacy(
  assumptions: SimAssumptions,
  random: () => number,
  cohorts: CohortState[],
  _monthIndex: number,
  macro?: MacroDraws,
): LegacyMonthResult {
  const { knobs } = assumptions
  const revenue = assumptions.accountsPerMonth * assumptions.pricePerAccount

  // Use pre-sampled macro draws if provided
  const passRate = macro?.passRate ?? triangularDrawLegacy(random, assumptions.passRate.min, assumptions.passRate.mode, assumptions.passRate.max)
  const payoutReqRate = macro?.payoutReqRate ?? triangularDrawLegacy(random, assumptions.payoutRequestRate.min, assumptions.payoutRequestRate.mode, assumptions.payoutRequestRate.max)
  const fraudAttemptRate = macro?.fraudAttemptRate ?? triangularDrawLegacy(random, assumptions.fraudAttemptRate.min, assumptions.fraudAttemptRate.mode, assumptions.fraudAttemptRate.max)
  const fraudSuccessRate = macro?.fraudSuccessRate ?? triangularDrawLegacy(random, assumptions.fraudSuccessRate.min, assumptions.fraudSuccessRate.mode, assumptions.fraudSuccessRate.max)
  const chargebackRate = macro?.chargebackRate ?? triangularDrawLegacy(random, assumptions.chargebackRate.min, assumptions.chargebackRate.mode, assumptions.chargebackRate.max)
  const payoutsPerAcct = macro?.payoutsPerAcct ?? triangularDrawLegacy(random, assumptions.payoutsPerPaidAccountPerMonth.min, assumptions.payoutsPerPaidAccountPerMonth.mode, assumptions.payoutsPerPaidAccountPerMonth.max)

  const newPassed = Math.round(assumptions.accountsPerMonth * passRate)
  const eligibilityLag = Math.ceil(assumptions.avgDaysToFirstPayout / 30)
  const effectiveLag = eligibilityLag + knobs.verificationMonths
  cohorts.push({ eligiblePool: 0, firstPayoutPool: newPassed, monthsActive: 0, totalPaid: 0, totalAccounts: newPassed })

  let totalPayouts = 0, totalCapHits = 0, resetRevenue = 0
  const monthlyResetFrac = 1 - Math.pow(1 - assumptions.resetRate, 1 / 12)

  for (const cohort of cohorts) {
    cohort.monthsActive++
    if (cohort.monthsActive <= knobs.verificationMonths && knobs.verificationFailRate > 0) {
      const failed = cohort.firstPayoutPool * knobs.verificationFailRate
      cohort.firstPayoutPool -= failed; cohort.totalAccounts -= failed
    }
    if (cohort.monthsActive === effectiveLag + 1 && cohort.firstPayoutPool > 0) {
      cohort.eligiblePool += cohort.firstPayoutPool
    }
    if (cohort.eligiblePool <= 0) continue
    const resets = cohort.eligiblePool * monthlyResetFrac
    cohort.eligiblePool -= resets; resetRevenue += resets * knobs.resetPrice
    cohort.eligiblePool += resets * 0.5; cohort.firstPayoutPool += resets * 0.5

    const lifetimeCap = knobs.lifetimeCapPerUser
    if (lifetimeCap !== null && cohort.totalAccounts > 0) {
      if (cohort.totalPaid / cohort.totalAccounts >= lifetimeCap) {
        totalCapHits += cohort.eligiblePool; cohort.eligiblePool = 0; continue
      }
    }
    const requesting = cohort.eligiblePool * payoutReqRate
    let gatePassRate = 1.0
    if (knobs.minMonthsBetweenPayouts > 1) gatePassRate *= Math.min(1, 1 / knobs.minMonthsBetweenPayouts)
    const approved = requesting * gatePassRate
    const numPayouts = approved * Math.max(1, payoutsPerAcct)
    const avgRaw = logNormalDraw(random, assumptions.avgPayoutAmount.mean, assumptions.avgPayoutAmount.stdDev)
    let avgTraderPayout = avgRaw * knobs.payoutSplitPercent
    const firstFrac = cohort.firstPayoutPool / Math.max(1, cohort.eligiblePool)
    if (knobs.firstPayoutCap !== null) {
      avgTraderPayout = avgTraderPayout * (1 - firstFrac) + Math.min(avgTraderPayout, knobs.firstPayoutCap) * firstFrac
    }
    if (lifetimeCap !== null && cohort.totalAccounts > 0) {
      const avgHeadroom = lifetimeCap - (cohort.totalPaid / cohort.totalAccounts)
      avgTraderPayout = Math.min(avgTraderPayout, Math.max(0, avgHeadroom))
    }
    const monthPayout = numPayouts * avgTraderPayout
    totalPayouts += monthPayout; cohort.totalPaid += monthPayout
    const firstPayoutsThisMonth = cohort.firstPayoutPool * payoutReqRate * gatePassRate
    cohort.firstPayoutPool = Math.max(0, cohort.firstPayoutPool - firstPayoutsThisMonth)
  }

  const totalEligible = cohorts.reduce((s, c) => s + c.eligiblePool, 0)
  const fraudPayoutBase = logNormalDraw(random, assumptions.avgPayoutAmount.mean * 1.3, assumptions.avgPayoutAmount.stdDev * 1.5)
  const fraudLoss = totalEligible * fraudAttemptRate * fraudSuccessRate * fraudPayoutBase * knobs.payoutSplitPercent
  const chargebacks = revenue * chargebackRate
  const variableCosts = assumptions.accountsPerMonth * assumptions.variableCostPerAccount
  const netProfit = revenue + resetRevenue - totalPayouts - fraudLoss - chargebacks - variableCosts - assumptions.fixedMonthlyCosts

  return { netProfit, totalPayouts, capHits: totalCapHits }
}

// ============================================================================
// SHADOW CROSS-CHECK
// ============================================================================
/**
 * SHADOW CROSS-CHECK SEMANTICS
 * - Compares engine ACCOUNTING LOGIC only (per-account vs cohort-aggregate).
 * - Uses shared macro-rate draws (true triangular) for pass/payout/fraud/chargeback rates.
 * - Dollar amounts (payouts + fraud losses) are drawn inside each engine per payout/event
 *   to preserve fat-tail behavior and avoid anchoring both engines to identical $ draws.
 * - Therefore: cross-check deltas reflect modeling/accounting differences, not distribution-shape differences.
 * - DO NOT reintroduce shared dollar draws (avgPayoutDraw, fraudPayoutDraw) — that kills right tails.
 */

interface CrossCheckResult {
  shadow_iterations: number
  profit_mean_delta: number
  reserve_breach_delta: number
  annual_loss_prob_delta: number
  worst_month_delta: number
  trust: 'high' | 'medium' | 'low'
  note: string
}

function runShadowCrossCheck(
  iterations: number,
  months: number,
  seed: number,
  assumptions: SimAssumptions,
  reserveThreshold: number,
): CrossCheckResult {
  // Use 100 iters for better confidence (was 50)
  const shadowIters = Math.min(100, iterations)

  // Step 1: Pre-sample shared macro draws for ALL iterations+months
  // Use a dedicated "macro RNG" so it doesn't interfere with either engine
  const allMacroDraws: MacroDraws[][] = []
  for (let iter = 0; iter < shadowIters; iter++) {
    const macroRng = mulberry32(seed + iter + 1_000_000) // offset to avoid collision with micro RNG
    allMacroDraws.push(preSampleMacroDraws(macroRng, months, assumptions))
  }

  // Step 2: Run per-account engine with shared macro + separate micro RNG
  const paMonthCols: number[][] = Array.from({ length: months }, () => [])
  const paCumProfits: number[] = []
  for (let iter = 0; iter < shadowIters; iter++) {
    const microRng = mulberry32(seed + iter) // micro RNG for per-account events
    const ctx: SimulateMonthContext = { accountStates: new Map(), nextAccountId: 1, totalEverCreated: 0, totalEverCompleted: 0, totalPassedAccounts: 0 }
    let cum = 0
    for (let m = 0; m < months; m++) {
      const r = simulateMonthPerAccount(assumptions, microRng, ctx, m, allMacroDraws[iter][m])
      paMonthCols[m].push(r.netProfit)
      cum += r.netProfit
    }
    paCumProfits.push(cum)
  }

  // Step 3: Run legacy engine with SAME shared macro + separate micro RNG
  const legMonthCols: number[][] = Array.from({ length: months }, () => [])
  const legCumProfits: number[] = []
  for (let iter = 0; iter < shadowIters; iter++) {
    const microRng = mulberry32(seed + iter + 2_000_000) // different micro offset for legacy
    const cohorts: CohortState[] = []
    let cum = 0
    for (let m = 0; m < months; m++) {
      const r = simulateMonthLegacy(assumptions, microRng, cohorts, m, allMacroDraws[iter][m])
      legMonthCols[m].push(r.netProfit)
      cum += r.netProfit
    }
    legCumProfits.push(cum)
  }

  const mean = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length

  const paMean = mean(paCumProfits)
  const legMean = mean(legCumProfits)

  // Reserve breach
  const breach = (monthCols: number[][], iters: number) => {
    let breaches = 0
    for (let i = 0; i < iters; i++) {
      let cum = 0
      for (let m = 0; m < months; m++) {
        cum += monthCols[m][i]
        if (cum < -reserveThreshold) { breaches++; break }
      }
    }
    return breaches / iters
  }
  const paBreachProb = breach(paMonthCols, shadowIters)
  const legBreachProb = breach(legMonthCols, shadowIters)

  // Annual loss prob
  const lossProb = (cumProfits: number[]) => cumProfits.filter(p => p < 0).length / cumProfits.length
  const paLossProb = lossProb(paCumProfits)
  const legLossProb = lossProb(legCumProfits)

  // Worst month
  const worst = (monthCols: number[][]) => {
    let w = Infinity
    for (const col of monthCols) for (const v of col) w = Math.min(w, v)
    return w
  }
  const paWorst = worst(paMonthCols)
  const legWorst = worst(legMonthCols)

  const profitMeanDelta = Math.abs(paMean - legMean)
  const reserveBreachDelta = Math.abs(paBreachProb - legBreachProb)
  const annualLossProbDelta = Math.abs(paLossProb - legLossProb)
  const worstMonthDelta = Math.abs(paWorst - legWorst)

  // Trust scoring — widened thresholds for 100-iter sample size
  // Wilson interval SE for p≈0.05 at n=100 is ~0.02, so 5% delta is noise
  let trust: 'high' | 'medium' | 'low' = 'high'
  let note = 'Engines agree within expected sampling noise'
  if (reserveBreachDelta > 0.08 || annualLossProbDelta > 0.10) {
    trust = 'low'
    note = `Large engine divergence: breach Δ=${(reserveBreachDelta * 100).toFixed(1)}%, loss Δ=${(annualLossProbDelta * 100).toFixed(1)}%`
  } else if (reserveBreachDelta > 0.05 || annualLossProbDelta > 0.06 || profitMeanDelta > 10000) {
    trust = 'medium'
    note = `Moderate engine divergence: profit Δ=$${Math.round(profitMeanDelta)}, breach Δ=${(reserveBreachDelta * 100).toFixed(1)}%`
  }

  return {
    shadow_iterations: shadowIters,
    profit_mean_delta: Math.round(profitMeanDelta),
    reserve_breach_delta: Math.round(reserveBreachDelta * 10000) / 10000,
    annual_loss_prob_delta: Math.round(annualLossProbDelta * 10000) / 10000,
    worst_month_delta: Math.round(worstMonthDelta),
    trust,
    note,
  }
}

// ============================================================================
// MAIN SIMULATION (per-account with runtime budget)
// ============================================================================

const RUNTIME_BUDGET_MS = 15_000

function runSimulation(
  iterations: number, months: number, seed: number,
  assumptions: SimAssumptions, reserveThreshold: number,
  startTime: number,
) {
  const monthColumns: number[][] = Array.from({ length: months }, () => [])
  const cohortTotalAcctCols: number[][] = Array.from({ length: months }, () => [])
  const cohortEligibleCols: number[][] = Array.from({ length: months }, () => [])
  const cohortFirstPayoutCols: number[][] = Array.from({ length: months }, () => [])
  const cohortCapCompletionCols: number[][] = Array.from({ length: months }, () => [])

  const allIterProfits: number[] = []
  let totalPayoutDollars = 0
  let totalPayoutCount = 0
  let totalPayoutRequests = 0
  let totalCapCompletions = 0
  let totalCapClips = 0
  let totalCapRejections = 0
  let totalPassedAccounts = 0
  let totalDeferredDollars = 0
  let totalDeferredRequests = 0
  let completedIterations = 0
  // Ladder split evidence tracking — discrete counters (splits are only 0.80/0.82/0.85)
  let ladderSplitSum = 0       // sum of all effective splits used
  let ladderSplitCount = 0     // number of executed payouts (for avg)
  let ladderSplit80 = 0        // count of payouts at base 80%
  let ladderSplit82 = 0        // count of payouts at Pro 82%
  let ladderSplit85 = 0        // count of payouts at Elite 85%
  let ladderSplitUnknown = 0   // drift guard: splits outside {0.80, 0.82, 0.85}
  let ladderAccountsPro = 0    // accounts at end-of-iter with cleanPayoutCount >= 3
  let ladderAccountsElite = 0  // accounts at end-of-iter with cleanPayoutCount >= 6
  let ladderTotalAccounts = 0  // total accounts observed at end of iteration
  let ladderCleanPayoutSum = 0 // sum of cleanPayoutCount across all end-of-iter accounts
  // "Ever reached" counters — tracked at payout execution time, not pruned by account deletion
  let ladderEverReachedPro = 0   // accounts that ever hit cleanPayoutCount == 3 (counted once)
  let ladderEverReachedElite = 0 // accounts that ever hit cleanPayoutCount == 6 (counted once)
  let ladderEverReachedTotal = 0 // total accounts that ever executed a payout
  // Clean payout count histogram (integer buckets 0..20+) for p50/p90 without arrays
  const cleanCountHisto: number[] = new Array(21).fill(0) // index 0-19 = exact, index 20 = 20+
  let partial = false
  let partialReason: string | null = null
  const perIterMaxPayoutOutflow: number[] = [] // Per-iteration max-month payout outflow for percentile calculation
  // Aggregate revenue/cost breakdown across all iterations
  let aggEntryRevenue = 0, aggResetRevenue = 0, aggTotalRevenue = 0
  let aggPayoutCost = 0, aggFraudCost = 0, aggChargebackCost = 0, aggVariableCost = 0, aggFixedCost = 0, aggTotalCost = 0
  // Per-iteration per-month Pay/Rev ratios for TRUE percentile computation
  const allMonthlyPayRevRatios: number[] = []

  for (let iter = 0; iter < iterations; iter++) {
    // Runtime budget check EVERY iteration
    if (iter > 0 && Date.now() - startTime > RUNTIME_BUDGET_MS) {
      partial = true
      partialReason = 'runtime_budget'
      break
    }

    const random = mulberry32(seed + iter)
    const ctx: SimulateMonthContext = {
      accountStates: new Map(), nextAccountId: 1,
      totalEverCreated: 0, totalEverCompleted: 0, totalPassedAccounts: 0,
    }
    let cumProfit = 0
    let cumCapCompletions = 0
    let iterMaxPayoutOutflow = 0

    for (let month = 0; month < months; month++) {
      // Inner budget check for heavy iterations
      if (month > 0 && month % 6 === 0 && Date.now() - startTime > RUNTIME_BUDGET_MS) {
        partial = true
        partialReason = 'runtime_budget'
        break
      }

      const result = simulateMonthPerAccount(assumptions, random, ctx, month)
      monthColumns[month].push(result.netProfit)
      cumProfit += result.netProfit

      totalPayoutDollars += result.payoutDollars
      totalPayoutCount += result.payoutCount
      totalPayoutRequests += result.payoutRequests
      totalCapCompletions += result.capCompletions
      totalCapClips += result.capClips
      totalCapRejections += result.capRejections
      totalDeferredDollars += result.deferredPayoutDollars
      totalDeferredRequests += result.deferredPayoutRequests
      // Ladder split evidence
      for (const s of result.ladderSplits) {
        ladderSplitSum += s
        ladderSplitCount++
        // Float-safe bucketing: clamp to 2 decimals then exact-match discrete tiers
        const s2 = Math.round(s * 100) / 100
        if (s2 === 0.85) ladderSplit85++
        else if (s2 === 0.82) ladderSplit82++
        else if (s2 === 0.80) ladderSplit80++
        else ladderSplitUnknown++
      }
      // "Ever reached" milestone aggregation
      ladderEverReachedPro += result.newlyReachedPro
      ladderEverReachedElite += result.newlyReachedElite
      // Track per-iteration max-month payout outflow
      if (result.payoutDollars > iterMaxPayoutOutflow) {
        iterMaxPayoutOutflow = result.payoutDollars
      }
      cumCapCompletions += result.capCompletions
      // Accumulate revenue/cost breakdown
      aggEntryRevenue += result.revenueBreakdown.entry
      aggResetRevenue += result.revenueBreakdown.resets
      aggTotalRevenue += result.revenueBreakdown.total
      aggPayoutCost += result.costBreakdown.payouts
      aggFraudCost += result.costBreakdown.fraud
      aggChargebackCost += result.costBreakdown.chargebacks
      aggVariableCost += result.costBreakdown.variable
      aggFixedCost += result.costBreakdown.fixed
      aggTotalCost += result.costBreakdown.total

      cohortTotalAcctCols[month].push(result.totalAccounts)
      cohortEligibleCols[month].push(result.eligiblePool)
      cohortFirstPayoutCols[month].push(result.firstPayoutPool)
      cohortCapCompletionCols[month].push(cumCapCompletions)

      // Track per-month Pay/Rev ratio for percentile computation
      const monthRevenue = result.revenueBreakdown.total
      if (monthRevenue > 0) {
        allMonthlyPayRevRatios.push(result.costBreakdown.payouts / monthRevenue)
      }
    }

    if (partial) break

    totalPassedAccounts += ctx.totalPassedAccounts
    allIterProfits.push(cumProfit)
    perIterMaxPayoutOutflow.push(iterMaxPayoutOutflow)
    // Count ladder progression at iteration end + build clean count histogram
    let iterCleanSum = 0
    ctx.accountStates.forEach(state => {
      ladderTotalAccounts++
      iterCleanSum += state.cleanPayoutCount
      if (state.cleanPayoutCount >= 3) ladderAccountsPro++
      if (state.cleanPayoutCount >= 6) ladderAccountsElite++
      // Histogram for p50/p90 computation
      const bucket = Math.min(state.cleanPayoutCount, 20)
      cleanCountHisto[bucket]++
    })
    // Count accounts that ever executed a payout (for "ever reached" denominator)
    ladderEverReachedTotal += ctx.totalEverCompleted + ctx.accountStates.size
    ladderCleanPayoutSum += iterCleanSum
    completedIterations++
  }

  // --- Compute stats ---
  const allMonthly: number[] = []
  const monthlyBands: { p5: number; p50: number; p95: number; mean: number }[] = []
  const cohortBands: { totalAccounts: number; eligible: number; firstPayout: number; capHits: number }[] = []

  const median = (arr: number[]) => {
    const s = arr.slice().sort((a, b) => a - b)
    return s[Math.floor(s.length * 0.5)]
  }

  for (let m = 0; m < months; m++) {
    const sorted = monthColumns[m].slice().sort((a, b) => a - b)
    const len = sorted.length
    if (len === 0) {
      monthlyBands.push({ p5: 0, p50: 0, p95: 0, mean: 0 })
      cohortBands.push({ totalAccounts: 0, eligible: 0, firstPayout: 0, capHits: 0 })
      continue
    }
    monthlyBands.push({
      p5: sorted[Math.floor(len * 0.05)],
      p50: sorted[Math.floor(len * 0.50)],
      p95: sorted[Math.floor(len * 0.95)],
      mean: sorted.reduce((a, b) => a + b, 0) / len,
    })
    for (const v of sorted) allMonthly.push(v)

    cohortBands.push({
      totalAccounts: Math.round(median(cohortTotalAcctCols[m])),
      eligible: Math.round(median(cohortEligibleCols[m])),
      firstPayout: Math.round(median(cohortFirstPayoutCols[m])),
      capHits: Math.round(median(cohortCapCompletionCols[m])),
    })
  }

  const sortedMonthly = allMonthly.slice().sort((a, b) => a - b)
  const mLen = sortedMonthly.length
  const mean = mLen > 0 ? sortedMonthly.reduce((a, b) => a + b, 0) / mLen : 0
  const p5 = mLen > 0 ? sortedMonthly[Math.floor(mLen * 0.05)] : 0
  const p50 = mLen > 0 ? sortedMonthly[Math.floor(mLen * 0.50)] : 0
  const p95 = mLen > 0 ? sortedMonthly[Math.floor(mLen * 0.95)] : 0
  const variance = mLen > 0 ? sortedMonthly.reduce((sum, p) => sum + (p - mean) ** 2, 0) / mLen : 0
  const stdDev = Math.sqrt(variance)
  const lossMonths = sortedMonthly.filter(p => p < 0).length
  const probabilityOfLoss = mLen > 0 ? lossMonths / mLen : 0
  const worstMonth = mLen > 0 ? sortedMonthly[0] : 0
  const bestMonth = mLen > 0 ? sortedMonthly[mLen - 1] : 0

  let maxDrawdown = 0, maxConsecutiveLoss = 0
  for (let iter = 0; iter < completedIterations; iter++) {
    let cum = 0, peak = 0, consLoss = 0
    for (let m = 0; m < months; m++) {
      const profit = monthColumns[m][iter]
      cum += profit; peak = Math.max(peak, cum)
      maxDrawdown = Math.max(maxDrawdown, peak - cum)
      if (profit < 0) { consLoss++; maxConsecutiveLoss = Math.max(maxConsecutiveLoss, consLoss) }
      else consLoss = 0
    }
  }

  let reserveBreaches = 0
  for (let iter = 0; iter < completedIterations; iter++) {
    let cum = 0
    for (let m = 0; m < months; m++) {
      cum += monthColumns[m][iter]
      if (cum < -reserveThreshold) { reserveBreaches++; break }
    }
  }
  const reserveBreachProbability = completedIterations > 0 ? reserveBreaches / completedIterations : 0

  const sortedCum = allIterProfits.slice().sort((a, b) => a - b)
  const cLen = sortedCum.length
  const annualMean = cLen > 0 ? sortedCum.reduce((a, b) => a + b, 0) / cLen : 0
  const annualP5 = cLen > 0 ? sortedCum[Math.floor(cLen * 0.05)] : 0
  const annualP50 = cLen > 0 ? sortedCum[Math.floor(cLen * 0.50)] : 0
  const annualP95 = cLen > 0 ? sortedCum[Math.floor(cLen * 0.95)] : 0
  const annualLossProb = cLen > 0 ? sortedCum.filter(p => p < 0).length / cLen : 0

  const bucketSize = 5000
  const buckets: Record<number, number> = {}
  for (const cp of allIterProfits) {
    const b = Math.floor(cp / bucketSize) * bucketSize
    buckets[b] = (buckets[b] || 0) + 1
  }
  const histogram = Object.entries(buckets)
    .map(([b, count]) => ({ bucket: Number(b), count }))
    .sort((a, b) => a.bucket - b.bucket)

  // Proper diagnostics: per passed account metrics
  const safePassedAccounts = totalPassedAccounts > 0 ? totalPassedAccounts : 1

  // Pre-compute payout outflow percentiles (reused in risk output + guardrail)
  const payoutOutflow = (() => {
    const sorted = perIterMaxPayoutOutflow.slice().sort((a, b) => a - b)
    const len = sorted.length
    if (len === 0) return { p95: 0, p99: 0, max: 0 }
    const pIndex = (p: number) => Math.min(Math.max(Math.ceil(p * len) - 1, 0), len - 1)
    return { p95: sorted[pIndex(0.95)], p99: sorted[pIndex(0.99)], max: sorted[len - 1] }
  })()

  // TRUE Pay/Rev percentiles from per-month distribution (not aggregated mean)
  const payRevPercentiles = (() => {
    const sorted = allMonthlyPayRevRatios.slice().sort((a, b) => a - b)
    const len = sorted.length
    if (len === 0) return { mean: 0, p50: 0, p95: 0, p99: 0, max: 0, sampleCount: 0 }
    const pIndex = (p: number) => Math.min(Math.max(Math.ceil(p * len) - 1, 0), len - 1)
    const sum = sorted.reduce((a, b) => a + b, 0)
    return {
      mean: sum / len,
      p50: sorted[pIndex(0.50)],
      p95: sorted[pIndex(0.95)],
      p99: sorted[pIndex(0.99)],
      max: sorted[len - 1],
      sampleCount: len,
    }
  })()

  return {
    partial,
    partialReason,
    completedIterations,
    requestedIterations: iterations,
    budget_ms: RUNTIME_BUDGET_MS,
    profit: { mean, p5, p50, p95, stdDev },
    risk: {
      probabilityOfLoss, maxDrawdown, worstMonth, bestMonth, consecutiveLossMonths: maxConsecutiveLoss,
      // Payout outflow percentiles (per-iteration max-month, nearest-rank method)
      maxPayoutOutflowMonth: payoutOutflow,
    },
    reserve: { breachProbability: reserveBreachProbability, threshold: reserveThreshold },
    annual: { p5: annualP5, p50: annualP50, p95: annualP95, lossProb: annualLossProb, mean: annualMean },
    monthlyBands,
    cohortBands,
    histogram,
    diagnostics: {
      avgPayoutDollarsPerPassedAccount: totalPayoutDollars / safePassedAccounts,
      avgPayoutCountPerPassedAccount: totalPayoutCount / safePassedAccounts,
      totalPayoutRequests,
      capCompletions: totalCapCompletions,
      capClips: totalCapClips,
      capRejections: totalCapRejections,
      capCompletionsPerPassedAccount: totalCapCompletions / safePassedAccounts,
      capClipsPerPassedAccount: totalCapClips / safePassedAccounts,
      capRejectionsPerPayoutRequest: totalPayoutRequests > 0 ? totalCapRejections / totalPayoutRequests : 0,
      avgPayoutsPerAccount: totalPayoutCount / safePassedAccounts,
      lifetimeCapHitRate: totalCapCompletions / safePassedAccounts,
      // Computed margins for assertion evaluation
      effectiveMargin: aggTotalRevenue > 0
        ? (aggTotalRevenue - aggTotalCost) / aggTotalRevenue
        : 0,
      payoutToRevenueRatio: aggTotalRevenue > 0
        ? aggPayoutCost / aggTotalRevenue
        : 0,
      // TRUE percentile Pay/Rev from per-month distribution
      payoutToRevenueP95: payRevPercentiles.p95,
      payoutToRevenueP99: payRevPercentiles.p99,
      payoutToRevenueMean: payRevPercentiles.mean,
      payoutToRevenueP50: payRevPercentiles.p50,
      payoutToRevenueMax: payRevPercentiles.max,
      payoutToRevenueSampleCount: payRevPercentiles.sampleCount,
      // Payout budgeting (soft pacing) diagnostics
      payoutBudgetEnabled: assumptions.knobs.targetPayRevSoft != null,
      targetPayRevSoft: assumptions.knobs.targetPayRevSoft,
      payRevEngageThreshold: assumptions.knobs.payRevEngageThreshold,
      conditionalPacing: assumptions.knobs.payRevEngageThreshold != null,
      totalDeferredDollars,
      totalDeferredRequests,
      deferredDollarsPerIteration: totalDeferredDollars / Math.max(1, completedIterations),
      deferredRequestsPerIteration: totalDeferredRequests / Math.max(1, completedIterations),
      // deferralRate = deferred / total requests (deferred are a SUBSET of requests, not double-counted)
      deferralRate: totalPayoutRequests > 0
        ? totalDeferredRequests / totalPayoutRequests
        : 0,
      // deferralDollarRate = deferred$ / (deferred$ + paid$) — how much $ mass is queued
      deferralDollarRate: (totalDeferredDollars + totalPayoutDollars) > 0
        ? totalDeferredDollars / (totalDeferredDollars + totalPayoutDollars)
        : 0,
      // Guardrail: structurally tied to the data series it validates (not completedIterations)
      ...(perIterMaxPayoutOutflow.length >= 500 && totalPayoutRequests > 0 && payoutOutflow.p95 === 0
        ? { payout_outflow_percentile_zero_with_payouts: true } : {}),
    },
    // Ladder split evidence: proves splits are actually being applied
    ladderEvidence: (() => {
      if (ladderSplitCount === 0) return { avgEffectiveSplit: 0, p95EffectiveSplit: 0, maxEffectiveSplit: 0, totalExecutedPayouts: 0, splitDistribution: { at80: 0, at82: 0, at85: 0, unknown: 0 }, accountsReachedProPct_endOfIter: 0, accountsReachedElitePct_endOfIter: 0, avgCleanPayoutCount_endOfIter: 0, accountsEverReachedProPct: 0, accountsEverReachedElitePct: 0, cleanPayoutCountPercentiles: { p50: 0, p90: 0 } }
      // Exact p95 from discrete counters (splits are only 0.80/0.82/0.85)
      const p95Rank = Math.ceil(0.95 * ladderSplitCount)
      const p95Split = p95Rank <= ladderSplit80 ? 0.80
        : p95Rank <= ladderSplit80 + ladderSplit82 ? 0.82
        : 0.85
      const maxSplit = ladderSplit85 > 0 ? 0.85 : ladderSplit82 > 0 ? 0.82 : 0.80
      // Compute p50/p90 of clean payout counts from histogram
      const histoTotal = cleanCountHisto.reduce((a, b) => a + b, 0)
      let p50Clean = 0, p90Clean = 0
      if (histoTotal > 0) {
        const p50Target = Math.ceil(0.50 * histoTotal)
        const p90Target = Math.ceil(0.90 * histoTotal)
        let cumHisto = 0
        for (let i = 0; i < cleanCountHisto.length; i++) {
          cumHisto += cleanCountHisto[i]
          if (p50Clean === 0 && cumHisto >= p50Target) p50Clean = i
          if (p90Clean === 0 && cumHisto >= p90Target) { p90Clean = i; break }
        }
      }
      return {
        avgEffectiveSplit: ladderSplitSum / ladderSplitCount,
        p95EffectiveSplit: p95Split,
        maxEffectiveSplit: maxSplit,
        totalExecutedPayouts: ladderSplitCount,
        splitDistribution: { at80: ladderSplit80, at82: ladderSplit82, at85: ladderSplit85, unknown: ladderSplitUnknown },
        // Denominator clarification: fraction of accounts alive at end-of-iteration
        // that reached Pro/Elite clean payout thresholds. NOT "ever reached".
        accountsReachedProPct_endOfIter: ladderTotalAccounts > 0 ? ladderAccountsPro / ladderTotalAccounts : 0,
        accountsReachedElitePct_endOfIter: ladderTotalAccounts > 0 ? ladderAccountsElite / ladderTotalAccounts : 0,
        avgCleanPayoutCount_endOfIter: ladderTotalAccounts > 0 ? ladderCleanPayoutSum / ladderTotalAccounts : 0,
        // "Ever reached" — tracked at payout execution time, survives account pruning
        accountsEverReachedProPct: ladderEverReachedTotal > 0 ? ladderEverReachedPro / ladderEverReachedTotal : 0,
        accountsEverReachedElitePct: ladderEverReachedTotal > 0 ? ladderEverReachedElite / ladderEverReachedTotal : 0,
        // Clean payout count distribution (end-of-iter surviving accounts)
        cleanPayoutCountPercentiles: { p50: p50Clean, p90: p90Clean },
      }
    })(),
    // Aggregate revenue/cost breakdown (averaged per iteration for auditability)
    revenueBreakdown: {
      entry: aggEntryRevenue / Math.max(1, completedIterations),
      resets: aggResetRevenue / Math.max(1, completedIterations),
      total: aggTotalRevenue / Math.max(1, completedIterations),
    },
    costBreakdown: {
      payouts: aggPayoutCost / Math.max(1, completedIterations),
      fraud: aggFraudCost / Math.max(1, completedIterations),
      chargebacks: aggChargebackCost / Math.max(1, completedIterations),
      variable: aggVariableCost / Math.max(1, completedIterations),
      fixed: aggFixedCost / Math.max(1, completedIterations),
      total: aggTotalCost / Math.max(1, completedIterations),
    },
  }
}

// ============================================================================
// AUTO-SCALING RULES
// ============================================================================

interface ScalingResult {
  iterations: number
  scaled: boolean
  reason: string | null
}

function autoScaleIterations(
  requested: number, months: number, accountsPerMonth: number, forceIterations: boolean,
  attackIntensity: number = 0,
): ScalingResult {
  if (forceIterations) return { iterations: requested, scaled: false, reason: null }

  // Estimate peak active accounts: base passRate ~12%, but attack intensity pushes it to 40%+.
  const basePassRate = 0.12
  const effectivePassRate = Math.min(0.50, basePassRate * (1 + 0.5 * attackIntensity))
  const estimatedPeakActive = Math.round(accountsPerMonth * effectivePassRate * Math.min(months, 12) * 1.2)

  // Real compute cost: RNG + branching + per-account payout loops + sort/shuffle.
  const OPS_PER_ACCOUNT_MONTH = 25

  // Target CPU budget — reduced for edge function CPU time safety
  const MAX_WORK = 120_000_000

  const denom = Math.max(1, months * Math.max(estimatedPeakActive, 10) * OPS_PER_ACCOUNT_MONTH)
  const workScore = requested * denom

  if (workScore > MAX_WORK) {
    const safeCap = Math.max(50, Math.floor(MAX_WORK / denom))
    const capped = Math.min(requested, safeCap)
    if (capped < requested) {
      return {
        iterations: capped, scaled: true,
        reason: `Auto-scaled from ${requested} to ${capped}: ~${estimatedPeakActive} peak active × ${months}mo × ${OPS_PER_ACCOUNT_MONTH} ops/acct (score ${(workScore / 1e6).toFixed(0)}M > ${(MAX_WORK / 1e6).toFixed(0)}M limit)`,
      }
    }
  }

  return { iterations: requested, scaled: false, reason: null }
}

// ============================================================================
// HANDLER
// ============================================================================

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  }

  const startTime = Date.now()

  const authHeader = req.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  }

  const jwt = authHeader.replace('Bearer ', '')
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!

  const anonClient = createClient(supabaseUrl, anonKey)
  const serviceClient = createClient(supabaseUrl, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

  const { data: userData, error: userError } = await anonClient.auth.getUser(jwt)
  if (userError || !userData?.user) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  }
  const userId = userData.user.id

  const { data: isAdmin } = await serviceClient.rpc('has_role', { _user_id: userId, _role: 'admin' })
  const { data: isRisk } = await serviceClient.rpc('has_role', { _user_id: userId, _role: 'risk_officer' })
  if (isAdmin !== true && isRisk !== true) {
    return new Response(JSON.stringify({ error: 'Forbidden: admin or risk_officer required' }), { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  }

  try {
    const body: SimulationRequest = await req.json().catch(() => ({}))
    const rawIterations = Math.min(body.iterations ?? 2000, 5000)
    const months = Math.min(body.months ?? 12, 36)
    const seed = body.seed ?? 42
    const reserveThreshold = body.reserve_threshold ?? 16000
    const forceIterations = body.force_iterations === true

    const { data: cohorts, error: cohortError } = await serviceClient
      .from('cohorts').select('*').eq('is_active', true).order('cohort_phase')

    if (cohortError) throw new Error(`Failed to fetch cohorts: ${cohortError.message}`)

    const cohortConfigs: CohortConfig[] = (cohorts || []).map((c: Record<string, unknown>) => ({
      id: c.id as string, name: c.name as string, cohort_phase: c.cohort_phase as string,
      entry_fee: c.entry_fee as number | null, payout_split_percent: c.payout_split_percent as number,
      first_payout_cap_amount: c.first_payout_cap_amount as number | null,
      lifetime_cap_multiple: c.lifetime_cap_multiple as number | null,
      max_payout_percent: c.max_payout_percent as number,
      max_payout_absolute: c.max_payout_absolute as number | null,
      payout_cooldown_days: c.payout_cooldown_days as number,
      payout_eligibility_delay_days: c.payout_eligibility_delay_days as number,
      min_trading_days_between_payouts: c.min_trading_days_between_payouts as number,
      min_winning_days_between_payouts: c.min_winning_days_between_payouts as number | null,
      min_profit_buffer: c.min_profit_buffer as number | null,
      profit_target_percent: c.profit_target_percent as number,
      max_daily_loss_percent: c.max_daily_loss_percent as number,
      max_total_drawdown_percent: c.max_total_drawdown_percent as number,
      max_daily_profit_cap_percent: c.max_daily_profit_cap_percent as number | null,
      min_profitable_days: c.min_profitable_days as number,
    }))

    const assumptions = cohortToAssumptions(cohortConfigs, body.overrides)
    const effectiveAssumptions = applyAttackIntensity(assumptions)

    const scaling = autoScaleIterations(rawIterations, months, effectiveAssumptions.accountsPerMonth, forceIterations, effectiveAssumptions.knobs.attackIntensity)
    const iterations = scaling.iterations

    const results = runSimulation(iterations, months, seed, effectiveAssumptions, reserveThreshold, startTime)

    // Shadow cross-check: compares engine accounting logic only (see block comment above).
    // Require ≥65% of runtime budget remaining AND low volume to avoid burning last seconds.
    let crossCheck: CrossCheckResult | null = null
    const elapsed = Date.now() - startTime
    const remainingBudget = RUNTIME_BUDGET_MS - elapsed
    const remainingPct = remainingBudget / RUNTIME_BUDGET_MS
    const shadowSafe =
      remainingPct >= 0.70 &&
      remainingBudget >= 8_000 &&
      effectiveAssumptions.accountsPerMonth <= 300 &&
      effectiveAssumptions.knobs.attackIntensity <= 0.3
    if (shadowSafe) {
      try {
        crossCheck = runShadowCrossCheck(
          Math.min(100, iterations), // hard cap shadow iterations
          months, seed, effectiveAssumptions, reserveThreshold,
        )
      } catch (e) {
        console.error('Shadow cross-check failed:', e)
      }
    }

    // Persist
    const fullResultsPayload = {
      ...results,
      engine: 'per_account_v2',
      cross_check: crossCheck,
      scaling: scaling.scaled ? { original: rawIterations, actual: iterations, reason: scaling.reason } : null,
    }

    const { data: inserted, error: insertError } = await serviceClient
      .from('simulation_runs')
      .insert({
        seed, iterations: results.completedIterations, months_per_iteration: months,
        assumptions: assumptions as unknown, cohort_configs: cohortConfigs as unknown,
        profit_mean: results.profit.mean, profit_p5: results.profit.p5,
        profit_p50: results.profit.p50, profit_p95: results.profit.p95,
        profit_std_dev: results.profit.stdDev,
        probability_of_loss: results.risk.probabilityOfLoss,
        max_drawdown: results.risk.maxDrawdown, worst_month: results.risk.worstMonth,
        best_month: results.risk.bestMonth,
        consecutive_loss_months: results.risk.consecutiveLossMonths,
        reserve_breach_probability: results.reserve.breachProbability,
        reserve_threshold: reserveThreshold,
        full_results: fullResultsPayload as unknown, triggered_by: userId,
        duration_ms: Date.now() - startTime,
      })
      .select('id').single()

    if (insertError) console.error('Failed to persist simulation:', insertError)

    // Ladder evidence log — eyeball-checkable in function logs without opening JSON
    const le = results.ladderEvidence as Record<string, unknown> | undefined
    if (le) {
      const dist = le.splitDistribution as Record<string, number> | undefined
      const driftWarn = dist && dist.unknown > 0 ? ` ⚠️ DRIFT:${dist.unknown}` : ''
      const pctls = le.cleanPayoutCountPercentiles as Record<string, number> | undefined
      console.log(`[ladder-evidence] run=${inserted?.id ?? 'unknown'} payouts=${le.totalExecutedPayouts} avgSplit=${typeof le.avgEffectiveSplit === 'number' ? (le.avgEffectiveSplit as number).toFixed(4) : '?'} maxSplit=${le.maxEffectiveSplit} dist=${JSON.stringify(le.splitDistribution)} proPct=${typeof le.accountsReachedProPct_endOfIter === 'number' ? ((le.accountsReachedProPct_endOfIter as number) * 100).toFixed(1) : '?'}% elitePct=${typeof le.accountsReachedElitePct_endOfIter === 'number' ? ((le.accountsReachedElitePct_endOfIter as number) * 100).toFixed(1) : '?'}% avgCleanCount=${typeof le.avgCleanPayoutCount_endOfIter === 'number' ? (le.avgCleanPayoutCount_endOfIter as number).toFixed(2) : '?'} everPro=${typeof le.accountsEverReachedProPct === 'number' ? ((le.accountsEverReachedProPct as number) * 100).toFixed(1) : '?'}% everElite=${typeof le.accountsEverReachedElitePct === 'number' ? ((le.accountsEverReachedElitePct as number) * 100).toFixed(1) : '?'}% cleanP50=${pctls?.p50 ?? '?'} cleanP90=${pctls?.p90 ?? '?'}${driftWarn}`)
    }

    if (inserted?.id) {
      const { data: currentSetting } = await serviceClient
        .from('system_settings').select('value').eq('key', 'reserve_aware_approval').single()

      if (currentSetting?.value) {
        const updatedValue = { ...(currentSetting.value as Record<string, unknown>), last_simulation_run_id: inserted.id }
        await serviceClient.from('system_settings').update({ value: updatedValue }).eq('key', 'reserve_aware_approval')
      }
    }

    return new Response(
      JSON.stringify({
        success: true, run_id: inserted?.id ?? null, duration_ms: Date.now() - startTime,
        config: { iterations: results.completedIterations, months, seed, reserveThreshold },
        assumptions_source: cohortConfigs.length > 0 ? 'derived_from_cohorts' : 'defaults',
        cohorts_used: cohortConfigs.map(c => ({ id: c.id, name: c.name, phase: c.cohort_phase })),
        engine: 'per_account_v2',
        partial: results.partial,
        partial_reason: results.partialReason,
        budget_ms: results.budget_ms,
        scaling: scaling.scaled ? { original: rawIterations, actual: iterations, reason: scaling.reason } : null,
        cross_check: crossCheck,
        results,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
  } catch (err) {
    const error = err as Error
    console.error('Simulation error:', error)
    return new Response(
      JSON.stringify({ error: error.message || 'Simulation failed' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
  }
})
