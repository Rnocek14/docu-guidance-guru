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
  force_iterations?: boolean // bypass auto-scaling
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
}

// Per-account state (ported from client engine)
interface AccountState {
  id: number
  createdMonth: number
  eligibleMonth: number
  lifetimePaidTotal: number
  attemptPaid: number
  payoutCount: number
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

interface SimulateMonthContext {
  accountStates: Map<number, AccountState>
  nextAccountId: number
  totalEverCreated: number
  totalEverCompleted: number
}

// Legacy cohort-aggregate state (kept for shadow cross-check)
interface CohortState {
  eligiblePool: number
  firstPayoutPool: number
  monthsActive: number
  totalPaid: number
  totalAccounts: number
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

/** Box-Muller normal */
function normal(random: () => number): number {
  const u1 = random() || 1e-10
  const u2 = random()
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
}

/** True inverse-CDF triangular distribution (not normal approximation) */
function triangular(random: () => number, min: number, mode: number, max: number): number {
  const u = random()
  const fc = (mode - min) / (max - min)
  if (u < fc) {
    return min + Math.sqrt(u * (max - min) * (mode - min))
  }
  return max - Math.sqrt((1 - u) * (max - min) * (max - mode))
}

/** Normal-approximated triangular (LEGACY — only used in shadow cross-check) */
function triangularDrawLegacy(random: () => number, min: number, mode: number, max: number): number {
  const mean = (min + mode + max) / 3
  const variance = (min * min + mode * mode + max * max - min * mode - min * max - mode * max) / 18
  const result = mean + Math.sqrt(variance) * normal(random)
  return Math.max(min, Math.min(max, result))
}

/** Log-normal draw */
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
      lifetimeCapPerUser: perfCohort?.lifetime_cap_multiple != null
        ? entryFee * perfCohort.lifetime_cap_multiple
        : null,
      attackIntensity: 0,
      minWinningDaysPerPayout: perfCohort?.min_winning_days_between_payouts ?? 0,
      minProfitSinceLastPayout: perfCohort?.min_profit_buffer ?? 0,
      minMonthsBetweenPayouts: Math.ceil((perfCohort?.payout_cooldown_days ?? 30) / 30),
      verificationMonths: cohorts.some(c => c.cohort_phase === 'verification') ? 1 : 0,
      verificationFailRate: 0.15,
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
// Ported from src/lib/monte-carlo.ts — same logic, same gates, same caps
// ============================================================================

interface MonthResult {
  netProfit: number; totalPayouts: number; payoutRequests: number; capHits: number
  totalAccounts: number; eligiblePool: number; firstPayoutPool: number
  zombieCompletions: number; resets: number
}

function simulateMonthPerAccount(
  assumptions: SimAssumptions,
  random: () => number,
  ctx: SimulateMonthContext,
  monthIndex: number,
): MonthResult {
  const { knobs } = assumptions

  // Revenue from new accounts
  const revenue = assumptions.accountsPerMonth * assumptions.pricePerAccount

  // Sample stochastic rates
  const passRate = triangular(random, assumptions.passRate.min, assumptions.passRate.mode, assumptions.passRate.max)
  const payoutReqRate = triangular(random, assumptions.payoutRequestRate.min, assumptions.payoutRequestRate.mode, assumptions.payoutRequestRate.max)
  const fraudAttemptRate = triangular(random, assumptions.fraudAttemptRate.min, assumptions.fraudAttemptRate.mode, assumptions.fraudAttemptRate.max)
  const fraudSuccessRate = triangular(random, assumptions.fraudSuccessRate.min, assumptions.fraudSuccessRate.mode, assumptions.fraudSuccessRate.max)
  const chargebackRate = triangular(random, assumptions.chargebackRate.min, assumptions.chargebackRate.mode, assumptions.chargebackRate.max)
  const payoutsPerAcct = triangular(random, assumptions.payoutsPerPaidAccountPerMonth.min, assumptions.payoutsPerPaidAccountPerMonth.mode, assumptions.payoutsPerPaidAccountPerMonth.max)

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
  }

  // --- Lifecycle: resets, zombies ---
  const lifetimeCap = knobs.lifetimeCapPerUser
  const monthlyResetProb = 1 - Math.pow(1 - assumptions.resetRate, 1 / 12)
  let resetsThisMonth = 0
  let resetRevenue = 0
  let zombieCompletions = 0

  ctx.accountStates.forEach(state => {
    if (!state.isActive || state.isCompleted) return

    // Zombie check: headroom < $50
    if (lifetimeCap !== null) {
      const headroom = lifetimeCap - state.lifetimePaidTotal
      if (headroom > 0 && headroom < 50) {
        completeAccount(state, 'zombie', ctx)
        zombieCompletions++
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
      state.eligibleMonth = monthIndex + eligibilityLag // Must wait again (proper lag)
      state.profitSinceLastPayout = 0
      state.monthsSinceLastPayout = 0
      state.winningDaysSinceLastPayout = 0
    }
  })

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
      // Simulate monthly PnL for velocity gate tracking
      const monthlyPnl = logNormalDraw(random, 200, 180) * (random() < 0.65 ? 1 : -0.7)
      state.profitSinceLastPayout += monthlyPnl
      state.monthsSinceLastPayout++

      // Winning days (~22 trading days, ~55% win rate)
      let winningDays = 0
      for (let d = 0; d < 22; d++) {
        if (random() < 0.55) winningDays++
      }
      state.winningDaysSinceLastPayout += winningDays
    }
  })

  // --- Payouts ---
  let totalPayouts = 0
  let totalPayoutRequests = 0
  let totalCapHits = 0

  const eligibleAccounts: AccountState[] = []
  ctx.accountStates.forEach(state => {
    if (state.isActive && !state.isCompleted && state.phase === 'funded' && monthIndex >= state.eligibleMonth) {
      eligibleAccounts.push(state)
    }
  })

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

    const numPayouts = Math.max(1, Math.round(payoutsPerAcct))
    for (let j = 0; j < numPayouts; j++) {
      totalPayoutRequests++

      const headroom = lifetimeCap !== null ? lifetimeCap - account.lifetimePaidTotal : Infinity
      if (headroom <= 0) {
        completeAccount(account, 'cap', ctx)
        totalCapHits++
        continue
      }

      const rawPayout = logNormalDraw(random, assumptions.avgPayoutAmount.mean, assumptions.avgPayoutAmount.stdDev)
      let traderPayout = rawPayout * knobs.payoutSplitPercent

      // First payout cap
      if (account.payoutCount === 0 && knobs.firstPayoutCap !== null) {
        traderPayout = Math.min(traderPayout, knobs.firstPayoutCap)
      }

      // Lifetime cap clip
      if (lifetimeCap !== null && traderPayout > headroom) {
        traderPayout = headroom
        totalCapHits++
      }

      // Min $50 threshold
      if (traderPayout < 50) continue

      // Hard guard
      if (lifetimeCap !== null && account.lifetimePaidTotal + traderPayout > lifetimeCap + 1e-6) {
        throw new Error(`Lifetime cap violated: account ${account.id}`)
      }

      totalPayouts += traderPayout
      account.lifetimePaidTotal += traderPayout
      account.attemptPaid += traderPayout
      account.payoutCount++

      // Reset velocity counters
      account.profitSinceLastPayout = 0
      account.monthsSinceLastPayout = 0
      account.winningDaysSinceLastPayout = 0

      // Check if cap-complete after payout
      if (lifetimeCap !== null && account.lifetimePaidTotal >= lifetimeCap - 1e-6) {
        completeAccount(account, 'cap', ctx)
      }
    }
  }

  // --- Fraud & chargebacks ---
  const fraudLoss = eligibleAccounts.length * fraudAttemptRate * fraudSuccessRate *
    logNormalDraw(random, assumptions.avgPayoutAmount.mean * 1.3, assumptions.avgPayoutAmount.stdDev * 1.5) *
    knobs.payoutSplitPercent
  const chargebacks = revenue * chargebackRate
  const variableCosts = assumptions.accountsPerMonth * assumptions.variableCostPerAccount
  const fixedCosts = assumptions.fixedMonthlyCosts

  const netProfit = revenue + resetRevenue - totalPayouts - fraudLoss - chargebacks - variableCosts - fixedCosts

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
    netProfit, totalPayouts, payoutRequests: totalPayoutRequests, capHits: totalCapHits,
    totalAccounts: aggTotal, eligiblePool: aggEligible, firstPayoutPool: aggFirstPayout,
    zombieCompletions: zombieCompletions, resets: resetsThisMonth,
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
): LegacyMonthResult {
  const { knobs } = assumptions
  const revenue = assumptions.accountsPerMonth * assumptions.pricePerAccount
  const passRate = triangularDrawLegacy(random, assumptions.passRate.min, assumptions.passRate.mode, assumptions.passRate.max)
  const payoutReqRate = triangularDrawLegacy(random, assumptions.payoutRequestRate.min, assumptions.payoutRequestRate.mode, assumptions.payoutRequestRate.max)
  const fraudAttemptRate = triangularDrawLegacy(random, assumptions.fraudAttemptRate.min, assumptions.fraudAttemptRate.mode, assumptions.fraudAttemptRate.max)
  const fraudSuccessRate = triangularDrawLegacy(random, assumptions.fraudSuccessRate.min, assumptions.fraudSuccessRate.mode, assumptions.fraudSuccessRate.max)
  const chargebackRate = triangularDrawLegacy(random, assumptions.chargebackRate.min, assumptions.chargebackRate.mode, assumptions.chargebackRate.max)
  const payoutsPerAcct = triangularDrawLegacy(random, assumptions.payoutsPerPaidAccountPerMonth.min, assumptions.payoutsPerPaidAccountPerMonth.mode, assumptions.payoutsPerPaidAccountPerMonth.max)

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
    let avgRaw = logNormalDraw(random, assumptions.avgPayoutAmount.mean, assumptions.avgPayoutAmount.stdDev)
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
  const fraudLoss = totalEligible * fraudAttemptRate * fraudSuccessRate *
    logNormalDraw(random, assumptions.avgPayoutAmount.mean * 1.3, assumptions.avgPayoutAmount.stdDev * 1.5) * knobs.payoutSplitPercent
  const chargebacks = revenue * chargebackRate
  const variableCosts = assumptions.accountsPerMonth * assumptions.variableCostPerAccount
  const netProfit = revenue + resetRevenue - totalPayouts - fraudLoss - chargebacks - variableCosts - assumptions.fixedMonthlyCosts

  return { netProfit, totalPayouts, capHits: totalCapHits }
}

// ============================================================================
// SHADOW CROSS-CHECK: Run both engines, compare deltas
// ============================================================================

interface CrossCheckResult {
  shadow_iterations: number
  profit_mean_delta: number
  reserve_breach_delta: number
  annual_loss_prob_delta: number
  worst_month_delta: number
  trust: 'high' | 'medium' | 'low'
}

function runShadowCrossCheck(
  iterations: number,
  months: number,
  seed: number,
  assumptions: SimAssumptions,
  reserveThreshold: number,
): CrossCheckResult {
  const shadowIters = Math.min(50, iterations)

  // Run per-account engine
  const paMonthCols: number[][] = Array.from({ length: months }, () => [])
  const paCumProfits: number[] = []
  for (let iter = 0; iter < shadowIters; iter++) {
    const random = mulberry32(seed + iter)
    const ctx: SimulateMonthContext = { accountStates: new Map(), nextAccountId: 1, totalEverCreated: 0, totalEverCompleted: 0 }
    let cum = 0
    for (let m = 0; m < months; m++) {
      const r = simulateMonthPerAccount(assumptions, random, ctx, m)
      paMonthCols[m].push(r.netProfit)
      cum += r.netProfit
    }
    paCumProfits.push(cum)
  }

  // Run legacy engine with same seeds
  const legMonthCols: number[][] = Array.from({ length: months }, () => [])
  const legCumProfits: number[] = []
  for (let iter = 0; iter < shadowIters; iter++) {
    const random = mulberry32(seed + iter)
    const cohorts: CohortState[] = []
    let cum = 0
    for (let m = 0; m < months; m++) {
      const r = simulateMonthLegacy(assumptions, random, cohorts, m)
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

  // Trust scoring
  let trust: 'high' | 'medium' | 'low' = 'high'
  if (reserveBreachDelta > 0.03 || annualLossProbDelta > 0.05) trust = 'low'
  else if (reserveBreachDelta > 0.01 || annualLossProbDelta > 0.02 || profitMeanDelta > 5000) trust = 'medium'

  return {
    shadow_iterations: shadowIters,
    profit_mean_delta: Math.round(profitMeanDelta),
    reserve_breach_delta: Math.round(reserveBreachDelta * 10000) / 10000,
    annual_loss_prob_delta: Math.round(annualLossProbDelta * 10000) / 10000,
    worst_month_delta: Math.round(worstMonthDelta),
    trust,
  }
}

// ============================================================================
// MAIN SIMULATION (per-account with runtime budget)
// ============================================================================

const RUNTIME_BUDGET_MS = 20_000

function runSimulation(
  iterations: number, months: number, seed: number,
  assumptions: SimAssumptions, reserveThreshold: number,
  startTime: number,
) {
  const monthColumns: number[][] = Array.from({ length: months }, () => [])
  const cohortTotalAcctCols: number[][] = Array.from({ length: months }, () => [])
  const cohortEligibleCols: number[][] = Array.from({ length: months }, () => [])
  const cohortFirstPayoutCols: number[][] = Array.from({ length: months }, () => [])
  const cohortCapHitCols: number[][] = Array.from({ length: months }, () => [])
  const allIterProfits: number[] = []
  let totalPayoutsApproved = 0
  let totalCapHits = 0
  let completedIterations = 0
  let partial = false

  for (let iter = 0; iter < iterations; iter++) {
    // Runtime budget check every 10 iterations
    if (iter > 0 && iter % 10 === 0) {
      if (Date.now() - startTime > RUNTIME_BUDGET_MS) {
        partial = true
        break
      }
    }

    const random = mulberry32(seed + iter)
    const ctx: SimulateMonthContext = {
      accountStates: new Map(), nextAccountId: 1, totalEverCreated: 0, totalEverCompleted: 0,
    }
    let cumProfit = 0
    let cumCapHits = 0

    for (let month = 0; month < months; month++) {
      const result = simulateMonthPerAccount(assumptions, random, ctx, month)
      monthColumns[month].push(result.netProfit)
      cumProfit += result.netProfit
      totalPayoutsApproved += result.payoutRequests
      totalCapHits += result.capHits
      cumCapHits += result.capHits

      cohortTotalAcctCols[month].push(result.totalAccounts)
      cohortEligibleCols[month].push(result.eligiblePool)
      cohortFirstPayoutCols[month].push(result.firstPayoutPool)
      cohortCapHitCols[month].push(cumCapHits)
    }
    allIterProfits.push(cumProfit)
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
      capHits: Math.round(median(cohortCapHitCols[m])),
    })
  }

  const sortedMonthly = allMonthly.slice().sort((a, b) => a - b)
  const mLen = sortedMonthly.length
  const mean = sortedMonthly.reduce((a, b) => a + b, 0) / mLen
  const p5 = sortedMonthly[Math.floor(mLen * 0.05)]
  const p50 = sortedMonthly[Math.floor(mLen * 0.50)]
  const p95 = sortedMonthly[Math.floor(mLen * 0.95)]
  const variance = sortedMonthly.reduce((sum, p) => sum + (p - mean) ** 2, 0) / mLen
  const stdDev = Math.sqrt(variance)
  const lossMonths = sortedMonthly.filter(p => p < 0).length
  const probabilityOfLoss = lossMonths / mLen
  const worstMonth = sortedMonthly[0]
  const bestMonth = sortedMonthly[mLen - 1]

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
  const reserveBreachProbability = reserveBreaches / completedIterations

  const sortedCum = allIterProfits.slice().sort((a, b) => a - b)
  const cLen = sortedCum.length
  const annualMean = sortedCum.reduce((a, b) => a + b, 0) / cLen
  const annualP5 = sortedCum[Math.floor(cLen * 0.05)]
  const annualP50 = sortedCum[Math.floor(cLen * 0.50)]
  const annualP95 = sortedCum[Math.floor(cLen * 0.95)]
  const annualLossProb = sortedCum.filter(p => p < 0).length / cLen

  const bucketSize = 5000
  const buckets: Record<number, number> = {}
  for (const cp of allIterProfits) {
    const b = Math.floor(cp / bucketSize) * bucketSize
    buckets[b] = (buckets[b] || 0) + 1
  }
  const histogram = Object.entries(buckets)
    .map(([b, count]) => ({ bucket: Number(b), count }))
    .sort((a, b) => a.bucket - b.bucket)

  const totalAccountsPerIter = assumptions.accountsPerMonth * months

  return {
    partial,
    completedIterations,
    requestedIterations: iterations,
    profit: { mean, p5, p50, p95, stdDev },
    risk: { probabilityOfLoss, maxDrawdown, worstMonth, bestMonth, consecutiveLossMonths: maxConsecutiveLoss },
    reserve: { breachProbability: reserveBreachProbability, threshold: reserveThreshold },
    annual: { p5: annualP5, p50: annualP50, p95: annualP95, lossProb: annualLossProb, mean: annualMean },
    monthlyBands,
    cohortBands,
    histogram,
    diagnostics: {
      avgPayoutsPerAccount: totalAccountsPerIter > 0 ? totalPayoutsApproved / (totalAccountsPerIter * completedIterations) : 0,
      lifetimeCapHitRate: totalAccountsPerIter > 0 ? totalCapHits / (totalAccountsPerIter * completedIterations) : 0,
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
): ScalingResult {
  if (forceIterations) return { iterations: requested, scaled: false, reason: null }

  // Strict rule: high volume + long horizon
  if (months > 24 && accountsPerMonth > 300) {
    const capped = Math.min(requested, 300)
    if (capped < requested) {
      return { iterations: capped, scaled: true, reason: `Auto-scaled from ${requested} to ${capped}: ${accountsPerMonth} accounts/mo × ${months} months exceeds safe budget` }
    }
  }

  // Medium rule: moderate scale
  if (months > 12 && accountsPerMonth > 500) {
    const capped = Math.min(requested, 500)
    if (capped < requested) {
      return { iterations: capped, scaled: true, reason: `Auto-scaled from ${requested} to ${capped}: ${accountsPerMonth} accounts/mo × ${months} months` }
    }
  }

  // High volume warning
  if (accountsPerMonth > 750) {
    const capped = Math.min(requested, 500)
    if (capped < requested) {
      return { iterations: capped, scaled: true, reason: `Auto-scaled from ${requested} to ${capped}: ${accountsPerMonth} accounts/mo is high volume` }
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

    // Auto-scale iterations
    const scaling = autoScaleIterations(rawIterations, months, effectiveAssumptions.accountsPerMonth, forceIterations)
    const iterations = scaling.iterations

    // Run primary simulation (per-account, high fidelity)
    const results = runSimulation(iterations, months, seed, effectiveAssumptions, reserveThreshold, startTime)

    // Run shadow cross-check (only if we have time budget left)
    let crossCheck: CrossCheckResult | null = null
    if (Date.now() - startTime < RUNTIME_BUDGET_MS - 3000) {
      try {
        crossCheck = runShadowCrossCheck(iterations, months, seed, effectiveAssumptions, reserveThreshold)
      } catch (e) {
        console.error('Shadow cross-check failed:', e)
      }
    }

    // Persist
    const fullResultsPayload = {
      ...results,
      engine: 'per_account_v1',
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
        engine: 'per_account_v1',
        partial: results.partial,
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
