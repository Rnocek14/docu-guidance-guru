/**
 * 6-Month Slow Growth Simulation
 * 
 * Models a conservative early-stage scenario with gradual account growth.
 */

import {
  runMonteCarlo,
  MonteCarloConfig,
  MonteCarloAssumptions,
  DEFAULT_ASSUMPTIONS,
} from './monte-carlo';

// Slow growth assumptions: start small, gradual increase
const SLOW_GROWTH_ASSUMPTIONS: MonteCarloAssumptions = {
  // Conservative acquisition (ramping from ~50 to ~150 over 6 months → avg ~100/month)
  accountsPerMonth: 100,
  pricePerAccount: 149, // Starter tier

  // Slightly lower pass rate during early phase (learning curve)
  passRate: { min: 0.08, mode: 0.12, max: 0.18 },
  payoutRequestRate: { min: 0.50, mode: 0.65, max: 0.80 },
  avgDaysToFirstPayout: 21, // slightly longer as traders learn

  // Conservative payout behavior
  avgPayoutAmount: { mean: 350, stdDev: 150 },
  payoutsPerPaidAccountPerMonth: { min: 0.8, mode: 1.0, max: 1.4 },

  // Lower fraud in early stages (smaller pool, less sophisticated)
  fraudAttemptRate: { min: 0.03, mode: 0.05, max: 0.08 },
  fraudSuccessRate: { min: 0.003, mode: 0.006, max: 0.010 },
  chargebackRate: { min: 0.01, mode: 0.02, max: 0.03 },
  resetRate: 0.15, // 15% annualized

  // Costs
  variableCostPerAccount: 8,
  fixedMonthlyCosts: 1500, // solo operator: Supabase + hosting + Lovable + misc

  // Your production knobs
  knobs: {
    firstPayoutCap: 300,
    payoutSplitPercent: 0.80,
    maxPayoutPercent: 0.80,
    resetPrice: 99,
    lifetimeCapPerUser: 149 * 7, // 7× = $1,043
    attackIntensity: 0,
    minWinningDaysPerPayout: 0,
    requireProfitSinceLastPayout: false,
    payoutCadenceDays: 0,
  },
};

const SIX_MONTH_CONFIG: MonteCarloConfig = {
  iterations: 500,
  monthsPerIteration: 6,
  seed: 42,
};

export function runSlowGrowthSimulation() {
  console.log('Running 6-month slow growth simulation...');
  
  const result = runMonteCarlo(SIX_MONTH_CONFIG, SLOW_GROWTH_ASSUMPTIONS);
  
  const totalRevenue6Mo = result.diagnostics.avgMonthlyRevenue * 6;
  const totalPayouts6Mo = result.diagnostics.avgMonthlyPayouts * 6;
  const totalCosts6Mo = result.diagnostics.avgMonthlyCosts * 6;
  const totalProfit6Mo = result.profit.mean * 6;
  
  return {
    config: SIX_MONTH_CONFIG,
    assumptions: SLOW_GROWTH_ASSUMPTIONS,
    
    summary: {
      totalProfit6Mo: Math.round(totalProfit6Mo),
      profitP5: Math.round(result.profit.p5 * 6),
      profitP95: Math.round(result.profit.p95 * 6),
      monthlyProfitMean: Math.round(result.profit.mean),
      monthlyProfitP5: Math.round(result.profit.p5),
      monthlyProfitP95: Math.round(result.profit.p95),
      lossMonthProbability: result.risk.probabilityOfLoss,
      maxDrawdown: Math.round(result.risk.maxDrawdown),
      worstMonth: Math.round(result.risk.worstMonth),
      bestMonth: Math.round(result.risk.bestMonth),
    },
    
    breakdown: {
      totalRevenue6Mo: Math.round(totalRevenue6Mo),
      totalPayouts6Mo: Math.round(totalPayouts6Mo),
      totalCosts6Mo: Math.round(totalCosts6Mo),
      effectiveMargin: result.diagnostics.effectiveMargin,
      payoutToRevenueRatio: result.diagnostics.payoutToRevenueRatio,
    },
    
    payoutMetrics: {
      avgPayoutSize: Math.round(result.payoutDiagnostics.avgPayoutSize),
      firstPayoutCapBindingRate: result.payoutDiagnostics.firstPayoutCapBindingRate,
      lifetimeCapBindingRate: result.payoutDiagnostics.lifetimeCapBindingRate,
      avgLifetimePaidPerAccount: Math.round(result.payoutDiagnostics.avgLifetimePaidPerAccount),
    },
    
    cohortMetrics: {
      avgActiveCohortSize: Math.round(result.cohortDiagnostics.avgActiveCohortSize),
      avgEligibleCohortSize: Math.round(result.cohortDiagnostics.avgEligibleCohortSize),
    },
    
    rawResult: result,
  };
}

export function formatSlowGrowthReport(): string {
  const sim = runSlowGrowthSimulation();
  
  const isProfit = sim.summary.totalProfit6Mo >= 0;
  const profitLabel = isProfit ? 'PROFIT' : 'LOSS';
  
  const lines = [
    '═══════════════════════════════════════════════════════════════════════',
    '          6-MONTH SLOW GROWTH SIMULATION RESULTS',
    '═══════════════════════════════════════════════════════════════════════',
    '',
    `Scenario: ${sim.config.iterations} iterations × ${sim.config.monthsPerIteration} months`,
    `Assumptions: ~${sim.assumptions.accountsPerMonth} new accounts/month @ $${sim.assumptions.pricePerAccount}`,
    `Pass rate: ${(sim.assumptions.passRate.mode * 100).toFixed(0)}% (range ${(sim.assumptions.passRate.min * 100).toFixed(0)}-${(sim.assumptions.passRate.max * 100).toFixed(0)}%)`,
    `First payout cap: $${sim.assumptions.knobs.firstPayoutCap}`,
    `Lifetime cap: ${sim.assumptions.knobs.lifetimeCapPerUser ? `$${sim.assumptions.knobs.lifetimeCapPerUser} (7×)` : 'None'}`,
    '',
    '───────────────────────────────────────────────────────────────────────',
    '                        6-MONTH PROJECTIONS',
    '───────────────────────────────────────────────────────────────────────',
    '',
    `  Expected 6-Month ${profitLabel}: ${isProfit ? '+' : ''}$${sim.summary.totalProfit6Mo.toLocaleString()}`,
    `  Pessimistic (P5):               ${sim.summary.profitP5 >= 0 ? '+' : ''}$${sim.summary.profitP5.toLocaleString()}`,
    `  Optimistic (P95):               +$${sim.summary.profitP95.toLocaleString()}`,
    '',
    '───────────────────────────────────────────────────────────────────────',
    '                        MONTHLY BREAKDOWN',
    '───────────────────────────────────────────────────────────────────────',
    '',
    `  Avg Monthly Profit:    ${sim.summary.monthlyProfitMean >= 0 ? '+' : ''}$${sim.summary.monthlyProfitMean.toLocaleString()}`,
    `  Monthly Range:         $${sim.summary.monthlyProfitP5.toLocaleString()} to $${sim.summary.monthlyProfitP95.toLocaleString()}`,
    `  Best Single Month:     +$${sim.summary.bestMonth.toLocaleString()}`,
    `  Worst Single Month:    $${sim.summary.worstMonth.toLocaleString()}`,
    `  Losing Month Prob:     ${(sim.summary.lossMonthProbability * 100).toFixed(1)}%`,
    `  Max Drawdown:          $${sim.summary.maxDrawdown.toLocaleString()}`,
    '',
    '───────────────────────────────────────────────────────────────────────',
    '                        FINANCIAL FLOWS',
    '───────────────────────────────────────────────────────────────────────',
    '',
    `  6-Month Revenue:       $${sim.breakdown.totalRevenue6Mo.toLocaleString()}`,
    `  6-Month Payouts:       $${sim.breakdown.totalPayouts6Mo.toLocaleString()}`,
    `  6-Month Costs:         $${sim.breakdown.totalCosts6Mo.toLocaleString()}`,
    `  Effective Margin:      ${(sim.breakdown.effectiveMargin * 100).toFixed(1)}%`,
    `  Payout/Revenue Ratio:  ${(sim.breakdown.payoutToRevenueRatio * 100).toFixed(1)}%`,
    '',
    '───────────────────────────────────────────────────────────────────────',
    '                        CAP EFFECTIVENESS',
    '───────────────────────────────────────────────────────────────────────',
    '',
    `  First Payout Cap Binding:   ${(sim.payoutMetrics.firstPayoutCapBindingRate * 100).toFixed(1)}%`,
    `  Lifetime Cap Binding:       ${(sim.payoutMetrics.lifetimeCapBindingRate * 100).toFixed(1)}%`,
    `  Avg Payout Size:            $${sim.payoutMetrics.avgPayoutSize}`,
    `  Avg Lifetime Paid/Account:  $${sim.payoutMetrics.avgLifetimePaidPerAccount}`,
    '',
    '───────────────────────────────────────────────────────────────────────',
    '                        COHORT DYNAMICS',
    '───────────────────────────────────────────────────────────────────────',
    '',
    `  Avg Active Cohort Size:     ${sim.cohortMetrics.avgActiveCohortSize} accounts`,
    `  Avg Eligible Cohort Size:   ${sim.cohortMetrics.avgEligibleCohortSize} accounts`,
    '',
    '═══════════════════════════════════════════════════════════════════════',
    '',
  ];
  
  // Add interpretation
  if (sim.summary.totalProfit6Mo > 0) {
    lines.push('✅ VERDICT: Profitable under slow growth assumptions.');
    lines.push(`   Expected to generate ~$${Math.round(sim.summary.totalProfit6Mo / 6).toLocaleString()}/month profit.`);
    if (sim.summary.lossMonthProbability < 0.10) {
      lines.push('   Low risk of losing months (<10%).');
    } else if (sim.summary.lossMonthProbability < 0.25) {
      lines.push('   Moderate risk of occasional losing months (10-25%).');
    } else {
      lines.push('   ⚠️ Notable risk of losing months (>25%) - monitor closely.');
    }
  } else {
    lines.push('❌ VERDICT: Expected loss under these assumptions.');
    lines.push('   Consider: higher pricing, lower costs, or tighter caps.');
  }
  
  lines.push('');
  
  return lines.join('\n');
}
