/**
 * Monte Carlo Analysis Utilities
 * 
 * Higher-level analysis functions that use the core Monte Carlo engine
 * to produce actionable business insights.
 */

import {
  runMonteCarlo,
  runLifetimeCapSweep,
  MonteCarloConfig,
  MonteCarloAssumptions,
  DEFAULT_ASSUMPTIONS,
  SCENARIO_PRESETS,
  type LifetimeCapSweepResult,
} from './monte-carlo';

// ============================================================================
// FIRST PAYOUT CAP ANALYSIS (existing)
// ============================================================================

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
  vsNoCap: {
    baselineMeanDelta: number;
    baselineP5Delta: number;
    attackLossProbDelta: number;
    attackDrawdownDelta: number;
  };
}

export interface CapAnalysisSummary {
  config: MonteCarloConfig;
  results: CapAnalysisResult[];
  recommendation: {
    optimalCap: number | null;
    reasoning: string;
    metrics: {
      baselineMeanRetained: number;
      attackLossProbReduction: number;
      attackDrawdownReduction: number;
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
    
    if (meanRetained < 85) continue;
    
    const lossProbReduction = noCapResult.coordinatedAttack.lossProb - result.coordinatedAttack.lossProb;
    const drawdownReduction = noCapResult.coordinatedAttack.maxDrawdown - result.coordinatedAttack.maxDrawdown;
    
    const score = 
      (lossProbReduction * 100) +
      (drawdownReduction / 1000) +
      ((meanRetained - 85) * 2);
    
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

// ============================================================================
// LIFETIME CAP ANALYSIS (NEW - with real binding diagnostics)
// ============================================================================

export interface LifetimeCapRecommendation {
  recommendedMultiple: number;
  recommendedCapDollars: number;
  reasoning: string;
  metrics: {
    capBindingRate: number;
    marginPreservation: number;
    profitDelta: number;
    accountsCompletedByCap: number;
  };
}

export interface LifetimeCapAnalysisReport {
  entryFee: number;
  sweepResults: LifetimeCapSweepResult[];
  recommendation: LifetimeCapRecommendation;
  warnings: string[];
}

/**
 * Run a comprehensive lifetime cap analysis with real binding diagnostics
 */
export function analyzeLifetimeCaps(
  config: MonteCarloConfig = { iterations: 100, monthsPerIteration: 12 },
  assumptions: MonteCarloAssumptions = DEFAULT_ASSUMPTIONS
): LifetimeCapAnalysisReport {
  const multiples = [null, 15, 12, 10, 9, 8, 7, 6, 5, 4, 3];
  const sweepResults = runLifetimeCapSweep(config, assumptions, multiples);
  
  const warnings: string[] = [];
  const entryFee = assumptions.pricePerAccount;
  
  const unlimited = sweepResults.find(r => r.multiple === null);
  if (!unlimited) {
    throw new Error('Unlimited baseline not found in sweep');
  }
  
  const baselineMargin = unlimited.result.diagnostics.effectiveMargin;
  
  let bestMultiple = 7;
  let bestScore = -Infinity;
  
  for (const result of sweepResults) {
    if (result.multiple === null) continue;
    
    const marginPreservation = baselineMargin > 0 
      ? (result.result.diagnostics.effectiveMargin / baselineMargin) 
      : 1;
    
    // Score: balance margin preservation vs cap binding effectiveness
    // We WANT some binding (proves cap is doing something) but not too much
    const bindingScore = result.capBindingRate > 0.05 && result.capBindingRate < 0.30 
      ? 1 
      : result.capBindingRate >= 0.30 
        ? 0.5 
        : 0;
    
    const marginScore = marginPreservation >= 0.95 ? 1 : marginPreservation >= 0.90 ? 0.8 : 0.5;
    
    const score = bindingScore * marginScore;
    
    if (score > bestScore) {
      bestScore = score;
      bestMultiple = result.multiple;
    }
    
    // Collect warnings
    if (result.capBindingRate === 0 && result.multiple !== null && result.multiple <= 10) {
      warnings.push(`${result.multiple}× cap ($${result.capDollars}) never binds - may be too high or simulation not reaching it`);
    }
    
    if (result.capBindingRate > 0.5) {
      warnings.push(`${result.multiple}× cap binds on ${(result.capBindingRate * 100).toFixed(1)}% of accounts - may be too aggressive`);
    }
  }
  
  const recommended = sweepResults.find(r => r.multiple === bestMultiple);
  if (!recommended) {
    throw new Error('Could not find recommended cap level');
  }
  
  const marginPreservation = baselineMargin > 0 
    ? (recommended.result.diagnostics.effectiveMargin / baselineMargin) 
    : 1;
  
  let reasoning = `${bestMultiple}× ($${recommended.capDollars}) selected because: `;
  if (recommended.capBindingRate > 0) {
    reasoning += `binds on ${(recommended.capBindingRate * 100).toFixed(1)}% of accounts, `;
  }
  reasoning += `preserves ${(marginPreservation * 100).toFixed(1)}% of baseline margin`;
  if (recommended.profitDelta > 0) {
    reasoning += `, increases monthly profit by $${recommended.profitDelta.toFixed(0)}`;
  }
  
  return {
    entryFee,
    sweepResults,
    recommendation: {
      recommendedMultiple: bestMultiple,
      recommendedCapDollars: recommended.capDollars!,
      reasoning,
      metrics: {
        capBindingRate: recommended.capBindingRate,
        marginPreservation,
        profitDelta: recommended.profitDelta,
        accountsCompletedByCap: recommended.accountsCompletedByCap,
      },
    },
    warnings,
  };
}

export function formatLifetimeCapReport(report: LifetimeCapAnalysisReport): string {
  const lines: string[] = [
    '═══════════════════════════════════════════════════════════════════════',
    '              LIFETIME CAP ANALYSIS (with binding diagnostics)',
    '═══════════════════════════════════════════════════════════════════════',
    '',
    `Entry Fee: $${report.entryFee}`,
    '',
    '┌──────────┬──────────┬──────────┬──────────┬──────────┬──────────┬──────────┬──────────┐',
    '│ Multiple │ Cap $    │ Binding% │ Margin   │ Profit Δ │ Accts    │ Avg Paid │ Headroom │',
    '│          │          │          │          │          │ Complete │ /Account │ at End   │',
    '├──────────┼──────────┼──────────┼──────────┼──────────┼──────────┼──────────┼──────────┤',
  ];
  
  for (const r of report.sweepResults) {
    const multiple = r.multiple === null ? 'Unlimit' : `${r.multiple}×`;
    const capDollars = r.capDollars === null ? 'N/A' : `$${r.capDollars}`;
    const binding = `${(r.capBindingRate * 100).toFixed(1)}%`;
    const margin = `${(r.result.diagnostics.effectiveMargin * 100).toFixed(1)}%`;
    const profitDelta = r.profitDelta >= 0 ? `+$${r.profitDelta.toFixed(0)}` : `-$${Math.abs(r.profitDelta).toFixed(0)}`;
    const completed = r.accountsCompletedByCap.toString();
    const avgPaid = `$${r.avgLifetimePaidPerAccount.toFixed(0)}`;
    const headroom = r.avgHeadroomAtEnd === Infinity ? 'N/A' : `$${r.avgHeadroomAtEnd.toFixed(0)}`;
    
    lines.push(`│ ${multiple.padStart(8)} │ ${capDollars.padStart(8)} │ ${binding.padStart(8)} │ ${margin.padStart(8)} │ ${profitDelta.padStart(8)} │ ${completed.padStart(8)} │ ${avgPaid.padStart(8)} │ ${headroom.padStart(8)} │`);
  }
  
  lines.push('└──────────┴──────────┴──────────┴──────────┴──────────┴──────────┴──────────┴──────────┘');
  lines.push('');
  
  if (report.warnings.length > 0) {
    lines.push('⚠️  WARNINGS');
    lines.push('──────────────');
    for (const warning of report.warnings) {
      lines.push(`  • ${warning}`);
    }
    lines.push('');
  }
  
  lines.push('RECOMMENDATION');
  lines.push('──────────────');
  lines.push(`Optimal Cap: ${report.recommendation.recommendedMultiple}× ($${report.recommendation.recommendedCapDollars})`);
  lines.push(`Reasoning: ${report.recommendation.reasoning}`);
  lines.push('');
  lines.push('Key Metrics:');
  lines.push(`  • Cap Binding Rate: ${(report.recommendation.metrics.capBindingRate * 100).toFixed(1)}%`);
  lines.push(`  • Margin Preservation: ${(report.recommendation.metrics.marginPreservation * 100).toFixed(1)}%`);
  lines.push(`  • Monthly Profit Delta: $${report.recommendation.metrics.profitDelta.toFixed(0)}`);
  lines.push(`  • Accounts Completed by Cap: ${report.recommendation.metrics.accountsCompletedByCap}`);
  lines.push('');
  
  return lines.join('\n');
}

// ============================================================================
// TIER ANALYSIS
// ============================================================================

export interface TierDefinition {
  name: string;
  accountSize: number;
  entryFee: number;
  resetFee: number;
  firstPayoutCap: number;
  lifetimeCapMultiple: number;
  payoutSplitPercent: number;
}

export interface TierAnalysisResult {
  tier: TierDefinition;
  result: ReturnType<typeof runMonteCarlo>;
  ltv: {
    avgLifetimePaid: number;
    avgPayoutsPerAccount: number;
    netLtvPerAccount: number;
  };
  risk: {
    lifetimeCapBindingRate: number;
    firstPayoutCapBindingRate: number;
    effectiveMargin: number;
  };
}

export function analyzeTier(
  tier: TierDefinition,
  config: MonteCarloConfig = { iterations: 100, monthsPerIteration: 12 }
): TierAnalysisResult {
  const assumptions: MonteCarloAssumptions = {
    ...DEFAULT_ASSUMPTIONS,
    pricePerAccount: tier.entryFee,
    knobs: {
      ...DEFAULT_ASSUMPTIONS.knobs,
      firstPayoutCap: tier.firstPayoutCap,
      payoutSplitPercent: tier.payoutSplitPercent / 100,
      lifetimeCapPerUser: tier.entryFee * tier.lifetimeCapMultiple,
      resetPrice: tier.resetFee,
    },
  };
  
  const result = runMonteCarlo(config, assumptions);
  const pd = result.payoutDiagnostics;
  
  const avgLifetimePaid = pd.avgLifetimePaidPerAccount;
  const avgPayoutsPerAccount = pd.avgPayoutsPerAccount;
  
  const resetContribution = assumptions.resetRate * tier.resetFee;
  const netLtvPerAccount = tier.entryFee + resetContribution - avgLifetimePaid;
  
  return {
    tier,
    result,
    ltv: {
      avgLifetimePaid,
      avgPayoutsPerAccount,
      netLtvPerAccount,
    },
    risk: {
      lifetimeCapBindingRate: pd.lifetimeCapBindingRate,
      firstPayoutCapBindingRate: pd.firstPayoutCapBindingRate,
      effectiveMargin: result.diagnostics.effectiveMargin,
    },
  };
}

export const STANDARD_TIERS: TierDefinition[] = [
  {
    name: 'Starter',
    accountSize: 50000,
    entryFee: 149,
    resetFee: 99,
    firstPayoutCap: 300,
    lifetimeCapMultiple: 7,
    payoutSplitPercent: 80,
  },
  {
    name: 'Pro',
    accountSize: 100000,
    entryFee: 199,
    resetFee: 129,
    firstPayoutCap: 500,
    lifetimeCapMultiple: 9,
    payoutSplitPercent: 82,
  },
  {
    name: 'Elite',
    accountSize: 200000,
    entryFee: 349,
    resetFee: 199,
    firstPayoutCap: 750,
    lifetimeCapMultiple: 12,
    payoutSplitPercent: 85,
  },
];

export function analyzeAllTiers(
  config: MonteCarloConfig = { iterations: 100, monthsPerIteration: 12 }
): TierAnalysisResult[] {
  return STANDARD_TIERS.map(tier => analyzeTier(tier, config));
}

export function formatTierReport(results: TierAnalysisResult[]): string {
  const lines: string[] = [
    '═══════════════════════════════════════════════════════════════════════',
    '                      TIER ECONOMICS ANALYSIS',
    '═══════════════════════════════════════════════════════════════════════',
    '',
  ];
  
  for (const r of results) {
    lines.push(`▸ ${r.tier.name.toUpperCase()} TIER`);
    lines.push(`  Account: $${r.tier.accountSize.toLocaleString()} | Entry: $${r.tier.entryFee} | Reset: $${r.tier.resetFee}`);
    lines.push(`  First Cap: $${r.tier.firstPayoutCap} | Lifetime: ${r.tier.lifetimeCapMultiple}× ($${r.tier.entryFee * r.tier.lifetimeCapMultiple}) | Split: ${r.tier.payoutSplitPercent}%`);
    lines.push('');
    lines.push(`  LTV Metrics:`);
    lines.push(`    • Avg Lifetime Paid: $${r.ltv.avgLifetimePaid.toFixed(0)}`);
    lines.push(`    • Avg Payouts/Account: ${r.ltv.avgPayoutsPerAccount.toFixed(2)}`);
    lines.push(`    • Net LTV/Account: $${r.ltv.netLtvPerAccount.toFixed(0)}`);
    lines.push('');
    lines.push(`  Risk Metrics:`);
    lines.push(`    • First Cap Binding: ${(r.risk.firstPayoutCapBindingRate * 100).toFixed(1)}%`);
    lines.push(`    • Lifetime Cap Binding: ${(r.risk.lifetimeCapBindingRate * 100).toFixed(1)}%`);
    lines.push(`    • Effective Margin: ${(r.risk.effectiveMargin * 100).toFixed(1)}%`);
    lines.push('');
    lines.push(`  Profit (monthly):`);
    lines.push(`    • Mean: $${r.result.profit.mean.toFixed(0)}`);
    lines.push(`    • P5/P95: $${r.result.profit.p5.toFixed(0)} / $${r.result.profit.p95.toFixed(0)}`);
    lines.push(`    • Loss Probability: ${(r.result.risk.probabilityOfLoss * 100).toFixed(1)}%`);
    lines.push('');
    lines.push('───────────────────────────────────────────────────────────────────────');
    lines.push('');
  }
  
  return lines.join('\n');
}
