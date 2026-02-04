/**
 * First Payout Cap Sensitivity Analysis
 * 
 * Sweeps firstPayoutCap across values to find optimal cap that:
 * - Reduces attack-month exposure
 * - Preserves baseline profitability
 * - Improves P5 and max drawdown
 */

import {
  runMonteCarlo,
  MonteCarloConfig,
  MonteCarloAssumptions,
  DEFAULT_ASSUMPTIONS,
  SCENARIO_PRESETS,
} from './monte-carlo';

export interface CapAnalysisResult {
  cap: number | null;
  capLabel: string;
  baseline: {
    meanProfit: number;
    p5Profit: number;
    p95Profit: number;
    lossProb: number;
    maxDrawdown: number;
    margin: number;
  };
  coordinatedAttack: {
    meanProfit: number;
    p5Profit: number;
    lossProb: number;
    maxDrawdown: number;
  };
  tiktokViral: {
    meanProfit: number;
    p5Profit: number;
    lossProb: number;
    maxDrawdown: number;
  };
  // Comparison to no-cap baseline
  vsNoCap: {
    baselineMeanDelta: number;      // % change
    baselineP5Delta: number;        // % change
    attackLossProbDelta: number;    // absolute change (negative = better)
    attackDrawdownDelta: number;    // absolute change (negative = better)
  };
}

export interface CapAnalysisSummary {
  config: MonteCarloConfig;
  results: CapAnalysisResult[];
  recommendation: {
    optimalCap: number | null;
    reasoning: string;
    metrics: {
      baselineMeanRetained: number;    // % of no-cap mean retained
      attackLossProbReduction: number; // absolute reduction
      attackDrawdownReduction: number; // absolute reduction
    };
  };
}

const ANALYSIS_CONFIG: MonteCarloConfig = {
  iterations: 1000,
  monthsPerIteration: 12,
  seed: 42,
};

const CAP_VALUES: (number | null)[] = [null, 500, 400, 350, 300, 250, 200, 150, 100];

function runScenarioWithCap(
  baseAssumptions: MonteCarloAssumptions,
  cap: number | null
): ReturnType<typeof runMonteCarlo> {
  const modified: MonteCarloAssumptions = {
    ...baseAssumptions,
    knobs: {
      ...baseAssumptions.knobs,
      firstPayoutCap: cap,
    },
  };
  return runMonteCarlo(ANALYSIS_CONFIG, modified);
}

export function analyzeFirstPayoutCap(): CapAnalysisSummary {
  const results: CapAnalysisResult[] = [];
  
  // First, get the no-cap baseline for comparison
  const noCapBaseline = runScenarioWithCap(DEFAULT_ASSUMPTIONS, null);
  const noCapAttack = runScenarioWithCap(SCENARIO_PRESETS.coordinatedAttack, null);
  
  for (const cap of CAP_VALUES) {
    const baseline = runScenarioWithCap(DEFAULT_ASSUMPTIONS, cap);
    const attack = runScenarioWithCap(SCENARIO_PRESETS.coordinatedAttack, cap);
    const viral = runScenarioWithCap(SCENARIO_PRESETS.tiktokViral, cap);
    
    const result: CapAnalysisResult = {
      cap,
      capLabel: cap === null ? 'No Cap' : `$${cap}`,
      baseline: {
        meanProfit: Math.round(baseline.profit.mean),
        p5Profit: Math.round(baseline.profit.p5),
        p95Profit: Math.round(baseline.profit.p95),
        lossProb: baseline.risk.probabilityOfLoss,
        maxDrawdown: Math.round(baseline.risk.maxDrawdown),
        margin: baseline.diagnostics.effectiveMargin,
      },
      coordinatedAttack: {
        meanProfit: Math.round(attack.profit.mean),
        p5Profit: Math.round(attack.profit.p5),
        lossProb: attack.risk.probabilityOfLoss,
        maxDrawdown: Math.round(attack.risk.maxDrawdown),
      },
      tiktokViral: {
        meanProfit: Math.round(viral.profit.mean),
        p5Profit: Math.round(viral.profit.p5),
        lossProb: viral.risk.probabilityOfLoss,
        maxDrawdown: Math.round(viral.risk.maxDrawdown),
      },
      vsNoCap: {
        baselineMeanDelta: cap === null ? 0 : 
          ((baseline.profit.mean - noCapBaseline.profit.mean) / noCapBaseline.profit.mean) * 100,
        baselineP5Delta: cap === null ? 0 :
          ((baseline.profit.p5 - noCapBaseline.profit.p5) / noCapBaseline.profit.p5) * 100,
        attackLossProbDelta: cap === null ? 0 :
          attack.risk.probabilityOfLoss - noCapAttack.risk.probabilityOfLoss,
        attackDrawdownDelta: cap === null ? 0 :
          attack.risk.maxDrawdown - noCapAttack.risk.maxDrawdown,
      },
    };
    
    results.push(result);
  }
  
  // Find optimal cap: best trade-off between baseline retention and attack protection
  const recommendation = findOptimalCap(results, noCapBaseline.profit.mean);
  
  return {
    config: ANALYSIS_CONFIG,
    results,
    recommendation,
  };
}

function findOptimalCap(
  results: CapAnalysisResult[],
  noCapMean: number
): CapAnalysisSummary['recommendation'] {
  // Score each cap based on:
  // - Retain at least 90% of baseline mean profit
  // - Maximize attack loss prob reduction
  // - Minimize attack drawdown
  
  const noCapResult = results.find(r => r.cap === null)!;
  
  let bestCap: number | null = null;
  let bestScore = -Infinity;
  let bestMetrics = {
    baselineMeanRetained: 100,
    attackLossProbReduction: 0,
    attackDrawdownReduction: 0,
  };
  
  for (const result of results) {
    if (result.cap === null) continue;
    
    const meanRetained = (result.baseline.meanProfit / noCapResult.baseline.meanProfit) * 100;
    
    // Must retain at least 85% of mean profit
    if (meanRetained < 85) continue;
    
    const lossProbReduction = noCapResult.coordinatedAttack.lossProb - result.coordinatedAttack.lossProb;
    const drawdownReduction = noCapResult.coordinatedAttack.maxDrawdown - result.coordinatedAttack.maxDrawdown;
    
    // Score: weight loss prob reduction heavily, drawdown reduction moderately
    // Penalize mean profit loss
    const score = 
      (lossProbReduction * 100) +           // 1% loss prob reduction = 1 point
      (drawdownReduction / 1000) +          // $1000 drawdown reduction = 1 point
      ((meanRetained - 85) * 2);            // bonus for retaining more mean
    
    if (score > bestScore) {
      bestScore = score;
      bestCap = result.cap;
      bestMetrics = {
        baselineMeanRetained: meanRetained,
        attackLossProbReduction: lossProbReduction,
        attackDrawdownReduction: drawdownReduction,
      };
    }
  }
  
  const reasoning = bestCap
    ? `$${bestCap} cap retains ${bestMetrics.baselineMeanRetained.toFixed(1)}% of baseline profit while reducing attack-month loss probability by ${(bestMetrics.attackLossProbReduction * 100).toFixed(1)}% and drawdown by $${Math.round(bestMetrics.attackDrawdownReduction).toLocaleString()}.`
    : 'No cap provides the best overall economics (attack scenarios already manageable).';
  
  return {
    optimalCap: bestCap,
    reasoning,
    metrics: bestMetrics,
  };
}

// Pretty-print for console/test output
export function formatAnalysisReport(summary: CapAnalysisSummary): string {
  const lines: string[] = [
    '═══════════════════════════════════════════════════════════════════════',
    '              FIRST PAYOUT CAP SENSITIVITY ANALYSIS',
    '═══════════════════════════════════════════════════════════════════════',
    '',
    `Config: ${summary.config.iterations} iterations × ${summary.config.monthsPerIteration} months (seed: ${summary.config.seed})`,
    '',
    '┌──────────┬────────────────────────────────────┬──────────────────────────────┬──────────────────────────────┐',
    '│   Cap    │          BASELINE                  │     COORDINATED ATTACK       │        TIKTOK VIRAL          │',
    '│          │  Mean    P5     Loss%   Margin     │  Mean    P5     Loss%  Draw  │  Mean    P5     Loss%  Draw  │',
    '├──────────┼────────────────────────────────────┼──────────────────────────────┼──────────────────────────────┤',
  ];
  
  for (const r of summary.results) {
    const capStr = r.capLabel.padStart(8);
    const bMean = `$${(r.baseline.meanProfit / 1000).toFixed(1)}k`.padStart(6);
    const bP5 = `$${(r.baseline.p5Profit / 1000).toFixed(1)}k`.padStart(6);
    const bLoss = `${(r.baseline.lossProb * 100).toFixed(1)}%`.padStart(5);
    const bMargin = `${(r.baseline.margin * 100).toFixed(1)}%`.padStart(6);
    
    const aMean = `$${(r.coordinatedAttack.meanProfit / 1000).toFixed(1)}k`.padStart(6);
    const aP5 = `$${(r.coordinatedAttack.p5Profit / 1000).toFixed(1)}k`.padStart(6);
    const aLoss = `${(r.coordinatedAttack.lossProb * 100).toFixed(1)}%`.padStart(5);
    const aDraw = `$${(r.coordinatedAttack.maxDrawdown / 1000).toFixed(0)}k`.padStart(5);
    
    const vMean = `$${(r.tiktokViral.meanProfit / 1000).toFixed(1)}k`.padStart(6);
    const vP5 = `$${(r.tiktokViral.p5Profit / 1000).toFixed(1)}k`.padStart(6);
    const vLoss = `${(r.tiktokViral.lossProb * 100).toFixed(1)}%`.padStart(5);
    const vDraw = `$${(r.tiktokViral.maxDrawdown / 1000).toFixed(0)}k`.padStart(5);
    
    lines.push(`│${capStr} │ ${bMean} ${bP5} ${bLoss} ${bMargin}    │ ${aMean} ${aP5} ${aLoss} ${aDraw} │ ${vMean} ${vP5} ${vLoss} ${vDraw} │`);
  }
  
  lines.push('└──────────┴────────────────────────────────────┴──────────────────────────────┴──────────────────────────────┘');
  lines.push('');
  lines.push('RECOMMENDATION');
  lines.push('──────────────');
  lines.push(`Optimal Cap: ${summary.recommendation.optimalCap ? `$${summary.recommendation.optimalCap}` : 'No Cap'}`);
  lines.push(`Reasoning: ${summary.recommendation.reasoning}`);
  lines.push('');
  lines.push('Metrics vs No-Cap:');
  lines.push(`  • Baseline Mean Retained: ${summary.recommendation.metrics.baselineMeanRetained.toFixed(1)}%`);
  lines.push(`  • Attack Loss Prob Reduction: ${(summary.recommendation.metrics.attackLossProbReduction * 100).toFixed(1)} percentage points`);
  lines.push(`  • Attack Drawdown Reduction: $${Math.round(summary.recommendation.metrics.attackDrawdownReduction).toLocaleString()}`);
  lines.push('');
  
  return lines.join('\n');
}
