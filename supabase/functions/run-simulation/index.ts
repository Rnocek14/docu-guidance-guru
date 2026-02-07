import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
}

// ============================================================================
// TYPES
// ============================================================================

interface SimulationRequest {
  iterations?: number      // default 2000
  months?: number          // default 12
  seed?: number            // default 42
  reserve_threshold?: number // for reserve breach probability calc
  overrides?: Partial<SimAssumptions> // optional param overrides
}

interface CohortConfig {
  id: string
  name: string
  cohort_phase: string
  entry_fee: number | null
  payout_split_percent: number
  first_payout_cap_amount: number | null
  lifetime_cap_multiple: number | null
  max_payout_percent: number
  max_payout_absolute: number | null
  payout_cooldown_days: number
  payout_eligibility_delay_days: number
  min_trading_days_between_payouts: number
  min_winning_days_between_payouts: number | null
  min_profit_buffer: number | null
  profit_target_percent: number
  max_daily_loss_percent: number
  max_total_drawdown_percent: number
  max_daily_profit_cap_percent: number | null
  min_profitable_days: number
}

interface SimAssumptions {
  accountsPerMonth: number
  pricePerAccount: number
  passRate: { min: number; mode: number; max: number }
  payoutRequestRate: { min: number; mode: number; max: number }
  avgDaysToFirstPayout: number
  avgPayoutAmount: { mean: number; stdDev: number }
  payoutsPerPaidAccountPerMonth: { min: number; mode: number; max: number }
  fraudAttemptRate: { min: number; mode: number; max: number }
  fraudSuccessRate: { min: number; mode: number; max: number }
  chargebackRate: { min: number; mode: number; max: number }
  resetRate: number
  variableCostPerAccount: number
  fixedMonthlyCosts: number
  knobs: SimKnobs
}

interface SimKnobs {
  firstPayoutCap: number | null
  payoutSplitPercent: number
  maxPayoutPercent: number
  resetPrice: number
  lifetimeCapPerUser: number | null
  attackIntensity: number
  minWinningDaysPerPayout: number
  minProfitSinceLastPayout: number
  minMonthsBetweenPayouts: number
  verificationMonths: number
  verificationFailRate: number
}

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

interface MonthResult {
  revenue: number
  resetRevenue: number
  payouts: number
  fraudLoss: number
  chargebacks: number
  variableCosts: number
  fixedCosts: number
  netProfit: number
  activeCohortSize: number
  eligibleCohortSize: number
  resetsThisMonth: number
  newPassedAccountsThisMonth: number
  payoutDetails: {
    requestCount: number
    approvedCount: number
    totalPaid: number
    firstPayoutCapHits: number
    lifetimeCapHits: number
    lifetimeCapRejections: number
    accountsCompletedByCap: number
    zombieAccountsCompleted: number
  }
}

interface SimContext {
  accountStates: Map<number, AccountState>
  nextAccountId: number
  totalEverCreated: number
  totalEverCompleted: number
}

// ============================================================================
// SEEDED PRNG (Mulberry32)
// ============================================================================

function mulberry32(seed: number): () => number {
  return function() {
    let t = seed += 0x6D2B79F5
    t = Math.imul(t ^ t >>> 15, t | 1)
    t ^= t + Math.imul(t ^ t >>> 7, t | 61)
    return ((t ^ t >>> 14) >>> 0) / 4294967296
  }
}

// ============================================================================
// DISTRIBUTIONS
// ============================================================================

function beta(random: () => number, alpha: number, betaParam: number): number {
  let u1: number, u2: number, sum: number
  do {
    u1 = Math.pow(random(), 1 / alpha)
    u2 = Math.pow(random(), 1 / betaParam)
    sum = u1 + u2
  } while (sum > 1)
  return u1 / sum
}

function triangularToBeta(random: () => number, min: number, mode: number, max: number): number {
  const normalizedMode = (mode - min) / (max - min)
  const concentration = 4
  const alpha = 1 + concentration * normalizedMode
  const betaParam = 1 + concentration * (1 - normalizedMode)
  const sample = beta(random, alpha, betaParam)
  return min + sample * (max - min)
}

function logNormal(random: () => number, mean: number, stdDev: number): number {
  const variance = stdDev * stdDev
  const mu = Math.log(mean * mean / Math.sqrt(variance + mean * mean))
  const sigma = Math.sqrt(Math.log(1 + variance / (mean * mean)))
  const u1 = random()
  const u2 = random()
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
  return Math.exp(mu + sigma * z)
}

// ============================================================================
// COHORT → ASSUMPTIONS MAPPER
// ============================================================================

function cohortToAssumptions(cohorts: CohortConfig[], overrides?: Partial<SimAssumptions>): SimAssumptions {
  // Use the performance cohort as primary (or first active cohort)
  const perfCohort = cohorts.find(c => c.cohort_phase === 'performance') || cohorts[0]
  const evalCohort = cohorts.find(c => c.cohort_phase === 'evaluation') || cohorts[0]
  
  const entryFee = evalCohort?.entry_fee ?? 149
  const resetPrice = 99 // Standard reset price
  
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
      resetPrice,
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
  
  // Apply overrides
  if (overrides) {
    return { ...base, ...overrides, knobs: { ...base.knobs, ...overrides.knobs } }
  }
  return base
}

// ============================================================================
// SIMULATION ENGINE (ported from client-side monte-carlo.ts)
// ============================================================================

function completeAccount(state: AccountState, reason: 'cap' | 'zombie', ctx: SimContext): void {
  if (state.isCompleted) return
  state.isCompleted = true
  state.isActive = false
  state.completedByCapHit = reason === 'cap'
  ctx.totalEverCompleted++
}

function simulateMonth(
  assumptions: SimAssumptions,
  random: () => number,
  ctx: SimContext,
  monthIndex: number
): MonthResult {
  const { knobs } = assumptions
  const revenue = assumptions.accountsPerMonth * assumptions.pricePerAccount
  
  const passRate = triangularToBeta(random, assumptions.passRate.min, assumptions.passRate.mode, assumptions.passRate.max)
  const payoutRequestRate = triangularToBeta(random, assumptions.payoutRequestRate.min, assumptions.payoutRequestRate.mode, assumptions.payoutRequestRate.max)
  const fraudAttemptRate = triangularToBeta(random, assumptions.fraudAttemptRate.min, assumptions.fraudAttemptRate.mode, assumptions.fraudAttemptRate.max)
  const fraudSuccessRate = triangularToBeta(random, assumptions.fraudSuccessRate.min, assumptions.fraudSuccessRate.mode, assumptions.fraudSuccessRate.max)
  const chargebackRate = triangularToBeta(random, assumptions.chargebackRate.min, assumptions.chargebackRate.mode, assumptions.chargebackRate.max)
  const payoutsPerAccount = triangularToBeta(random, assumptions.payoutsPerPaidAccountPerMonth.min, assumptions.payoutsPerPaidAccountPerMonth.mode, assumptions.payoutsPerPaidAccountPerMonth.max)
  
  // New accounts
  const newPassedAccounts = Math.round(assumptions.accountsPerMonth * passRate)
  const eligibilityLag = Math.ceil(assumptions.avgDaysToFirstPayout / 30)
  
  for (let i = 0; i < newPassedAccounts; i++) {
    const accountId = ctx.nextAccountId++
    const useVerification = knobs.verificationMonths > 0
    ctx.accountStates.set(accountId, {
      id: accountId,
      createdMonth: monthIndex,
      eligibleMonth: useVerification ? monthIndex + eligibilityLag + knobs.verificationMonths : monthIndex + eligibilityLag,
      lifetimePaidTotal: 0, attemptPaid: 0, payoutCount: 0, resetCount: 0,
      isCompleted: false, isActive: true, completedByCapHit: false,
      profitSinceLastPayout: 0, monthsSinceLastPayout: 0, winningDaysSinceLastPayout: 0,
      phase: useVerification ? 'verification' : 'funded',
      verificationStartMonth: monthIndex,
    })
    ctx.totalEverCreated++
  }
  
  // Lifecycle: resets + zombies
  let resetsThisMonth = 0, resetRevenue = 0, zombieAccountsCompleted = 0
  const lifetimeCap = knobs.lifetimeCapPerUser
  const monthlyResetProb = 1 - Math.pow(1 - assumptions.resetRate, 1/12)
  
  ctx.accountStates.forEach(state => {
    if (!state.isActive || state.isCompleted) return
    if (lifetimeCap !== null) {
      const headroom = lifetimeCap - state.lifetimePaidTotal
      if (headroom > 0 && headroom < 50) {
        completeAccount(state, 'zombie', ctx)
        zombieAccountsCompleted++
        return
      }
    }
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
  
  // Verification + profit accumulation
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
      const monthlyPnl = logNormal(random, 200, 180) * (random() < 0.65 ? 1 : -0.7)
      state.profitSinceLastPayout += monthlyPnl
      state.monthsSinceLastPayout++
      let winningDays = 0
      for (let d = 0; d < 22; d++) { if (random() < 0.55) winningDays++ }
      state.winningDaysSinceLastPayout += winningDays
    }
  })
  
  // Payout processing
  let totalPayouts = 0, firstPayoutCapHits = 0, lifetimeCapHits = 0, lifetimeCapRejections = 0
  let accountsCompletedThisMonth = 0, payoutRequestCount = 0, payoutApprovedCount = 0
  
  const eligibleAccounts: AccountState[] = []
  ctx.accountStates.forEach(state => {
    if (state.isActive && !state.isCompleted && state.phase === 'funded' && monthIndex >= state.eligibleMonth) {
      eligibleAccounts.push(state)
    }
  })
  
  for (const account of eligibleAccounts) {
    if (random() > payoutRequestRate) continue
    
    // Velocity gates
    if (knobs.minWinningDaysPerPayout > 0 && account.payoutCount > 0 && account.winningDaysSinceLastPayout < knobs.minWinningDaysPerPayout) continue
    if (knobs.minProfitSinceLastPayout > 0 && account.payoutCount > 0 && account.profitSinceLastPayout < knobs.minProfitSinceLastPayout) continue
    if (knobs.minMonthsBetweenPayouts > 0 && account.payoutCount > 0 && account.monthsSinceLastPayout < knobs.minMonthsBetweenPayouts) continue
    
    const numPayouts = Math.max(1, Math.round(payoutsPerAccount))
    for (let j = 0; j < numPayouts; j++) {
      payoutRequestCount++
      const headroom = lifetimeCap !== null ? lifetimeCap - account.lifetimePaidTotal : Infinity
      if (headroom <= 0) { lifetimeCapRejections++; completeAccount(account, 'cap', ctx); continue }
      
      const rawPayoutAmount = logNormal(random, assumptions.avgPayoutAmount.mean, assumptions.avgPayoutAmount.stdDev)
      let traderPayout = rawPayoutAmount * knobs.payoutSplitPercent
      
      const isFirstPayout = account.payoutCount === 0
      if (isFirstPayout && knobs.firstPayoutCap !== null && traderPayout > knobs.firstPayoutCap) {
        traderPayout = knobs.firstPayoutCap
        firstPayoutCapHits++
      }
      
      if (lifetimeCap !== null && traderPayout > headroom) {
        lifetimeCapHits++
        traderPayout = headroom
        if (account.lifetimePaidTotal + traderPayout >= lifetimeCap) {
          completeAccount(account, 'cap', ctx)
          accountsCompletedThisMonth++
        }
      }
      
      if (traderPayout < 50) continue
      
      totalPayouts += traderPayout
      payoutApprovedCount++
      account.lifetimePaidTotal += traderPayout
      account.attemptPaid += traderPayout
      account.payoutCount++
      account.profitSinceLastPayout = 0
      account.monthsSinceLastPayout = 0
      account.winningDaysSinceLastPayout = 0
    }
  }
  
  let activeCohortSize = 0, eligibleCohortSize = 0
  ctx.accountStates.forEach(state => {
    if (state.isActive && !state.isCompleted) {
      activeCohortSize++
      if (monthIndex >= state.eligibleMonth) eligibleCohortSize++
    }
  })
  
  const fraudAttempts = eligibleAccounts.length * fraudAttemptRate
  const successfulFrauds = fraudAttempts * fraudSuccessRate
  const avgFraudPayout = logNormal(random, assumptions.avgPayoutAmount.mean * 1.3, assumptions.avgPayoutAmount.stdDev * 1.5)
  const fraudLoss = successfulFrauds * avgFraudPayout * knobs.payoutSplitPercent
  const chargebacks = revenue * chargebackRate
  const variableCosts = assumptions.accountsPerMonth * assumptions.variableCostPerAccount
  const fixedCosts = assumptions.fixedMonthlyCosts
  const netProfit = revenue + resetRevenue - totalPayouts - fraudLoss - chargebacks - variableCosts - fixedCosts
  
  return {
    revenue, resetRevenue, payouts: totalPayouts, fraudLoss, chargebacks,
    variableCosts, fixedCosts, netProfit, activeCohortSize, eligibleCohortSize,
    resetsThisMonth, newPassedAccountsThisMonth: newPassedAccounts,
    payoutDetails: {
      requestCount: payoutRequestCount, approvedCount: payoutApprovedCount,
      totalPaid: totalPayouts, firstPayoutCapHits, lifetimeCapHits,
      lifetimeCapRejections, accountsCompletedByCap: accountsCompletedThisMonth,
      zombieAccountsCompleted,
    },
  }
}

function runSimulation(iterations: number, months: number, seed: number, assumptions: SimAssumptions, reserveThreshold: number) {
  const allMonthlyProfits: number[][] = []
  const monthlyBands: { p5: number; p50: number; p95: number; mean: number }[] = []
  
  // Per-month accumulators for percentile bands
  const monthColumns: number[][] = Array.from({ length: months }, () => [])
  
  let totalPayoutsApproved = 0
  let totalAccountsCreated = 0
  let totalCapHits = 0
  
  for (let iter = 0; iter < iterations; iter++) {
    const random = mulberry32(seed + iter)
    const monthProfits: number[] = []
    const ctx: SimContext = {
      accountStates: new Map(), nextAccountId: 1, totalEverCreated: 0, totalEverCompleted: 0,
    }
    
    for (let month = 0; month < months; month++) {
      const result = simulateMonth(assumptions, random, ctx, month)
      monthProfits.push(result.netProfit)
      monthColumns[month].push(result.netProfit)
      totalPayoutsApproved += result.payoutDetails.approvedCount
    }
    
    allMonthlyProfits.push(monthProfits)
    totalAccountsCreated += ctx.totalEverCreated
    ctx.accountStates.forEach(s => { if (s.completedByCapHit) totalCapHits++ })
  }
  
  // Compute per-month percentile bands
  for (let m = 0; m < months; m++) {
    const sorted = [...monthColumns[m]].sort((a, b) => a - b)
    monthlyBands.push({
      p5: sorted[Math.floor(sorted.length * 0.05)],
      p50: sorted[Math.floor(sorted.length * 0.50)],
      p95: sorted[Math.floor(sorted.length * 0.95)],
      mean: sorted.reduce((a, b) => a + b, 0) / sorted.length,
    })
  }
  
  // Aggregate stats
  const allProfits = allMonthlyProfits.flat()
  const sortedProfits = [...allProfits].sort((a, b) => a - b)
  const mean = allProfits.reduce((a, b) => a + b, 0) / allProfits.length
  const p5 = sortedProfits[Math.floor(sortedProfits.length * 0.05)]
  const p50 = sortedProfits[Math.floor(sortedProfits.length * 0.50)]
  const p95 = sortedProfits[Math.floor(sortedProfits.length * 0.95)]
  const variance = allProfits.reduce((sum, p) => sum + Math.pow(p - mean, 2), 0) / allProfits.length
  const stdDev = Math.sqrt(variance)
  
  const lossMonths = allProfits.filter(p => p < 0).length
  const probabilityOfLoss = lossMonths / allProfits.length
  const worstMonth = Math.min(...allProfits)
  const bestMonth = Math.max(...allProfits)
  
  let maxDrawdown = 0, maxConsecutiveLoss = 0
  for (const iterProfits of allMonthlyProfits) {
    let cum = 0, peak = 0, consLoss = 0
    for (const profit of iterProfits) {
      cum += profit
      peak = Math.max(peak, cum)
      maxDrawdown = Math.max(maxDrawdown, peak - cum)
      if (profit < 0) { consLoss++; maxConsecutiveLoss = Math.max(maxConsecutiveLoss, consLoss) }
      else consLoss = 0
    }
  }
  
  // Reserve breach probability: % of iterations where cumulative profit ever drops below -threshold
  let reserveBreaches = 0
  for (const iterProfits of allMonthlyProfits) {
    let cum = 0
    for (const profit of iterProfits) {
      cum += profit
      if (cum < -reserveThreshold) { reserveBreaches++; break }
    }
  }
  const reserveBreachProbability = reserveBreaches / iterations
  
  // 12-month cumulative profit distribution  
  const cumulativeProfits = allMonthlyProfits.map(mp => mp.reduce((a, b) => a + b, 0))
  const sortedCumulative = [...cumulativeProfits].sort((a, b) => a - b)
  const annualP5 = sortedCumulative[Math.floor(sortedCumulative.length * 0.05)]
  const annualP50 = sortedCumulative[Math.floor(sortedCumulative.length * 0.50)]
  const annualP95 = sortedCumulative[Math.floor(sortedCumulative.length * 0.95)]
  const annualLossProb = cumulativeProfits.filter(p => p < 0).length / cumulativeProfits.length
  
  // Histogram of annual profits
  const bucketSize = 5000
  const histogram: { bucket: number; count: number }[] = []
  const buckets: Record<number, number> = {}
  for (const cp of cumulativeProfits) {
    const b = Math.floor(cp / bucketSize) * bucketSize
    buckets[b] = (buckets[b] || 0) + 1
  }
  for (const [b, count] of Object.entries(buckets)) {
    histogram.push({ bucket: Number(b), count })
  }
  histogram.sort((a, b) => a.bucket - b.bucket)
  
  return {
    profit: { mean, p5, p50, p95, stdDev },
    risk: { probabilityOfLoss, maxDrawdown, worstMonth, bestMonth, consecutiveLossMonths: maxConsecutiveLoss },
    reserve: { breachProbability: reserveBreachProbability, threshold: reserveThreshold },
    annual: { p5: annualP5, p50: annualP50, p95: annualP95, lossProb: annualLossProb, mean: mean * months },
    monthlyBands,
    histogram,
    diagnostics: {
      avgPayoutsPerAccount: totalAccountsCreated > 0 ? totalPayoutsApproved / totalAccountsCreated : 0,
      lifetimeCapHitRate: totalAccountsCreated > 0 ? totalCapHits / totalAccountsCreated : 0,
    },
  }
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
  
  // Auth: require staff role
  const authHeader = req.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  }

  const jwt = authHeader.replace('Bearer ', '')
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!

  // Use anon key + JWT for proper token validation (canonical pattern)
  const anonClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  })
  const serviceClient = createClient(
    supabaseUrl,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )

  // Verify caller identity via getUser (not getClaims which doesn't exist)
  const { data: userData, error: userError } = await anonClient.auth.getUser()
  if (userError || !userData?.user) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  }
  const userId = userData.user.id

  // Check admin/risk_officer role
  const { data: isAdmin } = await serviceClient.rpc('has_role', { _user_id: userId, _role: 'admin' })
  const { data: isRisk } = await serviceClient.rpc('has_role', { _user_id: userId, _role: 'risk_officer' })
  if (isAdmin !== true && isRisk !== true) {
    return new Response(JSON.stringify({ error: 'Forbidden: admin or risk_officer required' }), { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  }

  try {
    const body: SimulationRequest = await req.json().catch(() => ({}))
    const iterations = Math.min(body.iterations ?? 2000, 5000) // cap at 5000
    const months = Math.min(body.months ?? 12, 36)
    const seed = body.seed ?? 42
    const reserveThreshold = body.reserve_threshold ?? 16000

    // Fetch real cohort configs
    const { data: cohorts, error: cohortError } = await serviceClient
      .from('cohorts')
      .select('*')
      .eq('is_active', true)
      .order('cohort_phase')

    if (cohortError) throw new Error(`Failed to fetch cohorts: ${cohortError.message}`)
    
    const cohortConfigs: CohortConfig[] = (cohorts || []).map((c: Record<string, unknown>) => ({
      id: c.id as string,
      name: c.name as string,
      cohort_phase: c.cohort_phase as string,
      entry_fee: c.entry_fee as number | null,
      payout_split_percent: c.payout_split_percent as number,
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

    // Derive assumptions from real cohort data
    const assumptions = cohortToAssumptions(cohortConfigs, body.overrides)

    // Run simulation
    const results = runSimulation(iterations, months, seed, assumptions, reserveThreshold)

    // Persist to simulation_runs (service role bypasses RLS)
    const { data: inserted, error: insertError } = await serviceClient
      .from('simulation_runs')
      .insert({
        seed,
        iterations,
        months_per_iteration: months,
        assumptions: assumptions as unknown,
        cohort_configs: cohortConfigs as unknown,
        profit_mean: results.profit.mean,
        profit_p5: results.profit.p5,
        profit_p50: results.profit.p50,
        profit_p95: results.profit.p95,
        profit_std_dev: results.profit.stdDev,
        probability_of_loss: results.risk.probabilityOfLoss,
        max_drawdown: results.risk.maxDrawdown,
        worst_month: results.risk.worstMonth,
        best_month: results.risk.bestMonth,
        consecutive_loss_months: results.risk.consecutiveLossMonths,
        reserve_breach_probability: results.reserve.breachProbability,
        reserve_threshold: reserveThreshold,
        full_results: results as unknown,
        triggered_by: userId,
        duration_ms: Date.now() - startTime,
      })
      .select('id')
      .single()

    if (insertError) {
      console.error('Failed to persist simulation:', insertError)
    }

    return new Response(
      JSON.stringify({
        success: true,
        run_id: inserted?.id ?? null,
        duration_ms: Date.now() - startTime,
        config: { iterations, months, seed, reserveThreshold },
        assumptions_source: cohortConfigs.length > 0 ? 'derived_from_cohorts' : 'defaults',
        cohorts_used: cohortConfigs.map(c => ({ id: c.id, name: c.name, phase: c.cohort_phase })),
        results,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (err) {
    const error = err as Error
    console.error('Simulation error:', error)
    return new Response(
      JSON.stringify({ error: error.message || 'Simulation failed' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
