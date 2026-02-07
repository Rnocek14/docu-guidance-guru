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
// FAST DISTRIBUTIONS (no rejection sampling)
// ============================================================================

/** Box-Muller normal */
function normal(random: () => number): number {
  const u1 = random() || 1e-10
  const u2 = random()
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
}

/** Triangular draw approximated via normal with matching mean/variance — O(1) */
function triangularDraw(random: () => number, min: number, mode: number, max: number): number {
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
// COHORT-AGGREGATE SIMULATION ENGINE
// ============================================================================
// Instead of tracking individual accounts (O(iterations × months × accounts)),
// we model cohort-level flows using expected-value math with stochastic draws
// for rates. This is O(iterations × months) — ~1000x faster.
//
// Each month we track:
//   - eligiblePool: # of accounts eligible for payouts
//   - firstPayoutPool: subset that haven't had a payout yet
//   - lifetimePaidPool: cumulative $ paid to the cohort (for cap modeling)
// ============================================================================

interface CohortState {
  eligiblePool: number
  firstPayoutPool: number       // accounts that haven't had their first payout
  monthsActive: number          // months since this cohort entered
  totalPaid: number             // lifetime total paid to this cohort batch
  totalAccounts: number         // total accounts in this batch (for cap math)
}

function simulateMonthAggregate(
  assumptions: SimAssumptions,
  random: () => number,
  cohorts: CohortState[],
  monthIndex: number,
): { netProfit: number; totalPayouts: number; payoutRequests: number; capHits: number } {
  const { knobs } = assumptions

  // --- Revenue ---
  const revenue = assumptions.accountsPerMonth * assumptions.pricePerAccount

  // --- Draw stochastic rates for this month ---
  const passRate = triangularDraw(random, assumptions.passRate.min, assumptions.passRate.mode, assumptions.passRate.max)
  const payoutReqRate = triangularDraw(random, assumptions.payoutRequestRate.min, assumptions.payoutRequestRate.mode, assumptions.payoutRequestRate.max)
  const fraudAttemptRate = triangularDraw(random, assumptions.fraudAttemptRate.min, assumptions.fraudAttemptRate.mode, assumptions.fraudAttemptRate.max)
  const fraudSuccessRate = triangularDraw(random, assumptions.fraudSuccessRate.min, assumptions.fraudSuccessRate.mode, assumptions.fraudSuccessRate.max)
  const chargebackRate = triangularDraw(random, assumptions.chargebackRate.min, assumptions.chargebackRate.mode, assumptions.chargebackRate.max)
  const payoutsPerAcct = triangularDraw(random, assumptions.payoutsPerPaidAccountPerMonth.min, assumptions.payoutsPerPaidAccountPerMonth.mode, assumptions.payoutsPerPaidAccountPerMonth.max)

  // --- New accounts passing this month ---
  const newPassed = Math.round(assumptions.accountsPerMonth * passRate)
  const eligibilityLag = Math.ceil(assumptions.avgDaysToFirstPayout / 30)
  const effectiveLag = eligibilityLag + knobs.verificationMonths

  // Add new cohort batch (will become eligible after lag)
  cohorts.push({
    eligiblePool: 0,
    firstPayoutPool: newPassed,
    monthsActive: 0,
    totalPaid: 0,
    totalAccounts: newPassed,
  })

  // --- Process existing cohorts ---
  let totalPayouts = 0
  let totalPayoutRequests = 0
  let totalCapHits = 0
  let resetRevenue = 0
  const monthlyResetFrac = 1 - Math.pow(1 - assumptions.resetRate, 1 / 12)

  for (const cohort of cohorts) {
    cohort.monthsActive++

    // Verification failure
    if (cohort.monthsActive <= knobs.verificationMonths && knobs.verificationFailRate > 0) {
      const failedCount = cohort.firstPayoutPool * knobs.verificationFailRate
      cohort.firstPayoutPool -= failedCount
      cohort.totalAccounts -= failedCount
    }

    // Promote to eligible after lag
    if (cohort.monthsActive === effectiveLag + 1 && cohort.firstPayoutPool > 0) {
      cohort.eligiblePool += cohort.firstPayoutPool
    }

    if (cohort.eligiblePool <= 0) continue

    // Resets
    const resets = cohort.eligiblePool * monthlyResetFrac
    cohort.eligiblePool -= resets
    resetRevenue += resets * knobs.resetPrice
    // Some resets come back as first-payout eligible later (simplified: immediate)
    cohort.eligiblePool += resets * 0.5  // ~50% retry
    cohort.firstPayoutPool += resets * 0.5

    // Lifetime cap check
    const lifetimeCap = knobs.lifetimeCapPerUser
    if (lifetimeCap !== null && cohort.totalAccounts > 0) {
      const avgPaidPerAccount = cohort.totalPaid / cohort.totalAccounts
      if (avgPaidPerAccount >= lifetimeCap) {
        totalCapHits += cohort.eligiblePool
        cohort.eligiblePool = 0
        continue
      }
    }

    // Payout requests
    const requesting = cohort.eligiblePool * payoutReqRate

    // Velocity gate attrition (approximate fraction that pass gates)
    let gatePassRate = 1.0
    if (knobs.minMonthsBetweenPayouts > 1) {
      gatePassRate *= Math.min(1, 1 / knobs.minMonthsBetweenPayouts)
    }

    const approved = requesting * gatePassRate
    totalPayoutRequests += approved

    // Payout amounts
    const numPayouts = approved * Math.max(1, payoutsPerAcct)
    let monthPayout = 0

    // Batch payout: draw average payout size, apply caps
    const avgRaw = logNormalDraw(random, assumptions.avgPayoutAmount.mean, assumptions.avgPayoutAmount.stdDev)
    let avgTraderPayout = avgRaw * knobs.payoutSplitPercent

    // First-payout cap: fraction of payouts that are first payouts
    const firstPayoutFrac = cohort.firstPayoutPool / Math.max(1, cohort.eligiblePool)
    if (knobs.firstPayoutCap !== null) {
      const cappedPayout = Math.min(avgTraderPayout, knobs.firstPayoutCap)
      avgTraderPayout = avgTraderPayout * (1 - firstPayoutFrac) + cappedPayout * firstPayoutFrac
    }

    // Lifetime cap headroom
    if (lifetimeCap !== null && cohort.totalAccounts > 0) {
      const avgHeadroom = lifetimeCap - (cohort.totalPaid / cohort.totalAccounts)
      avgTraderPayout = Math.min(avgTraderPayout, Math.max(0, avgHeadroom))
    }

    monthPayout = numPayouts * avgTraderPayout
    totalPayouts += monthPayout
    cohort.totalPaid += monthPayout

    // Move first-payout accounts to repeat pool
    const firstPayoutsThisMonth = cohort.firstPayoutPool * payoutReqRate * gatePassRate
    cohort.firstPayoutPool = Math.max(0, cohort.firstPayoutPool - firstPayoutsThisMonth)
  }

  // --- Fraud & chargebacks ---
  const totalEligible = cohorts.reduce((sum, c) => sum + c.eligiblePool, 0)
  const fraudLoss = totalEligible * fraudAttemptRate * fraudSuccessRate *
    logNormalDraw(random, assumptions.avgPayoutAmount.mean * 1.3, assumptions.avgPayoutAmount.stdDev * 1.5) *
    knobs.payoutSplitPercent
  const chargebacks = revenue * chargebackRate
  const variableCosts = assumptions.accountsPerMonth * assumptions.variableCostPerAccount
  const fixedCosts = assumptions.fixedMonthlyCosts

  const netProfit = revenue + resetRevenue - totalPayouts - fraudLoss - chargebacks - variableCosts - fixedCosts

  return { netProfit, totalPayouts, payoutRequests: totalPayoutRequests, capHits: totalCapHits }
}

function runSimulation(
  iterations: number, months: number, seed: number,
  assumptions: SimAssumptions, reserveThreshold: number,
) {
  const monthColumns: number[][] = Array.from({ length: months }, () => [])
  const allIterProfits: number[] = []   // cumulative per iteration
  let totalPayoutsApproved = 0
  let totalCapHits = 0
  const totalAccountsPerIter = assumptions.accountsPerMonth * months

  for (let iter = 0; iter < iterations; iter++) {
    const random = mulberry32(seed + iter)
    const cohorts: CohortState[] = []
    let cumProfit = 0

    for (let month = 0; month < months; month++) {
      const result = simulateMonthAggregate(assumptions, random, cohorts, month)
      monthColumns[month].push(result.netProfit)
      cumProfit += result.netProfit
      totalPayoutsApproved += result.payoutRequests
      totalCapHits += result.capHits
    }
    allIterProfits.push(cumProfit)
  }

  // --- Compute stats ---
  // Monthly stats (flatten all month data)
  const allMonthly: number[] = []
  const monthlyBands: { p5: number; p50: number; p95: number; mean: number }[] = []
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

  // Max drawdown & consecutive loss (per iteration approximation from monthly bands)
  let maxDrawdown = 0, maxConsecutiveLoss = 0
  // Use per-iteration cumulative profits to compute drawdown
  // Reconstruct per-iteration month arrays from monthColumns
  for (let iter = 0; iter < iterations; iter++) {
    let cum = 0, peak = 0, consLoss = 0
    for (let m = 0; m < months; m++) {
      const profit = monthColumns[m][iter]
      cum += profit
      peak = Math.max(peak, cum)
      maxDrawdown = Math.max(maxDrawdown, peak - cum)
      if (profit < 0) { consLoss++; maxConsecutiveLoss = Math.max(maxConsecutiveLoss, consLoss) }
      else consLoss = 0
    }
  }

  // Reserve breach
  let reserveBreaches = 0
  for (let iter = 0; iter < iterations; iter++) {
    let cum = 0
    for (let m = 0; m < months; m++) {
      cum += monthColumns[m][iter]
      if (cum < -reserveThreshold) { reserveBreaches++; break }
    }
  }
  const reserveBreachProbability = reserveBreaches / iterations

  // Annual cumulative
  const sortedCum = allIterProfits.slice().sort((a, b) => a - b)
  const cLen = sortedCum.length
  const annualMean = sortedCum.reduce((a, b) => a + b, 0) / cLen
  const annualP5 = sortedCum[Math.floor(cLen * 0.05)]
  const annualP50 = sortedCum[Math.floor(cLen * 0.50)]
  const annualP95 = sortedCum[Math.floor(cLen * 0.95)]
  const annualLossProb = sortedCum.filter(p => p < 0).length / cLen

  // Histogram
  const bucketSize = 5000
  const buckets: Record<number, number> = {}
  for (const cp of allIterProfits) {
    const b = Math.floor(cp / bucketSize) * bucketSize
    buckets[b] = (buckets[b] || 0) + 1
  }
  const histogram = Object.entries(buckets)
    .map(([b, count]) => ({ bucket: Number(b), count }))
    .sort((a, b) => a.bucket - b.bucket)

  return {
    profit: { mean, p5, p50, p95, stdDev },
    risk: { probabilityOfLoss, maxDrawdown, worstMonth, bestMonth, consecutiveLossMonths: maxConsecutiveLoss },
    reserve: { breachProbability: reserveBreachProbability, threshold: reserveThreshold },
    annual: { p5: annualP5, p50: annualP50, p95: annualP95, lossProb: annualLossProb, mean: annualMean },
    monthlyBands,
    histogram,
    diagnostics: {
      avgPayoutsPerAccount: totalAccountsPerIter > 0 ? totalPayoutsApproved / (totalAccountsPerIter * iterations) : 0,
      lifetimeCapHitRate: totalAccountsPerIter > 0 ? totalCapHits / (totalAccountsPerIter * iterations) : 0,
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
    const iterations = Math.min(body.iterations ?? 2000, 5000)
    const months = Math.min(body.months ?? 12, 36)
    const seed = body.seed ?? 42
    const reserveThreshold = body.reserve_threshold ?? 16000

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
    const results = runSimulation(iterations, months, seed, assumptions, reserveThreshold)

    const { data: inserted, error: insertError } = await serviceClient
      .from('simulation_runs')
      .insert({
        seed, iterations, months_per_iteration: months,
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
        full_results: results as unknown, triggered_by: userId,
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
        config: { iterations, months, seed, reserveThreshold },
        assumptions_source: cohortConfigs.length > 0 ? 'derived_from_cohorts' : 'defaults',
        cohorts_used: cohortConfigs.map(c => ({ id: c.id, name: c.name, phase: c.cohort_phase })),
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
