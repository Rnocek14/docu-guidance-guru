// ============================================================
// Treasury Risk Projection — Scaling Velocity Simulator
//
// Multi-cohort, growth-aware, reserve-tracking treasury model.
// Answers: "what is the maximum safe scaling velocity?"
//
// This is NOT a per-trader Monte Carlo (run-simulation owns that).
// This is an analytical cohort-aging cashflow model that runs
// hundreds of scenarios in seconds so an operator can see the
// cliff between safe growth and breaker-driven collapse.
//
// Optimizes for SURVIVABILITY, not maximum growth.
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

// ---------- Breaker v1.2 (production constants) ----------
// MIRROR of PAY_REV_GUARDRAIL_V1 thresholds in src/lib/breaker-policy.ts.
// Numerical drift between this projection and production policy would
// invalidate reserve recommendations — if you change one, change both
// and re-run pre-launch audit.
const BREAKER = {
  L1_TRIGGER: 0.30,   // L0→L1 escalation: rolling Pay/Rev > 30% → tighten
  L2_TRIGGER: 0.45,   // L1→L2 escalation: rolling Pay/Rev > 45% → freeze
  L1_RELEASE: 0.25,   // L1→L0 release  : rolling Pay/Rev < 25% with hysteresis
  L2_RELEASE: 0.40,   // L2→L1 release  : rolling Pay/Rev < 40% with hysteresis
  L1_DEFER_FRACTION: 0.30, // L1 defers 30% of due payouts to next month
  L2_DEFER_FRACTION: 1.00, // L2 defers all payouts
}

// ---------- Baseline production economics (SSOT mirror) ----------
// Mirrors _shared/checkout/tier-economics.ts (Starter live tier)
const TIER = {
  entryFee: 149,
  resetFee: 99,
  splitPercent: 0.80,
  firstPayoutCap: 500,
  lifetimeCapAmount: 1_490,
  accountSize: 50_000,
  profitTargetPercent: 10,
}

// ---------- Cost-mode presets (Phase 1 v2) ----------
// "lean"     — solo founder, beta, no payroll, contract tools only
// "staffed"  — partial CS/ops support, mid-stage
// "scaled"   — production-aligned ops budget (matches production monte-carlo.ts)
const COST_MODE_OPEX: Record<'lean' | 'staffed' | 'scaled', number> = {
  lean: 3_000,
  staffed: 12_000,
  scaled: 18_000,
}

// ---------- Default trader-behavior assumptions ----------
// CALIBRATED TO PRODUCTION (2026-05-19 reconciliation).
// Mirrors src/lib/monte-carlo.ts DEFAULT_ASSUMPTIONS which is itself
// calibrated to QuantVPS/Tradeify/Topstep industry benchmarks (2026-03-02).
// If you change a value here, update both files AND the calibration test.
interface BehaviorAssumptions {
  passRate: number              // P(account passes evaluation in any given month)
  resetRateAnnual: number       // annual probability a failed account buys a reset
  monthlyChurn: number          // P(funded account stops trading in a month, no payout)
  // PRODUCTION-CALIBRATED PAYOUT MODEL (v2):
  //   only `payoutRequestRate` × funded ever become payout-active.
  //   active accounts request `payoutsPerActiveAccountPerMonth` per month,
  //   bounded above by `minMonthsBetweenPayouts` (cadence floor).
  //   every funded account is hard-capped at `lifetimeCapPerAccount` total paid.
  payoutRequestRate: number               // P(funded account ever becomes payout-active). prod=0.25
  payoutsPerActiveAccountPerMonth: number // per active requester, post-eligibility. prod=0.7
  minMonthsBetweenPayouts: number         // hard floor: 1 month in production (caps at 1.0)
  lifetimeCapPerAccount: number           // $ hard cap per funded account. prod=$1,490
  avgPayoutWhenPaid: number     // mean trader payout amount when one occurs
  affiliateCommissionPct: number
  chargebackRate: number        // share of revenue that becomes a chargeback (net rev penalty)
  refundRate: number            // share of revenue refunded outright
  fixedMonthlyOpex: number
  variableCostPerAccount: number
}

const DEFAULT_BEHAVIOR: BehaviorAssumptions = {
  // Pass rate — calibrated to 7% mode (industry: QuantVPS/Tradeify/Topstep)
  passRate: 0.07,
  resetRateAnnual: 0.18,
  monthlyChurn: 0.08,
  // Production calibration: only 25% of funded ever request a payout;
  // those who do request ~0.7 payouts/mo, capped at 1/mo cadence.
  payoutRequestRate: 0.25,
  payoutsPerActiveAccountPerMonth: 0.7,
  minMonthsBetweenPayouts: 1,
  // $1,490 lifetime cap per Starter tier account (TIER.lifetimeCapAmount).
  lifetimeCapPerAccount: 1_490,
  avgPayoutWhenPaid: 350,
  affiliateCommissionPct: 0.10, // blended (some sales attributed, some not)
  chargebackRate: 0.015,
  refundRate: 0.02,
  // Default to LEAN beta opex. Override via `costMode` input.
  fixedMonthlyOpex: COST_MODE_OPEX.lean,
  variableCostPerAccount: 8, // platform/data per funded account/month
}

// ---------- Inputs ----------
interface ProjectionInput {
  scenarioKey: string
  label?: string
  horizonMonths: number          // default 24
  startingReserve: number
  startingTraders: number        // existing funded accounts at month 0
  startingFunded?: number        // alias
  newSignupsMonth1: number       // base acquisition before growth compounding
  growthRateMoM: number          // e.g. 0.15 = 15% MoM
  affiliateSurgeMonth?: number | null   // month index of a viral spike
  affiliateSurgeMultiplier?: number     // multiplier on signups that month
  successParadoxEnabled: boolean        // pass-rate drift up over time
  successParadoxMonthlyDelta?: number   // additive +pass-rate per month, e.g. 0.003
  trials: number                        // Monte Carlo trials (we do analytic + noise)
  behavior?: Partial<BehaviorAssumptions>
  costMode?: 'lean' | 'staffed' | 'scaled'   // selects fixedMonthlyOpex preset
}

interface MonthState {
  month: number
  signups: number
  newFunded: number       // passed evaluations this month
  totalFunded: number     // funded accounts active at end of month
  grossRevenue: number    // entry fees + reset fees collected
  resetRevenue: number
  refunds: number
  chargebacks: number
  netRevenue: number      // gross - chargebacks (matches breaker numerator's denom basis)
  payoutsDueGross: number    // what traders earned this month
  payoutsDueNet: number      // after first-payout caps
  payoutsPaid: number        // actually paid (after breaker deferral)
  payoutsDeferred: number    // pushed to next month
  payoutQueueCarry: number   // cumulative deferred queue
  affiliateCommissions: number
  opex: number
  cashflow: number           // netRevenue - payoutsPaid - commissions - opex
  reserveEnd: number
  payRevRatio: number        // payoutsPaid / max(netRevenue, 1)
  breakerLevel: 'normal' | 'l1' | 'l2'
  effectivePassRate: number
}

interface ProjectionResult {
  months: MonthState[]
  scalingCheckpoints: Record<string, { month: number; reserveEnd: number; payoutQueueCarry: number } | null>
  worstMonthTrough: number
  worstLiabilityAdjustedTrough: number
  insolventMonth: number | null
  liabilityInsolventMonth: number | null
  breakerL1Months: number
  breakerL2Months: number
  finalFunded: number
  finalReserve: number
  totalRevenue: number
  totalPayoutsPaid: number
  totalResetRevenue: number
}

// ---------- Core cohort-aging simulator ----------
// Each month we age the funded population by:
//   - adding newly-funded (passed) accounts
//   - removing churned accounts
//   - computing aggregated payouts via behavior assumptions
// Then we apply the breaker to compute paid-vs-deferred.
function runSingleProjection(input: ProjectionInput, seed: number): ProjectionResult {
  // Merge: defaults → costMode opex preset → caller behavior overrides.
  const costModeOpex = input.costMode ? COST_MODE_OPEX[input.costMode] : undefined
  const beh: BehaviorAssumptions = {
    ...DEFAULT_BEHAVIOR,
    ...(costModeOpex !== undefined ? { fixedMonthlyOpex: costModeOpex } : {}),
    ...(input.behavior ?? {}),
  }
  const months: MonthState[] = []
  let reserve = input.startingReserve
  let funded = input.startingTraders
  let payoutQueue = 0
  // Stock of funded accounts that have never received a payout yet. Every
  // newly-funded account adds 1 to this pool; payouts probabilistically
  // drain it. Replaces the prior `newFunded / funded` proxy which assumed
  // only first-month accounts were ever cap-eligible.
  let firstPayoutPool = input.startingTraders
  // ---- v2 lifetime-cap accounting (aggregate, not per-account) ----
  // We track the total lifetime PAYOUT HEADROOM available across every
  // funded account that has ever existed in the population. Each funded
  // account contributes `lifetimeCapPerAccount × payoutRequestRate` of
  // expected lifetime obligation (only the requesting share can extract).
  // `cumulativeDueEver` is decremented from this stock; when it hits zero
  // the population is fully cap-bound and no further payouts can accrue.
  let lifetimeHeadroomStock = input.startingTraders * beh.lifetimeCapPerAccount * beh.payoutRequestRate
  let cumulativeDueEver = 0
  let worstTrough = reserve
  // Liability-adjusted trough: reserve minus outstanding deferred-payout queue.
  // The bare reserve curve understates risk because deferred payouts are
  // liabilities, not retained profit. This is the load-bearing metric.
  let worstLiabilityAdjustedTrough = reserve
  let insolventMonth: number | null = null
  let liabilityInsolventMonth: number | null = null
  let l1Count = 0
  let l2Count = 0
  let totalRev = 0
  let totalPaid = 0
  let totalReset = 0

  // simple deterministic noise per seed
  const noise = (m: number, salt: number) => {
    const x = Math.sin(seed * 9301 + m * 49297 + salt * 233280) * 43758.5453
    return (x - Math.floor(x)) * 2 - 1  // [-1, 1]
  }

  // running 3-month rolling Pay/Rev (matches production breaker window approx.)
  const recentRev: number[] = []
  const recentPaid: number[] = []
  let breakerLevel: MonthState['breakerLevel'] = 'normal'

  for (let m = 1; m <= input.horizonMonths; m++) {
    // --- 0. Breaker evaluation FIRST (uses rolling Pay/Rev from prior months) ---
    // Done before acquisition so we can throttle intake under freeze.
    const rollingRev = recentRev.reduce((a, b) => a + b, 0)
    const rollingPaid = recentPaid.reduce((a, b) => a + b, 0)
    const rollingRatio = rollingRev > 0 ? rollingPaid / rollingRev : 0

    if (breakerLevel === 'normal') {
      if (rollingRatio > BREAKER.L2_TRIGGER) breakerLevel = 'l2'
      else if (rollingRatio > BREAKER.L1_TRIGGER) breakerLevel = 'l1'
    } else if (breakerLevel === 'l1') {
      if (rollingRatio > BREAKER.L2_TRIGGER) breakerLevel = 'l2'
      else if (rollingRatio < BREAKER.L1_RELEASE) breakerLevel = 'normal'
    } else if (breakerLevel === 'l2') {
      if (rollingRatio < BREAKER.L2_RELEASE) breakerLevel = 'l1'
    }

    if (breakerLevel === 'l1') l1Count++
    if (breakerLevel === 'l2') l2Count++

    // --- 1. Acquisition (growth-compounded) ---
    const growthFactor = Math.pow(1 + input.growthRateMoM, m - 1)
    let signups = input.newSignupsMonth1 * growthFactor
    if (input.affiliateSurgeMonth === m && input.affiliateSurgeMultiplier) {
      signups *= input.affiliateSurgeMultiplier
    }
    signups *= 1 + noise(m, 1) * 0.05 // ±5% acquisition jitter
    // Acquisition throttle under breaker: payout freezes erode social trust,
    // affiliate intake slows, public Discords notice. Modeling sustained
    // intake during a freeze creates a false-positive treasury survivability
    // shape (catastrophic > baseline). Mirrors Operations Playbook intake lock.
    if (breakerLevel === 'l1') signups *= 0.70
    else if (breakerLevel === 'l2') signups *= 0.20
    signups = Math.max(0, signups)

    // --- 2. Pass-rate (with optional success-paradox drift) ---
    let effectivePass = beh.passRate
    if (input.successParadoxEnabled) {
      effectivePass += (input.successParadoxMonthlyDelta ?? 0.003) * (m - 1)
    }
    effectivePass = Math.min(0.45, Math.max(0.02, effectivePass + noise(m, 2) * 0.01))

    // --- 3. Funnel: signups -> evaluations -> funded ---
    // Evaluations take ~5–20 days; assume 1-month lag is roughly absorbed by passRate.
    const newFunded = signups * effectivePass
    const churnedThisMonth = funded * beh.monthlyChurn
    const churnedFirstPayoutShare = funded > 0 ? firstPayoutPool / funded : 0
    firstPayoutPool = Math.max(
      0,
      firstPayoutPool - churnedThisMonth * churnedFirstPayoutShare + newFunded
    )
    funded = Math.max(0, funded - churnedThisMonth + newFunded)
    // Extend lifetime payout headroom for newly funded accounts.
    // Only the `payoutRequestRate` share will ever extract, so the obligation
    // stock grows by `newFunded × lifetimeCap × payoutRequestRate`.
    lifetimeHeadroomStock += newFunded * beh.lifetimeCapPerAccount * beh.payoutRequestRate

    // --- 4. Revenue ---
    const entryRevenue = signups * TIER.entryFee
    // Failed accounts who reset = signups * (1 - passRate) * monthlyResetProb
    const monthlyResetProb = 1 - Math.pow(1 - beh.resetRateAnnual, 1 / 12)
    const resetRevenue = signups * (1 - effectivePass) * monthlyResetProb * TIER.resetFee
    const refunds = entryRevenue * beh.refundRate
    const chargebacks = entryRevenue * beh.chargebackRate
    const grossRevenue = entryRevenue + resetRevenue - refunds
    const netRevenue = Math.max(0, grossRevenue - chargebacks)

    // --- 5. Payouts owed this month (v2: requester-fraction + cadence floor + lifetime cap) ---
    //
    // Production constraints applied:
    //   (a) payoutRequestRate     — only X% of funded ever request a payout
    //   (b) minMonthsBetweenPayouts — hard cap on requests/active/month
    //   (c) firstPayoutCap         — caps trader receipts on first payout
    //   (d) lifetimeCapPerAccount  — hard $ ceiling per funded account ever
    //
    // The population of payout-active accounts is `funded × payoutRequestRate`.
    // Their per-month request rate is `payoutsPerActiveAccountPerMonth`, but
    // bounded above by the cadence floor `1 / minMonthsBetweenPayouts`.
    const cadenceCap = beh.minMonthsBetweenPayouts > 0
      ? 1 / beh.minMonthsBetweenPayouts
      : Infinity
    const effectivePayoutsPerActive = Math.min(beh.payoutsPerActiveAccountPerMonth, cadenceCap)
    const activeRequesters = funded * beh.payoutRequestRate
    const payoutRequestsThisMonth = activeRequesters * effectivePayoutsPerActive
    const firstPayoutShare = funded > 0
      ? Math.min(1, firstPayoutPool / funded)
      : 0
    const cappedAvgPayout =
      firstPayoutShare * Math.min(TIER.firstPayoutCap, beh.avgPayoutWhenPaid) +
      (1 - firstPayoutShare) * beh.avgPayoutWhenPaid

    const payoutsDueGross = payoutRequestsThisMonth * beh.avgPayoutWhenPaid
    let payoutsDueNetThisMonth = payoutRequestsThisMonth * cappedAvgPayout
    // Apply aggregate lifetime cap: cannot exceed remaining headroom in the
    // population's lifetime payout stock. Once exhausted, the funded base is
    // structurally retired from payout obligation.
    const headroomRemaining = Math.max(0, lifetimeHeadroomStock - cumulativeDueEver)
    if (payoutsDueNetThisMonth > headroomRemaining) {
      payoutsDueNetThisMonth = headroomRemaining
    }
    cumulativeDueEver += payoutsDueNetThisMonth
    const payoutsDueNet = payoutsDueNetThisMonth + payoutQueue // queued joins this month's bill

    // Drain the first-payout pool by the share of this month's requests that
    // were first payouts (not by amount).
    // If we got bound by the lifetime-cap headroom this month, scale down
    // first-payout consumption proportionally so the pool doesn't drain
    // faster than dollars actually accrued.
    const scale = payoutRequestsThisMonth > 0 && payoutsDueGross > 0
      ? Math.min(1, payoutsDueNetThisMonth / Math.max(1, payoutRequestsThisMonth * cappedAvgPayout))
      : 1
    const firstPayoutsConsumed = payoutRequestsThisMonth * firstPayoutShare * scale
    firstPayoutPool = Math.max(0, firstPayoutPool - firstPayoutsConsumed)

    // --- 6. Breaker evaluation (uses rolling Pay/Rev based on PRIOR months) ---
    // (Moved to top of loop so acquisition can be throttled under breaker.)
    // --- 7. Apply breaker: how much we actually pay ---
    let deferralFraction = 0
    if (breakerLevel === 'l1') deferralFraction = BREAKER.L1_DEFER_FRACTION
    if (breakerLevel === 'l2') deferralFraction = BREAKER.L2_DEFER_FRACTION

    const payoutsPaid = payoutsDueNet * (1 - deferralFraction)
    const payoutsDeferred = payoutsDueNet * deferralFraction
    payoutQueue = payoutsDeferred

    // --- 8. Commissions + opex + reserve ---
    const affiliateCommissions = entryRevenue * beh.affiliateCommissionPct
    const opex = beh.fixedMonthlyOpex + funded * beh.variableCostPerAccount
    const cashflow = netRevenue - payoutsPaid - affiliateCommissions - opex
    reserve += cashflow

    // Horizon-end queue drain: any remaining deferred-payout queue at the
    // final month must be booked against reserve. Otherwise the model lets
    // unpaid liabilities vanish off the right edge of the chart.
    if (m === input.horizonMonths && payoutQueue > 0) {
      reserve -= payoutQueue
      payoutQueue = 0
    }

    if (reserve < worstTrough) worstTrough = reserve
    if (insolventMonth === null && reserve < 0) insolventMonth = m
    const liabilityAdjusted = reserve - payoutQueue
    if (liabilityAdjusted < worstLiabilityAdjustedTrough) {
      worstLiabilityAdjustedTrough = liabilityAdjusted
    }
    if (liabilityInsolventMonth === null && liabilityAdjusted < 0) {
      liabilityInsolventMonth = m
    }

    // Roll the windows (keep last 3 months for breaker ratio)
    recentRev.push(netRevenue)
    recentPaid.push(payoutsPaid)
    if (recentRev.length > 3) { recentRev.shift(); recentPaid.shift() }

    totalRev += grossRevenue
    totalPaid += payoutsPaid
    totalReset += resetRevenue

    months.push({
      month: m,
      signups: Math.round(signups),
      newFunded: Math.round(newFunded),
      totalFunded: Math.round(funded),
      grossRevenue: round2(grossRevenue),
      resetRevenue: round2(resetRevenue),
      refunds: round2(refunds),
      chargebacks: round2(chargebacks),
      netRevenue: round2(netRevenue),
      payoutsDueGross: round2(payoutsDueGross),
      payoutsDueNet: round2(payoutsDueNet),
      payoutsPaid: round2(payoutsPaid),
      payoutsDeferred: round2(payoutsDeferred),
      payoutQueueCarry: round2(payoutQueue),
      affiliateCommissions: round2(affiliateCommissions),
      opex: round2(opex),
      cashflow: round2(cashflow),
      reserveEnd: round2(reserve),
      payRevRatio: round4(rollingRatio),
      breakerLevel,
      effectivePassRate: round4(effectivePass),
    })
  }

  // Scaling checkpoints: when does funded count first cross each tier?
  const checkpoints: Record<string, { month: number; reserveEnd: number; payoutQueueCarry: number } | null> = {
    '100': null, '500': null, '1000': null, '5000': null,
  }
  for (const m of months) {
    for (const tier of [100, 500, 1000, 5000]) {
      const key = String(tier)
      if (checkpoints[key] === null && m.totalFunded >= tier) {
        checkpoints[key] = {
          month: m.month,
          reserveEnd: m.reserveEnd,
          payoutQueueCarry: m.payoutQueueCarry,
        }
      }
    }
  }

  return {
    months,
    scalingCheckpoints: checkpoints,
    worstMonthTrough: round2(worstTrough),
    worstLiabilityAdjustedTrough: round2(worstLiabilityAdjustedTrough),
    insolventMonth,
    liabilityInsolventMonth,
    breakerL1Months: l1Count,
    breakerL2Months: l2Count,
    finalFunded: months[months.length - 1]?.totalFunded ?? 0,
    finalReserve: round2(reserve),
    totalRevenue: round2(totalRev),
    totalPayoutsPaid: round2(totalPaid),
    totalResetRevenue: round2(totalReset),
  }
}

// ---------- Multi-trial wrapper (Monte Carlo over noise) ----------
function runMonteCarlo(input: ProjectionInput) {
  const trials = Math.max(1, Math.min(500, input.trials ?? 100))
  const results: ProjectionResult[] = []
  for (let t = 0; t < trials; t++) {
    results.push(runSingleProjection(input, t + 1))
  }

  // Aggregate per-month percentiles for reserve and payouts
  const horizon = input.horizonMonths
  const reserveByMonth: number[][] = Array.from({ length: horizon }, () => [])
  const fundedByMonth: number[][] = Array.from({ length: horizon }, () => [])
  const payoutsPaidByMonth: number[][] = Array.from({ length: horizon }, () => [])
  const queueByMonth: number[][] = Array.from({ length: horizon }, () => [])

  for (const r of results) {
    r.months.forEach((m, idx) => {
      reserveByMonth[idx].push(m.reserveEnd)
      fundedByMonth[idx].push(m.totalFunded)
      payoutsPaidByMonth[idx].push(m.payoutsPaid)
      queueByMonth[idx].push(m.payoutQueueCarry)
    })
  }

  const monthlyAggregates = reserveByMonth.map((arr, idx) => ({
    month: idx + 1,
    reserve_p5: percentile(arr, 5),
    reserve_p50: percentile(arr, 50),
    reserve_p95: percentile(arr, 95),
    funded_p50: percentile(fundedByMonth[idx], 50),
    payoutsPaid_p50: percentile(payoutsPaidByMonth[idx], 50),
    payoutsPaid_p95: percentile(payoutsPaidByMonth[idx], 95),
    queue_p50: percentile(queueByMonth[idx], 50),
    queue_p95: percentile(queueByMonth[idx], 95),
  }))

  const insolventCount = results.filter(r => r.insolventMonth !== null).length
  const survivalRate = 1 - insolventCount / trials

  // Reserve recommendations. We use the LIABILITY-ADJUSTED trough
  // (reserve - outstanding deferred payout queue) as the source of truth.
  // The bare reserve trough understates risk because it counts deferred
  // payouts as "retained cash" rather than as obligations owed.
  const troughs = results.map(r => r.worstLiabilityAdjustedTrough)
  troughs.sort((a, b) => a - b)
  const reserveCatastrophic = troughs[0]
  const reserveStress = percentile(troughs, 5)
  const reserveRecommended = percentile(troughs, 50)

  // Keep cash-only troughs available for diagnostics / chart parity.
  const cashTroughs = results.map(r => r.worstMonthTrough).sort((a, b) => a - b)

  // Required reserve to NEVER go negative under each scenario.
  // If trough is negative, required additional capital = abs(trough).
  const requiredAdditional = (t: number) => t < 0 ? Math.abs(t) : 0

  return {
    monthlyAggregates,
    survivalRate: round4(survivalRate),
    trials,
    insolventCount,
    medianResult: results[Math.floor(trials / 2)],
    worstResult: results.reduce((a, b) => (a.worstLiabilityAdjustedTrough < b.worstLiabilityAdjustedTrough ? a : b)),
    reserve: {
      recommended_trough: round2(reserveRecommended),
      stress_trough_p5: round2(reserveStress),
      catastrophic_trough: round2(reserveCatastrophic),
      required_additional_recommended: round2(requiredAdditional(reserveRecommended)),
      required_additional_stress: round2(requiredAdditional(reserveStress)),
      required_additional_catastrophic: round2(requiredAdditional(reserveCatastrophic)),
      // Cash-only troughs (pre-liability-adjustment) for transparency.
      cash_only_recommended_trough: round2(percentile(cashTroughs, 50)),
      cash_only_stress_trough_p5: round2(percentile(cashTroughs, 5)),
      cash_only_catastrophic_trough: round2(cashTroughs[0]),
      methodology: 'liability_adjusted_v2_lifetime_capped',
    },
    breaker: {
      avg_l1_months: round2(results.reduce((s, r) => s + r.breakerL1Months, 0) / trials),
      avg_l2_months: round2(results.reduce((s, r) => s + r.breakerL2Months, 0) / trials),
      pct_runs_with_l2: round4(results.filter(r => r.breakerL2Months > 0).length / trials),
    },
    scalingCheckpoints_p50: aggregateCheckpoints(results),
  }
}

function aggregateCheckpoints(results: ProjectionResult[]) {
  const tiers = ['100', '500', '1000', '5000']
  const out: Record<string, { month: number; reserveEnd: number; reached_pct: number } | null> = {}
  for (const tier of tiers) {
    const reached = results.filter(r => r.scalingCheckpoints[tier] !== null)
    if (reached.length === 0) { out[tier] = null; continue }
    const months = reached.map(r => r.scalingCheckpoints[tier]!.month).sort((a, b) => a - b)
    const reserves = reached.map(r => r.scalingCheckpoints[tier]!.reserveEnd).sort((a, b) => a - b)
    out[tier] = {
      month: months[Math.floor(months.length / 2)],
      reserveEnd: round2(reserves[Math.floor(reserves.length / 2)]),
      reached_pct: round4(reached.length / results.length),
    }
  }
  return out
}

// ---------- Growth velocity sweep ----------
// Holds inputs fixed, sweeps growthRateMoM, returns the survival curve.
function runGrowthVelocitySweep(base: ProjectionInput) {
  const rates = [0.0, 0.05, 0.10, 0.15, 0.20, 0.30, 0.40, 0.60, 0.80, 1.00]
  return rates.map(r => {
    const mc = runMonteCarlo({ ...base, growthRateMoM: r, trials: Math.min(50, base.trials) })
    return {
      growthRateMoM: r,
      survivalRate: mc.survivalRate,
      reserve_stress_trough: mc.reserve.stress_trough_p5,
      avg_l2_months: mc.breaker.avg_l2_months,
      pct_runs_with_l2: mc.breaker.pct_runs_with_l2,
    }
  })
}

// ---------- Pass-rate × reset-rate sensitivity grid ----------
function runSensitivityGrid(base: ProjectionInput) {
  const passRates = [0.06, 0.10, 0.14, 0.18, 0.22]
  const resetRates = [0.05, 0.12, 0.20, 0.30, 0.45]
  const grid: Array<{ passRate: number; resetRate: number; survivalRate: number; trough: number }> = []
  for (const pr of passRates) {
    for (const rr of resetRates) {
      const mc = runMonteCarlo({
        ...base,
        trials: 30,
        behavior: { ...(base.behavior ?? {}), passRate: pr, resetRateAnnual: rr },
      })
      grid.push({
        passRate: pr,
        resetRate: rr,
        survivalRate: mc.survivalRate,
        trough: mc.reserve.stress_trough_p5,
      })
    }
  }
  return { passRates, resetRates, grid }
}

// ---------- Verdict builder ----------
function buildVerdict(base: ProjectionInput, baseMC: ReturnType<typeof runMonteCarlo>, velocity: ReturnType<typeof runGrowthVelocitySweep>) {
  // Safe growth ceiling = largest rate where survivalRate >= 0.95 AND pct_runs_with_l2 <= 0.10
  let safeCeiling = 0
  for (const v of velocity) {
    if (v.survivalRate >= 0.95 && v.pct_runs_with_l2 <= 0.10) safeCeiling = v.growthRateMoM
  }
  const insolventInBase = baseMC.medianResult.insolventMonth !== null

  const lines: string[] = []
  lines.push(
    `Safe MoM growth ceiling: ${(safeCeiling * 100).toFixed(0)}% ` +
    `(survival ≥95% and L2-freeze risk ≤10%).`,
  )
  lines.push(
    `At ${(base.growthRateMoM * 100).toFixed(0)}% MoM, survival ${(baseMC.survivalRate * 100).toFixed(0)}%, ` +
    `expected L2 freezes ${baseMC.breaker.avg_l2_months.toFixed(1)} mo over ${base.horizonMonths}.`,
  )
  lines.push(
    `Reserve trough — recommended $${fmt(baseMC.reserve.recommended_trough)}, ` +
    `stress P5 $${fmt(baseMC.reserve.stress_trough_p5)}, catastrophic $${fmt(baseMC.reserve.catastrophic_trough)}.`,
  )
  if (baseMC.reserve.required_additional_stress > 0) {
    lines.push(
      `⚠ Stress scenario requires +$${fmt(baseMC.reserve.required_additional_stress)} more reserve ` +
      `to avoid insolvency.`,
    )
  }
  if (insolventInBase) {
    lines.push(`🚨 BASE case goes insolvent in month ${baseMC.medianResult.insolventMonth}. Do not scale at this velocity.`)
  }

  return {
    safeGrowthCeilingPct: round4(safeCeiling),
    summary: lines.join(' '),
    lines,
    insolventInBase,
    survivalRate: baseMC.survivalRate,
  }
}

// ---------- Utils ----------
function round2(n: number) { return Math.round(n * 100) / 100 }
function round4(n: number) { return Math.round(n * 10000) / 10000 }
function fmt(n: number) {
  const abs = Math.abs(n)
  if (abs >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M'
  if (abs >= 1_000) return (n / 1_000).toFixed(1) + 'k'
  return n.toFixed(0)
}
function percentile(arr: number[], p: number) {
  if (arr.length === 0) return 0
  const sorted = [...arr].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)))
  return sorted[idx]
}

// ---------- HTTP handler ----------
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!
    const authHeader = req.headers.get('authorization') ?? ''

    // Verify caller is staff (risk_officer or admin)
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    })
    const { data: userResp, error: userErr } = await userClient.auth.getUser()
    if (userErr || !userResp?.user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }
    const userId = userResp.user.id
    const { data: hasRole, error: roleErr } = await userClient.rpc('has_any_role', {
      _user_id: userId,
      _roles: ['risk_officer', 'admin'],
    })
    if (roleErr || !hasRole) {
      return new Response(JSON.stringify({ error: 'Forbidden' }), {
        status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const body = await req.json().catch(() => ({}))
    const input: ProjectionInput = {
      scenarioKey: String(body.scenarioKey ?? 'custom'),
      label: body.label,
      horizonMonths: Number(body.horizonMonths ?? 24),
      startingReserve: Number(body.startingReserve ?? 25_000),
      startingTraders: Number(body.startingTraders ?? 0),
      newSignupsMonth1: Number(body.newSignupsMonth1 ?? 50),
      growthRateMoM: Number(body.growthRateMoM ?? 0.15),
      affiliateSurgeMonth: body.affiliateSurgeMonth ?? null,
      affiliateSurgeMultiplier: Number(body.affiliateSurgeMultiplier ?? 1),
      successParadoxEnabled: Boolean(body.successParadoxEnabled ?? false),
      successParadoxMonthlyDelta: Number(body.successParadoxMonthlyDelta ?? 0.003),
      trials: Number(body.trials ?? 100),
      behavior: body.behavior ?? {},
      costMode: (body.costMode as 'lean' | 'staffed' | 'scaled' | undefined) ?? 'lean',
    }

    // Bounds
    input.horizonMonths = Math.max(6, Math.min(36, input.horizonMonths))
    input.trials = Math.max(20, Math.min(300, input.trials))
    input.growthRateMoM = Math.max(-0.2, Math.min(2.0, input.growthRateMoM))

    const baseMC = runMonteCarlo(input)
    const velocity = runGrowthVelocitySweep(input)
    const sensitivity = runSensitivityGrid(input)
    const verdict = buildVerdict(input, baseMC, velocity)

    const serviceClient = createClient(supabaseUrl, serviceKey)
    const { data: inserted, error: insertErr } = await serviceClient
      .from('treasury_projections')
      .insert({
        scenario_key: input.scenarioKey,
        label: input.label ?? null,
        starting_reserve: input.startingReserve,
        starting_traders: input.startingTraders,
        inputs_json: input as unknown as Record<string, unknown>,
        results_json: {
          monthlyAggregates: baseMC.monthlyAggregates,
          medianResult: baseMC.medianResult,
          worstResult: baseMC.worstResult,
          scalingCheckpoints_p50: baseMC.scalingCheckpoints_p50,
          velocitySweep: velocity,
          sensitivity,
          survivalRate: baseMC.survivalRate,
          breaker: baseMC.breaker,
        },
        verdict_json: verdict,
        safe_growth_ceiling_pct: verdict.safeGrowthCeilingPct,
        min_reserve_recommended: baseMC.reserve.recommended_trough,
        min_reserve_stress: baseMC.reserve.stress_trough_p5,
        min_reserve_catastrophic: baseMC.reserve.catastrophic_trough,
        worst_month_trough: baseMC.reserve.catastrophic_trough,
        insolvent: verdict.insolventInBase,
        insolvent_month: baseMC.medianResult.insolventMonth,
        breaker_freeze_months: Math.round(baseMC.breaker.avg_l2_months),
        breaker_l1_months: Math.round(baseMC.breaker.avg_l1_months),
        created_by: userId,
      })
      .select('id')
      .single()

    if (insertErr) {
      console.error('treasury insert error:', insertErr)
      return new Response(JSON.stringify({ error: 'Failed to persist projection' }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    return new Response(JSON.stringify({
      ok: true,
      projectionId: inserted.id,
      verdict,
      monthlyAggregates: baseMC.monthlyAggregates,
      medianResult: baseMC.medianResult,
      worstResult: baseMC.worstResult,
      scalingCheckpoints_p50: baseMC.scalingCheckpoints_p50,
      velocitySweep: velocity,
      sensitivity,
      survivalRate: baseMC.survivalRate,
      breaker: baseMC.breaker,
      reserve: baseMC.reserve,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (e) {
    console.error('run-treasury-projection error:', e)
    return new Response(JSON.stringify({ error: 'Projection failed' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})