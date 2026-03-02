import { useState, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Play, CheckCircle, XCircle, AlertTriangle, Loader2, Info } from 'lucide-react';
import {
  runMonteCarlo,
  DEFAULT_ASSUMPTIONS,
  type MonteCarloAssumptions,
  type MonteCarloConfig,
  type MonteCarloResult,
} from '@/lib/monte-carlo';
import { PAY_REV_GUARDRAIL_V1 } from '@/lib/breaker-policy';
import { BreakerEfficacyPanel, type BreakerComparisonRow } from './BreakerEfficacyPanel';

// ============================================================================
// CONFIG
// ============================================================================
const CONFIG: MonteCarloConfig = { iterations: 500, monthsPerIteration: 12, seed: 42 };
// Mature 90-day: run 15 months, measure only months 12–14 (true steady-state)
const CONFIG_MATURE_90DAY: MonteCarloConfig = { iterations: 500, monthsPerIteration: 15, seed: 42 };
const MEASURE_START = 12;  // first month of measurement window
const MEASURE_LEN = 3;     // 3-month measurement window

// ============================================================================
// SCENARIO BUILDERS (deep clone, never drops caps)
// ============================================================================
function deepClone(base: MonteCarloAssumptions): MonteCarloAssumptions {
  return JSON.parse(JSON.stringify(base));
}

function withPassRate(mode: number, base = DEFAULT_ASSUMPTIONS): MonteCarloAssumptions {
  const a = deepClone(base);
  a.passRate = { min: Math.max(0.02, mode - 0.03), mode, max: mode + 0.05 };
  return a;
}

function withHighProfitability(mult: number, base = DEFAULT_ASSUMPTIONS): MonteCarloAssumptions {
  const a = deepClone(base);
  a.avgPayoutAmount = { mean: a.avgPayoutAmount.mean * mult, stdDev: a.avgPayoutAmount.stdDev * mult };
  return a;
}

function withPayoutClustering(base = DEFAULT_ASSUMPTIONS): MonteCarloAssumptions {
  const a = deepClone(base);
  a.payoutRequestRate = { min: 0.50, mode: 0.65, max: 0.80 };
  a.payoutsPerPaidAccountPerMonth = { min: 0.8, mode: 1.4, max: 2.0 };
  return a;
}

function withMaxWithdrawalPressure(base = DEFAULT_ASSUMPTIONS): MonteCarloAssumptions {
  const a = deepClone(base);
  a.payoutRequestRate = { min: 0.60, mode: 0.75, max: 0.90 };
  a.avgPayoutAmount = { mean: 500, stdDev: 80 };
  return a;
}

function withVolume(n: number, base = DEFAULT_ASSUMPTIONS): MonteCarloAssumptions {
  const a = deepClone(base);
  a.accountsPerMonth = n;
  return a;
}

function withAttack(intensity: number, base = DEFAULT_ASSUMPTIONS): MonteCarloAssumptions {
  const a = deepClone(base);
  a.knobs.attackIntensity = intensity;
  return a;
}

function withPrice(price: number, base = DEFAULT_ASSUMPTIONS): MonteCarloAssumptions {
  const a = deepClone(base);
  a.pricePerAccount = price;
  if (a.knobs.lifetimeCapPerUser !== null) {
    const multiple = a.knobs.lifetimeCapPerUser / DEFAULT_ASSUMPTIONS.pricePerAccount;
    a.knobs.lifetimeCapPerUser = price * multiple;
  }
  return a;
}

function withNoVelocityGates(base = DEFAULT_ASSUMPTIONS): MonteCarloAssumptions {
  const a = deepClone(base);
  a.knobs.minWinningDaysPerPayout = 0;
  a.knobs.minMonthsBetweenPayouts = 0;
  a.knobs.minProfitSinceLastPayout = 0;
  return a;
}

function withCostStack(base = DEFAULT_ASSUMPTIONS): MonteCarloAssumptions {
  const a = deepClone(base);
  // Stochastic business costs:
  // CAC: ~$35/sale ± $10 (modeled as variable cost per account)
  // Refunds: ~4% of revenue ± 2% (modeled as increased fixed costs with variance baked into chargebacks)
  a.variableCostPerAccount = a.variableCostPerAccount + 35; // ~$35 CAC per sale
  a.fixedMonthlyCosts = a.fixedMonthlyCosts + (a.accountsPerMonth * a.pricePerAccount * 0.04); // ~4% refund baseline
  // Increase chargeback variance to model stochastic refund spikes ("usually low, sometimes ugly")
  a.chargebackRate = {
    min: a.chargebackRate.min + 0.01,
    mode: a.chargebackRate.mode + 0.02,
    max: Math.min(a.chargebackRate.max + 0.08, 0.15), // occasional ugly months up to 15%
  };
  return a;
}

function withSoftAttack(base = DEFAULT_ASSUMPTIONS): MonteCarloAssumptions {
  const a = deepClone(base);
  // Realistic adversary: skilled traders + higher withdrawal behavior (not coordinated attack)
  a.passRate = { min: 0.07, mode: 0.10, max: 0.14 };
  a.payoutRequestRate = { min: 0.35, mode: 0.45, max: 0.55 };
  a.payoutsPerPaidAccountPerMonth = { min: 0.6, mode: 1.0, max: 1.4 };
  a.avgPayoutAmount = { mean: a.avgPayoutAmount.mean * 1.2, stdDev: a.avgPayoutAmount.stdDev * 1.2 };
  return a;
}

// ============================================================================
// TYPES
// ============================================================================
type ScenarioId = 'baseline' | 'pass5' | 'pass10' | 'shift2pp' | 'profit15x' | 'clustering' | 'max_withdrawal' | 'pass5_profit15x' | 'attack_combined' | 'solo200' | 'solo200_pass10' | 'no_gates' | 'cost_stack' | 'cost_pass10' | 'soft_attack';
type PriceId = 'p149' | 'p179' | 'p199' | 'p249' | 'p199_pass10' | 'p249_pass10';

interface ScenarioRow {
  id: ScenarioId;
  name: string;
  result: MonteCarloResult;
  assumptions: MonteCarloAssumptions;
  isAttack?: boolean;
}

interface DrawdownRow {
  id: ScenarioId;
  name: string;
  maxDD: number;
  minMonth: number;
  cumMean: number;
  cumP5: number;
  payRevP95: number;
  payRevP99: number;
  pctAbove45: number;
  monthMeansWindow: number[];
  isAttack?: boolean;
}

interface BaselineDiagnostics {
  minMonthlyProfit: number;
  maxMonthlyProfit: number;
  negativeMonthCount: number;
  totalMonthCount: number;
  negativeMonthPct: number;
  payoutToRevenuePct: number;
  avgMonthlyPayouts: number;
  avgMonthlyRevenue: number;
  avgActiveCohort: number;
  avgEligibleCohort: number;
  profitStdDev: number;
  monthProfitMeans: number[]; // per-month mean profit (shows ramp-up effect)
}

interface PriceRow {
  id: PriceId;
  name: string;
  assumptions: MonteCarloAssumptions;
  result: MonteCarloResult;
}

interface StressBatteryResult {
  scenarios: ScenarioRow[];
  priceScenarios: PriceRow[];
  drawdown: DrawdownRow[];
  breakerComparisons: BreakerComparisonRow[];
  baselineDiag: BaselineDiagnostics;
  configCheck: {
    firstPayoutCap: number | null;
    lifetimeCapPerUser: number | null;
    lifetimeCapMultiple: string;
    payoutSplitPercent: number;
    pricePerAccount: number;
    passRateMode: string;
    payoutRequestMode: string;
    velocityGates: string;
  };
  verdict: { label: string; pass: boolean }[];
  capitalRealistic: number;  // worst DD excluding attack scenarios
  capitalAdversarial: number; // worst DD including attack scenarios
}

// ============================================================================
// HELPERS
// ============================================================================

/** Total revenue for a month (unified denominator for Pay/Rev everywhere) */
function totalRevenue(month: { revenue: number; resetRevenue: number }) {
  return month.revenue + month.resetRevenue;
}

/** Safe percentile index — guards len<=0 */
function safeIdx(p: number, len: number): number {
  if (len <= 0) return 0;
  const pp = Math.min(1, Math.max(0, p));
  return Math.min(len - 1, Math.max(0, Math.floor(len * pp)));
}

/** Compute per-month mean profit across iterations */
function monthMeans(rawSamples: number[][]): number[] {
  const months = rawSamples[0]?.length ?? 0;
  const means: number[] = [];
  for (let m = 0; m < months; m++) {
    let s = 0;
    for (let i = 0; i < rawSamples.length; i++) s += rawSamples[i][m];
    means.push(s / rawSamples.length);
  }
  return means;
}

// Pre-build shared assumptions so 12-month and 90-day panels use identical configs
const _pass10 = withPassRate(0.10);
const _clustering_pass10 = withPayoutClustering(_pass10);

const SHARED_ASSUMPTIONS = {
  clustering: withPayoutClustering(),
  costStack: withCostStack(),
  softAttack: withSoftAttack(),
  clusteringPass10: _clustering_pass10,
  attackCombined: withAttack(1.5, _clustering_pass10),
  noGates: withNoVelocityGates(),
} as const;

// ============================================================================
// RUNNER
// ============================================================================
function runStressBattery(): StressBatteryResult {
  const scenarios: ScenarioRow[] = [];
  const run = (id: ScenarioId, name: string, assumptions: MonteCarloAssumptions, isAttack = false) => {
    scenarios.push({ id, name, assumptions, result: runMonteCarlo(CONFIG, assumptions), isAttack });
  };

  // Core scenarios
  run('baseline', 'Baseline (7% pass, 500/mo)', DEFAULT_ASSUMPTIONS);
  run('pass5', '5% pass rate (conservative)', withPassRate(0.05));
  run('pass10', '10% pass rate (danger zone)', withPassRate(0.10));

  const baseMode = DEFAULT_ASSUMPTIONS.passRate.mode;
  run('shift2pp', `+2pp shift (${(baseMode * 100).toFixed(0)}% → ${((baseMode + 0.02) * 100).toFixed(0)}%)`, withPassRate(baseMode + 0.02));

  // Payout stress
  run('profit15x', '1.5× funded profitability', withHighProfitability(1.5));
  run('clustering', 'Payout clustering', SHARED_ASSUMPTIONS.clustering);
  run('max_withdrawal', 'Max withdrawal pressure', withMaxWithdrawalPressure());

  // Combined stress
  run('pass5_profit15x', '5% pass + 1.5× profit', withHighProfitability(1.5, withPassRate(0.05)));
  run('attack_combined', '10% + clustering + attack', SHARED_ASSUMPTIONS.attackCombined, true);

  // Solo operator
  run('solo200', 'Solo ramp (200/mo)', withVolume(200));
  run('solo200_pass10', 'Solo ramp + 10% pass', withPassRate(0.10, withVolume(200)));

  // Velocity gate impact
  run('no_gates', 'No velocity gates (baseline)', SHARED_ASSUMPTIONS.noGates);

  // Realism scenarios: business costs
  run('cost_stack', '+ Refunds & CAC (stochastic)', SHARED_ASSUMPTIONS.costStack);
  run('cost_pass10', '+ Costs + 10% pass', withCostStack(withPassRate(0.10)));

  // Soft attack: realistic adversary (breaker design target)
  run('soft_attack', 'Adversarial-but-plausible (breaker target)', SHARED_ASSUMPTIONS.softAttack);

  // Price sensitivity
  const priceScenarios: PriceRow[] = [];
  const runPrice = (id: PriceId, name: string, assumptions: MonteCarloAssumptions) => {
    priceScenarios.push({ id, name, assumptions, result: runMonteCarlo(CONFIG, assumptions) });
  };
  runPrice('p149', '$149 (current)', DEFAULT_ASSUMPTIONS);
  runPrice('p179', '$179', withPrice(179));
  runPrice('p199', '$199', withPrice(199));
  runPrice('p249', '$249', withPrice(249));
  runPrice('p199_pass10', '$199 @ 10% pass', withPassRate(0.10, withPrice(199)));
  runPrice('p249_pass10', '$249 @ 10% pass', withPassRate(0.10, withPrice(249)));

  // Steady-state 90-day panel — reduced set for performance (15mo × 500 iter each)
  const ddScenarios: { id: ScenarioId; name: string; assumptions: MonteCarloAssumptions; isAttack: boolean }[] = [
    { id: 'baseline', name: 'Baseline', assumptions: DEFAULT_ASSUMPTIONS, isAttack: false },
    { id: 'clustering', name: 'Payout clustering', assumptions: SHARED_ASSUMPTIONS.clustering, isAttack: false },
    { id: 'soft_attack', name: 'Adversarial-but-plausible', assumptions: SHARED_ASSUMPTIONS.softAttack, isAttack: false },
    { id: 'cost_stack', name: '+ Refunds & CAC', assumptions: SHARED_ASSUMPTIONS.costStack, isAttack: false },
    { id: 'attack_combined', name: '10% + clustering + attack', assumptions: SHARED_ASSUMPTIONS.attackCombined, isAttack: true },
    { id: 'no_gates', name: 'No velocity gates', assumptions: SHARED_ASSUMPTIONS.noGates, isAttack: false },
  ];

  let warnedMatureLen = false;
  const drawdown: DrawdownRow[] = ddScenarios.map(s => {
    const r = runMonteCarlo(CONFIG_MATURE_90DAY, s.assumptions);
    if (import.meta.env.DEV && !warnedMatureLen) {
      const months = r.rawSamples?.[0]?.length;
      if (months == null) {
        console.warn(`[StressBattery] [${s.id}] Mature sim did not return rawSamples; cannot validate measurement window.`);
        warnedMatureLen = true;
      } else if (months < MEASURE_START + MEASURE_LEN) {
        console.warn(`[StressBattery] [${s.id}] Mature sim returned ${months} months; need ${MEASURE_START + MEASURE_LEN}`);
        warnedMatureLen = true;
      } else {
        const win = r.rawSamples![0].slice(MEASURE_START, MEASURE_START + MEASURE_LEN);
        if (win.length !== MEASURE_LEN) {
          console.warn(`[StressBattery] [${s.id}] Window slice is ${win.length} months; expected ${MEASURE_LEN}`);
          warnedMatureLen = true;
        }
      }
    }
    let cumP5: number;
    let cumMean: number;
    let maxDD = 0;
    let minMonth = 0;
    let payRevP95 = 0;
    let payRevP99 = 0;
    let pctAbove45 = 0;
    let monthMeansWindow: number[] = [];

    if (r.rawSamples && r.rawSamples.length > 0) {
      // Explicit measurement window: months MEASURE_START to MEASURE_START+MEASURE_LEN
      const windowSamples = r.rawSamples.map(iter => iter.slice(MEASURE_START, MEASURE_START + MEASURE_LEN));

      // Cumulative profit in measurement window
      const cumProfits = windowSamples.map(iter => iter.reduce((a, b) => a + b, 0));
      cumMean = cumProfits.reduce((a, b) => a + b, 0) / cumProfits.length;
      cumProfits.sort((a, b) => a - b);
      cumP5 = cumProfits[safeIdx(0.05, cumProfits.length)];

      // Min monthly profit in window
      const allWindowMonths = windowSamples.flat();
      minMonth = allWindowMonths.length > 0 ? Math.min(...allWindowMonths) : 0;

      // Per-month means in the measurement window
      for (let m = 0; m < MEASURE_LEN; m++) {
        let sum = 0;
        for (let i = 0; i < windowSamples.length; i++) sum += windowSamples[i][m];
        monthMeansWindow.push(sum / windowSamples.length);
      }

      // Peak-to-trough DD on cumulative equity within window
      for (const iter of windowSamples) {
        let cum = 0;
        let peak = 0;
        for (const p of iter) {
          cum += p;
          peak = Math.max(peak, cum);
          maxDD = Math.max(maxDD, peak - cum);
        }
      }

      // Pay/Rev P95, P99, %>45% from rawMonthResults (same measurement window)
      if (r.rawMonthResults && r.rawMonthResults.length > 0) {
        const ratios: number[] = [];
        for (const iter of r.rawMonthResults) {
          for (let m = MEASURE_START; m < MEASURE_START + MEASURE_LEN; m++) {
            if (m < iter.length) {
              const rev = totalRevenue(iter[m]);
              if (rev > 0) ratios.push(iter[m].payouts / rev);
            }
          }
        }
        ratios.sort((a, b) => a - b);
        const n = ratios.length;
        payRevP95 = n > 0 ? ratios[safeIdx(0.95, n)] : 0;
        payRevP99 = n > 0 ? ratios[safeIdx(0.99, n)] : 0;
        pctAbove45 = n > 0 ? ratios.filter(r => r > 0.45).length / n : 0;
      }
    } else {
      cumMean = r.profit.mean * MEASURE_LEN;
      cumP5 = r.profit.p5 * MEASURE_LEN;
      maxDD = r.risk.maxDrawdown;
      minMonth = r.risk.worstMonth;
    }
    return { id: s.id, name: s.name, maxDD, minMonth, cumMean, cumP5, payRevP95, payRevP99, pctAbove45, monthMeansWindow, isAttack: s.isAttack };
  });

  // Baseline diagnostics — compute from rawSamples
  const baselineResult = scenarios[0].result;
  const allBaselineMonths = baselineResult.rawSamples?.flat() ?? [];
  const negativeMonths = allBaselineMonths.filter(p => p < 0);

  const baselineDiag: BaselineDiagnostics = {
    minMonthlyProfit: allBaselineMonths.length > 0 ? Math.min(...allBaselineMonths) : 0,
    maxMonthlyProfit: allBaselineMonths.length > 0 ? Math.max(...allBaselineMonths) : 0,
    negativeMonthCount: negativeMonths.length,
    totalMonthCount: allBaselineMonths.length,
    negativeMonthPct: allBaselineMonths.length > 0 ? negativeMonths.length / allBaselineMonths.length : 0,
    payoutToRevenuePct: baselineResult.diagnostics.payoutToRevenueRatio,
    avgMonthlyPayouts: baselineResult.diagnostics.avgMonthlyPayouts,
    avgMonthlyRevenue: baselineResult.diagnostics.avgMonthlyRevenue,
    avgActiveCohort: baselineResult.cohortDiagnostics?.avgActiveCohortSize ?? 0,
    avgEligibleCohort: baselineResult.cohortDiagnostics?.avgEligibleCohortSize ?? 0,
    profitStdDev: baselineResult.profit.stdDev,
    monthProfitMeans: baselineResult.rawSamples ? monthMeans(baselineResult.rawSamples) : [],
  };

  // Split capital guidance: realistic (non-attack) vs adversarial (all)
  const realisticScenarios = scenarios.filter(s => !s.isAttack);
  const realisticDD = drawdown.filter(d => !d.isAttack);

  const worstDDRealistic = Math.max(
    ...realisticScenarios.map(s => s.result.risk.maxDrawdown),
    ...realisticDD.map(d => d.maxDD),
    1 // floor at $1 to avoid $0
  );
  const worstDDAdversarial = Math.max(
    ...scenarios.map(s => s.result.risk.maxDrawdown),
    ...drawdown.map(d => d.maxDD),
    1
  );

  // Soft attack (breaker target) scenario checks
  const softAttackScenario = scenarios.find(s => s.id === 'soft_attack');
  const softAttackDD = drawdown.find(d => d.id === 'soft_attack');

  const verdict = [
    { label: 'Baseline margin > 0%', pass: baselineResult.diagnostics.effectiveMargin > 0 },
    { label: 'Baseline profit > $0/mo', pass: baselineResult.profit.mean > 0 },
    { label: 'Baseline loss prob < 40%', pass: baselineResult.risk.probabilityOfLoss < 0.40 },
    { label: 'Non-attack scenarios margin > -15%', pass: realisticScenarios.every(s => s.result.diagnostics.effectiveMargin > -0.15) },
    { label: 'Non-attack scenarios loss < $10k/mo', pass: realisticScenarios.every(s => s.result.profit.mean > -10000) },
    { label: 'Realistic DD < $100k', pass: worstDDRealistic < 100000 },
    { label: '5% pass still profitable', pass: (scenarios.find(s => s.id === 'pass5')?.result.profit.mean ?? 0) > 0 },
    { label: '+2pp shift still profitable', pass: (scenarios.find(s => s.id === 'shift2pp')?.result.profit.mean ?? 0) > 0 },
    { label: 'Velocity gates reduce payout ratio', pass: (() => {
      const withGates = scenarios.find(s => s.id === 'baseline');
      const noGates = scenarios.find(s => s.id === 'no_gates');
      if (!withGates || !noGates) return true;
      return withGates.result.diagnostics.payoutToRevenueRatio <= noGates.result.diagnostics.payoutToRevenueRatio;
    })() },
    // Breaker target: soft attack must be survivable with breakers
    { label: 'Breaker target: Pay/Rev P95 < 45%', pass: (softAttackDD?.payRevP95 ?? 0) < 0.45 },
    { label: 'Breaker target: Cum P5 (90d) > $0', pass: (softAttackDD?.cumP5 ?? 0) > 0 },
    { label: 'Breaker target: Loss prob < 30%', pass: (softAttackScenario?.result.risk.probabilityOfLoss ?? 0) < 0.30 },
  ];

  // Dev-mode sanity: catch duplicate IDs early
  if (import.meta.env.DEV) {
    const sids = new Set(scenarios.map(s => s.id));
    if (sids.size !== scenarios.length) console.warn('[StressBattery] Duplicate ScenarioId detected in scenarios');
    const pids = new Set(priceScenarios.map(s => s.id));
    if (pids.size !== priceScenarios.length) console.warn('[StressBattery] Duplicate PriceId detected in priceScenarios');
    const ddids = new Set(drawdown.map(d => d.id));
    if (ddids.size !== drawdown.length) console.warn('[StressBattery] Duplicate ScenarioId detected in drawdown');

    // (Mature window length is now validated per-run inside the drawdown loop above)
  }

  // =========================================================================
  // BREAKER EFFICACY: A/B comparison on key stress scenarios
  // =========================================================================
  const breakerTargets = [
    { name: 'Payout clustering', assumptions: SHARED_ASSUMPTIONS.clustering },
    { name: 'Adversarial-but-plausible', assumptions: SHARED_ASSUMPTIONS.softAttack },
    { name: 'Baseline (control)', assumptions: DEFAULT_ASSUMPTIONS },
  ];

  const CONFIG_BREAKER: MonteCarloConfig = { iterations: 500, monthsPerIteration: 15, seed: 42 };
  const CONFIG_BREAKER_WITH: MonteCarloConfig = { ...CONFIG_BREAKER, breakerPolicy: PAY_REV_GUARDRAIL_V1 };

  const breakerComparisons: BreakerComparisonRow[] = breakerTargets.map(target => {
    const rNo = runMonteCarlo(CONFIG_BREAKER, target.assumptions);
    const rWith = runMonteCarlo(CONFIG_BREAKER_WITH, target.assumptions);

    // Extract 90-day window metrics (M12–M14) for both runs
    const extractWindow = (r: MonteCarloResult) => {
      let maxDD = 0, cumP5 = 0, payRevP95 = 0, payRevP99 = 0;
      if (r.rawSamples && r.rawSamples.length > 0) {
        const windowSamples = r.rawSamples.map(iter => iter.slice(MEASURE_START, MEASURE_START + MEASURE_LEN));
        const cumProfits = windowSamples.map(iter => iter.reduce((a, b) => a + b, 0));
        cumProfits.sort((a, b) => a - b);
        cumP5 = cumProfits[safeIdx(0.05, cumProfits.length)];
        for (const iter of windowSamples) {
          let cum = 0, peak = 0;
          for (const p of iter) { cum += p; peak = Math.max(peak, cum); maxDD = Math.max(maxDD, peak - cum); }
        }
        if (r.rawMonthResults) {
          const ratios: number[] = [];
          for (const iter of r.rawMonthResults) {
            for (let m = MEASURE_START; m < MEASURE_START + MEASURE_LEN; m++) {
              if (m < iter.length) {
                const rev = totalRevenue(iter[m]);
                if (rev > 0) ratios.push(iter[m].payouts / rev);
              }
            }
          }
          ratios.sort((a, b) => a - b);
          payRevP95 = ratios.length > 0 ? ratios[safeIdx(0.95, ratios.length)] : 0;
          payRevP99 = ratios.length > 0 ? ratios[safeIdx(0.99, ratios.length)] : 0;
        }
      }
      return { maxDD, cumP5, payRevP95, payRevP99 };
    };

    const noMetrics = extractWindow(rNo);
    const withMetrics = extractWindow(rWith);

    return {
      scenarioName: target.name,
      noBreaker: {
        ...noMetrics,
        margin: rNo.diagnostics.effectiveMargin,
        lossProb: rNo.risk.probabilityOfLoss,
      },
      withBreaker: {
        ...withMetrics,
        margin: rWith.diagnostics.effectiveMargin,
        lossProb: rWith.risk.probabilityOfLoss,
        diagnostics: rWith.breakerDiagnostics!,
      },
    };
  });

  return {
    scenarios,
    priceScenarios,
    drawdown,
    breakerComparisons,
    baselineDiag,
    configCheck: {
      firstPayoutCap: DEFAULT_ASSUMPTIONS.knobs.firstPayoutCap,
      lifetimeCapPerUser: DEFAULT_ASSUMPTIONS.knobs.lifetimeCapPerUser,
      lifetimeCapMultiple: DEFAULT_ASSUMPTIONS.knobs.lifetimeCapPerUser !== null
        ? `${(DEFAULT_ASSUMPTIONS.knobs.lifetimeCapPerUser / DEFAULT_ASSUMPTIONS.pricePerAccount).toFixed(1)}×`
        : 'unlimited',
      payoutSplitPercent: DEFAULT_ASSUMPTIONS.knobs.payoutSplitPercent,
      pricePerAccount: DEFAULT_ASSUMPTIONS.pricePerAccount,
      passRateMode: `${(DEFAULT_ASSUMPTIONS.passRate.mode * 100).toFixed(0)}%`,
      payoutRequestMode: `${(DEFAULT_ASSUMPTIONS.payoutRequestRate.mode * 100).toFixed(0)}%`,
      velocityGates: [
        DEFAULT_ASSUMPTIONS.knobs.minWinningDaysPerPayout > 0 ? `${DEFAULT_ASSUMPTIONS.knobs.minWinningDaysPerPayout} win days` : null,
        DEFAULT_ASSUMPTIONS.knobs.minMonthsBetweenPayouts > 0 ? `${DEFAULT_ASSUMPTIONS.knobs.minMonthsBetweenPayouts}mo cooldown` : null,
        DEFAULT_ASSUMPTIONS.knobs.minProfitSinceLastPayout > 0 ? `$${DEFAULT_ASSUMPTIONS.knobs.minProfitSinceLastPayout} profit gate` : null,
      ].filter(Boolean).join(' + ') || 'DISABLED',
    },
    verdict,
    capitalRealistic: Math.round(worstDDRealistic * 1.5),
    capitalAdversarial: Math.round(worstDDAdversarial * 1.5),
  };
}

// ============================================================================
// COMPONENT
// ============================================================================
export function V1StressBattery() {
  const [result, setResult] = useState<StressBatteryResult | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0);

  const handleRun = useCallback(() => {
    setIsRunning(true);
    setElapsed(0);
    const start = Date.now();
    setTimeout(() => {
      try {
        const r = runStressBattery();
        setResult(r);
        setElapsed(Date.now() - start);
      } finally {
        setIsRunning(false);
      }
    }, 50);
  }, []);

  const fmt = (v: number) => '$' + Math.round(v).toLocaleString();
  const pct = (v: number) => (v * 100).toFixed(1) + '%';
  const fmtDelta = (v: number) => (v >= 0 ? '+' : '') + '$' + Math.round(v).toLocaleString();

  if (!result) {
    return (
      <Card className="border-dashed">
        <CardContent className="flex flex-col items-center justify-center py-16">
          <AlertTriangle className="h-12 w-12 text-muted-foreground mb-4" />
          <h3 className="text-lg font-medium mb-2">V1 Survivability Stress Test</h3>
          <p className="text-muted-foreground text-center mb-2 max-w-md">
            Runs 12 stress scenarios + 6 price sensitivity + 90-day drawdown analysis.
            Calibrated to industry-realistic assumptions (7% pass, 25% request rate, velocity gates ON).
          </p>
          <p className="text-xs text-muted-foreground mb-4">Takes 30–90 seconds depending on your device.</p>
          <Button onClick={handleRun} disabled={isRunning} size="lg">
            {isRunning ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
            {isRunning ? 'Running…' : 'Run Stress Battery'}
          </Button>
        </CardContent>
      </Card>
    );
  }

  const baseline = result.scenarios?.[0]?.result;
  if (!baseline) return null;
  const passCount = result.verdict?.filter(v => v.pass).length ?? 0;
  const allPass = passCount === (result.verdict?.length ?? 0);
  const diag = result.baselineDiag;

  return (
    <div className="space-y-6">
      {/* Config Verification */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Config Under Test (verified from engine)</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-3">
            <Badge variant="outline">Entry: ${result.configCheck.pricePerAccount}</Badge>
            <Badge variant="outline">1st Cap: ${result.configCheck.firstPayoutCap}</Badge>
            <Badge variant="outline">LT Cap: ${result.configCheck.lifetimeCapPerUser} ({result.configCheck.lifetimeCapMultiple})</Badge>
            <Badge variant="outline">Split: {(result.configCheck.payoutSplitPercent * 100).toFixed(0)}%</Badge>
            <Badge variant="outline">Pass: {result.configCheck.passRateMode}</Badge>
            <Badge variant="outline">Request: {result.configCheck.payoutRequestMode}</Badge>
            <Badge variant="secondary">Gates: {result.configCheck.velocityGates}</Badge>
            <Badge variant="secondary">{elapsed > 0 ? `${(elapsed / 1000).toFixed(1)}s` : ''}</Badge>
          </div>
        </CardContent>
      </Card>

      {/* Baseline Diagnostics — WHY the numbers look the way they do */}
      {diag && (
        <Card className="border-muted">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <Info className="h-4 w-4" />
              Baseline Engine Diagnostics
            </CardTitle>
            <CardDescription>
              Raw internals from the baseline run. Use these to verify the model isn't clamping or miscounting.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <p className="text-xs text-muted-foreground">Min Monthly Profit</p>
                <p className={`text-base font-mono font-bold ${diag.minMonthlyProfit < 0 ? 'text-destructive' : ''}`}>
                  {fmt(diag.minMonthlyProfit)}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Max Monthly Profit</p>
                <p className="text-base font-mono font-bold">{fmt(diag.maxMonthlyProfit)}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Negative Months</p>
                <p className="text-base font-mono font-bold">
                  {diag.negativeMonthCount} / {diag.totalMonthCount} ({pct(diag.negativeMonthPct)})
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Profit Std Dev</p>
                <p className="text-base font-mono font-bold">{fmt(diag.profitStdDev)}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Avg Payouts/mo</p>
                <p className="text-base font-mono font-bold">{fmt(diag.avgMonthlyPayouts)}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Avg Revenue/mo</p>
                <p className="text-base font-mono font-bold">{fmt(diag.avgMonthlyRevenue)}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Payout / Revenue</p>
                <p className={`text-base font-mono font-bold ${diag.payoutToRevenuePct > 0.5 ? 'text-destructive' : diag.payoutToRevenuePct < 0.1 ? 'text-warning' : ''}`}>
                  {pct(diag.payoutToRevenuePct)}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Avg Active / Eligible Cohort</p>
                <p className="text-base font-mono font-bold">
                  {Math.round(diag.avgActiveCohort)} / {Math.round(diag.avgEligibleCohort)}
                </p>
              </div>
            </div>
            {/* Month-indexed profit means — shows cohort ramp-up effect */}
            {diag.monthProfitMeans.length > 0 && (
              <div className="mt-3 rounded-lg bg-muted/50 p-3 text-sm">
                <p className="font-medium mb-1">Monthly Profit Means (ramp-up visibility):</p>
                <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-xs">
                  {diag.monthProfitMeans.map((m, i) => (
                    <span key={i} className={i < 3 ? 'text-muted-foreground' : ''}>
                      M{i}: {fmt(m)}{i < 3 ? ' ↑' : ''}
                    </span>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  Early months (M0–M2 ↑) show inflated profit because cohort hasn't matured — few accounts are eligible for payouts yet.
                </p>
              </div>
            )}
            {diag.negativeMonthCount === 0 && (
              <div className="mt-3 rounded-lg bg-warning/10 border border-warning/30 p-3 text-sm">
                <strong>⚠ Zero negative months.</strong> This means payouts never exceed revenue+costs in any simulated month.
                At {pct(diag.payoutToRevenuePct)} payout/revenue ratio, this is mathematically expected.
                If this seems too safe, consider whether pass rate or payout request rate should be higher.
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Verdict */}
      <Card className={allPass ? 'border-success/50 bg-success/5' : 'border-destructive/50 bg-destructive/5'}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            {allPass ? <CheckCircle className="h-5 w-5 text-success" /> : <XCircle className="h-5 w-5 text-destructive" />}
            {allPass ? 'V1 CONFIG SURVIVES ALL CHECKS' : `${(result.verdict?.length ?? 0) - passCount} CHECK(S) FAILED`}
          </CardTitle>
          <CardDescription>Attack scenarios excluded from "realistic" checks. Adversarial scenarios need breakers, not capital.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {(result.verdict ?? []).map((v, i) => (
              <div key={i} className="flex items-center gap-2 text-sm">
                {v.pass ? <CheckCircle className="h-4 w-4 text-success shrink-0" /> : <XCircle className="h-4 w-4 text-destructive shrink-0" />}
                {v.label}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Scenario Table */}
      <Card>
        <CardHeader>
          <CardTitle>Stress Scenarios (500 iter × 12 months)</CardTitle>
          <CardDescription>
            Industry-calibrated baseline: 7% pass, 25% request rate, velocity gates ON.
            🔴 = attack scenario (adversarial, not baseline risk).
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="pb-2 pr-4">Scenario</th>
                <th className="pb-2 pr-4 text-right">Margin</th>
                <th className="pb-2 pr-4 text-right">Profit/mo</th>
                <th className="pb-2 pr-4 text-right">P5 (tail)</th>
                <th className="pb-2 pr-4 text-right">Loss Prob</th>
                <th className="pb-2 pr-4 text-right">Max DD</th>
                <th className="pb-2 pr-4 text-right">Pay/Rev</th>
                <th className="pb-2 text-right">Δ Profit</th>
              </tr>
            </thead>
            <tbody>
              {(result.scenarios ?? []).map((s, i) => {
                const r = s.result;
                const d = r.diagnostics;
                const profitDelta = i > 0 ? r.profit.mean - baseline.profit.mean : 0;
                const isNegMargin = d.effectiveMargin < 0;
                return (
                  <tr key={i} className={`border-b last:border-0 ${s.isAttack ? 'bg-destructive/10' : isNegMargin ? 'bg-destructive/5' : ''}`}>
                    <td className="py-2 pr-4 font-medium">
                      {s.isAttack && <span className="mr-1">🔴</span>}
                      {s.name}
                    </td>
                    <td className={`py-2 pr-4 text-right font-mono ${isNegMargin ? 'text-destructive' : 'text-success'}`}>{pct(d.effectiveMargin)}</td>
                    <td className={`py-2 pr-4 text-right font-mono ${r.profit.mean < 0 ? 'text-destructive' : ''}`}>{fmt(r.profit.mean)}</td>
                    <td className="py-2 pr-4 text-right font-mono text-destructive">{fmt(r.profit.p5)}</td>
                    <td className="py-2 pr-4 text-right font-mono">{pct(r.risk.probabilityOfLoss)}</td>
                    <td className="py-2 pr-4 text-right font-mono">{fmt(r.risk.maxDrawdown)}</td>
                    <td className={`py-2 pr-4 text-right font-mono ${d.payoutToRevenueRatio > 0.5 ? 'text-destructive font-bold' : ''}`}>{pct(d.payoutToRevenueRatio)}</td>
                    <td className={`py-2 text-right font-mono ${i === 0 ? 'text-muted-foreground' : profitDelta < 0 ? 'text-destructive' : 'text-success'}`}>
                      {i === 0 ? '—' : fmtDelta(profitDelta)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {/* +2pp Shift Callout */}
      {(() => {
        const shift = result.scenarios?.find(s => s.name.includes('+2pp'));
        if (!shift) return null;
        const profitDelta = shift.result.profit.mean - baseline.profit.mean;
        const marginDelta = (shift.result.diagnostics.effectiveMargin - baseline.diagnostics.effectiveMargin) * 100;
        const stillProfitable = shift.result.profit.mean > 0;
        return (
          <Card className={stillProfitable ? 'border-success/50 bg-success/5' : 'border-destructive/50 bg-destructive/5'}>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <AlertTriangle className="h-5 w-5" />
                Critical: +2pp Pass Rate Shift
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid gap-4 sm:grid-cols-3">
                <div>
                  <p className="text-xs text-muted-foreground">Profit Δ</p>
                  <p className={`text-lg font-bold ${profitDelta < 0 ? 'text-destructive' : ''}`}>{fmtDelta(profitDelta)}/mo</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Margin Δ</p>
                  <p className="text-lg font-bold">{marginDelta.toFixed(1)} pp</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Still Profitable?</p>
                  <p className="text-lg font-bold">{stillProfitable ? '✅ Yes' : '🚨 No'}</p>
                </div>
              </div>
            </CardContent>
          </Card>
        );
      })()}

      {/* Price Sensitivity */}
      <Card>
        <CardHeader>
          <CardTitle>Price Sensitivity Analysis</CardTitle>
          <CardDescription>Same config, different entry fees. LT cap scales proportionally. Target: ≥ +10% baseline margin.</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="pb-2 pr-4">Price Point</th>
                <th className="pb-2 pr-4 text-right">Margin</th>
                <th className="pb-2 pr-4 text-right">Profit/mo</th>
                <th className="pb-2 pr-4 text-right">P5 (tail)</th>
                <th className="pb-2 pr-4 text-right">Loss Prob</th>
                <th className="pb-2 pr-4 text-right">Max DD</th>
                <th className="pb-2 pr-4 text-right">LT Cap</th>
                <th className="pb-2 text-right">Revenue/mo</th>
              </tr>
            </thead>
            <tbody>
              {(result.priceScenarios ?? []).map((s, i) => {
                const r = s.result;
                const d = r.diagnostics;
                const isNegMargin = d.effectiveMargin < 0;
                const isGoodMargin = d.effectiveMargin >= 0.10;
                return (
                  <tr key={i} className={`border-b last:border-0 ${isGoodMargin ? 'bg-success/5' : isNegMargin ? 'bg-destructive/5' : ''}`}>
                    <td className="py-2 pr-4 font-medium">{s.name}</td>
                    <td className={`py-2 pr-4 text-right font-mono ${isNegMargin ? 'text-destructive' : isGoodMargin ? 'text-success font-bold' : 'text-success'}`}>{pct(d.effectiveMargin)}</td>
                    <td className={`py-2 pr-4 text-right font-mono ${r.profit.mean < 0 ? 'text-destructive' : ''}`}>{fmt(r.profit.mean)}</td>
                    <td className="py-2 pr-4 text-right font-mono">{fmt(r.profit.p5)}</td>
                    <td className="py-2 pr-4 text-right font-mono">{pct(r.risk.probabilityOfLoss)}</td>
                    <td className="py-2 pr-4 text-right font-mono">{fmt(r.risk.maxDrawdown)}</td>
                    <td className="py-2 pr-4 text-right font-mono">{fmt(s.assumptions.knobs.lifetimeCapPerUser ?? 0)}</td>
                    <td className="py-2 text-right font-mono">{fmt(d.avgMonthlyRevenue)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {/* 90-Day Drawdown */}
      <Card>
        <CardHeader>
          <CardTitle>Steady-State 90-Day Window (1000 iter × 15mo, measure M12–M14)</CardTitle>
          <CardDescription>
            Runs 15-month sim, discards first 12 months (full ramp-up), measures DD/P5/Pay-Rev on months 12–14.
            Cohort is fully mature — all eligibility gates and velocity throttles are active.
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="pb-2 pr-4">Scenario</th>
                <th className="pb-2 pr-4 text-right">90d Max DD</th>
                <th className="pb-2 pr-4 text-right">Min Month</th>
                <th className="pb-2 pr-4 text-right">P/R P95</th>
                <th className="pb-2 pr-4 text-right">P/R P99</th>
                <th className="pb-2 pr-4 text-right">&gt;45%</th>
                <th className="pb-2 pr-4 text-right">Cum P5</th>
                <th className="pb-2 text-right">Month Means</th>
              </tr>
            </thead>
            <tbody>
              {(result.drawdown ?? []).map((d, i) => (
                <tr key={i} className={`border-b last:border-0 ${d.isAttack ? 'bg-destructive/10' : ''}`}>
                  <td className="py-2 pr-4 font-medium">
                    {d.isAttack && <span className="mr-1">🔴</span>}
                    {d.name}
                  </td>
                  <td className={`py-2 pr-4 text-right font-mono ${d.maxDD > 0 ? 'text-destructive' : ''}`}>
                    {fmt(d.maxDD)}
                    {d.maxDD === 0 && <span className="ml-1 text-xs text-muted-foreground" title="All months profitable — no peak-to-trough decline">≡0</span>}
                  </td>
                  <td className={`py-2 pr-4 text-right font-mono ${d.minMonth < 0 ? 'text-destructive' : ''}`}>{fmt(d.minMonth)}</td>
                  <td className={`py-2 pr-4 text-right font-mono ${d.payRevP95 > 0.5 ? 'text-destructive font-bold' : d.payRevP95 > 0.35 ? 'text-warning' : ''}`}>
                    {pct(d.payRevP95)}
                  </td>
                  <td className={`py-2 pr-4 text-right font-mono ${d.payRevP99 > 0.6 ? 'text-destructive font-bold' : d.payRevP99 > 0.45 ? 'text-warning' : ''}`}>
                    {pct(d.payRevP99)}
                  </td>
                  <td className={`py-2 pr-4 text-right font-mono ${d.pctAbove45 > 0.1 ? 'text-destructive' : d.pctAbove45 > 0.01 ? 'text-warning' : ''}`}>
                    {pct(d.pctAbove45)}
                  </td>
                  <td className={`py-2 pr-4 text-right font-mono ${d.cumP5 < 0 ? 'text-destructive' : ''}`}>
                    {fmt(d.cumP5)}
                  </td>
                  <td className="py-2 text-right font-mono text-xs text-muted-foreground">
                    {d.monthMeansWindow.map((m, mi) => `M${MEASURE_START + mi}:${Math.round(m / 1000)}k`).join(' ')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-4 space-y-2">
            <div className="rounded-lg bg-muted/50 p-3 text-sm">
              <div className="grid gap-2 sm:grid-cols-2">
                <div>
                  <strong>Realistic stress capital:</strong> ≥ {fmt(result.capitalRealistic)}
                  <p className="text-xs text-muted-foreground mt-1">1.5× worst DD excluding attack scenarios</p>
                </div>
                <div>
                  <strong>Adversarial capital (or use breakers):</strong> ≥ {fmt(result.capitalAdversarial)}
                  <p className="text-xs text-muted-foreground mt-1">1.5× worst DD including 🔴 attack scenarios</p>
                </div>
              </div>
            </div>
            <div className="rounded-lg bg-warning/10 border border-warning/30 p-3 text-xs">
              <strong>Note:</strong> Adversarial scenarios (🔴) model coordinated attacks without circuit breakers.
              In production, the Economic Breaker would freeze payouts before reaching this drawdown.
              Hold capital for realistic stress; implement breakers for adversarial.
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Breaker Efficacy A/B */}
      {result.breakerComparisons.length > 0 && (
        <BreakerEfficacyPanel comparisons={result.breakerComparisons} />
      )}

      {/* Re-run button */}
      <div className="flex justify-end">
        <Button onClick={handleRun} disabled={isRunning} variant="outline">
          {isRunning ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
          Re-run Battery
        </Button>
      </div>
    </div>
  );
}
