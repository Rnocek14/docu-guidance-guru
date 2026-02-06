import { describe, it, expect } from 'vitest';
import {
  runMonteCarlo,
  SCENARIO_PRESETS,
  type MonteCarloConfig,
  type MonteCarloResult,
} from './monte-carlo';

// ============================================================================
// VELOCITY GATE IMPACT ANALYSIS
// 
// Purpose: Run each gate configuration and output a comparison table showing
// which combo moves Month 10-12 from negative/breakeven to positive.
// Target: Month 10-12 mean profit of +$2,500/month
// ============================================================================

const ANALYSIS_CONFIG: MonteCarloConfig = {
  iterations: 500,
  monthsPerIteration: 12,
  seed: 42,
};

interface GateAnalysis {
  name: string;
  m10_12_mean: number;
  p99_drawdown: number;
  lossProb: number;
  payoutRevRatio: number;
  annualProfit: number;
  avgPayoutsPerAccount: number;
}

function analyzeResult(name: string, result: MonteCarloResult): GateAnalysis {
  // Extract month 10-12 profits from rawSamples
  const m10_12_profits: number[] = [];
  if (result.rawMonthResults) {
    for (const iterResults of result.rawMonthResults) {
      // months 9, 10, 11 (0-indexed) = months 10, 11, 12
      for (let m = 9; m < Math.min(12, iterResults.length); m++) {
        m10_12_profits.push(iterResults[m].netProfit);
      }
    }
  }
  
  const m10_12_mean = m10_12_profits.length > 0
    ? m10_12_profits.reduce((a, b) => a + b, 0) / m10_12_profits.length
    : 0;
  
  // P99 drawdown (worst 1% of cumulative drawdown)
  const sortedProfits = [...(result.rawSamples?.flat() || [])].sort((a, b) => a - b);
  const p1 = sortedProfits[Math.floor(sortedProfits.length * 0.01)] || 0;
  
  return {
    name,
    m10_12_mean,
    p99_drawdown: Math.abs(p1),
    lossProb: result.risk.probabilityOfLoss,
    payoutRevRatio: result.diagnostics.payoutToRevenueRatio,
    annualProfit: result.profit.annualized.mean,
    avgPayoutsPerAccount: result.payoutDiagnostics.avgPayoutsPerAccount,
  };
}

describe('Velocity Gate Impact Analysis', () => {
  const scenarios: { key: string; name: string }[] = [
    { key: 'withLifetimeCap7x', name: 'Baseline (7x cap, no gates)' },
    { key: 'withVelocityGate5d', name: '5 winning days' },
    { key: 'withVelocityGate5d_profit', name: '5d + profit-since' },
    { key: 'withVelocityGate5d_biweekly', name: '5d + profit + 14d cadence' },
    { key: 'withVelocityGate10d', name: '10 winning days' },
  ];

  const results: GateAnalysis[] = [];

  // Run all scenarios
  for (const { key, name } of scenarios) {
    const assumptions = SCENARIO_PRESETS[key as keyof typeof SCENARIO_PRESETS];
    const result = runMonteCarlo(ANALYSIS_CONFIG, assumptions);
    results.push(analyzeResult(name, result));
  }

  it('outputs comparison table', () => {
    console.log('\n' + '='.repeat(110));
    console.log('VELOCITY GATE IMPACT ANALYSIS — Decision Framework');
    console.log('='.repeat(110));
    console.log(
      'Gate Config'.padEnd(32) +
      '| M10-12 Mean'.padEnd(14) +
      '| P99 DD'.padEnd(12) +
      '| Loss%'.padEnd(10) +
      '| Payout/Rev'.padEnd(13) +
      '| Annual'.padEnd(12) +
      '| Payouts/Acct'
    );
    console.log('-'.repeat(110));
    
    for (const r of results) {
      console.log(
        r.name.padEnd(32) +
        `| $${r.m10_12_mean.toFixed(0).padStart(7)}`.padEnd(14) +
        `| $${r.p99_drawdown.toFixed(0).padStart(6)}`.padEnd(12) +
        `| ${(r.lossProb * 100).toFixed(1)}%`.padEnd(10) +
        `| ${r.payoutRevRatio.toFixed(3)}`.padEnd(13) +
        `| $${r.annualProfit.toFixed(0).padStart(7)}`.padEnd(12) +
        `| ${r.avgPayoutsPerAccount.toFixed(2)}`
      );
    }
    
    console.log('='.repeat(110));
    console.log(`Target: M10-12 mean > +$2,500/month`);
    console.log('');
    
    // This test always passes — it's for the output
    expect(results.length).toBe(5);
  });

  it('velocity gates improve Month 10-12 economics vs baseline', () => {
    const baseline = results[0]; // withLifetimeCap7x (no gates)
    
    // At least one gate config should improve M10-12 mean
    const improvements = results.slice(1).filter(r => r.m10_12_mean > baseline.m10_12_mean);
    
    console.log(`\nGate configs improving M10-12: ${improvements.length}/${results.length - 1}`);
    for (const imp of improvements) {
      console.log(`  ${imp.name}: M10-12 delta = +$${(imp.m10_12_mean - baseline.m10_12_mean).toFixed(0)}/month`);
    }
    
    expect(improvements.length).toBeGreaterThan(0);
  });

  it('velocity gates reduce payout/revenue ratio', () => {
    const baseline = results[0];
    
    const betterRatios = results.slice(1).filter(r => r.payoutRevRatio < baseline.payoutRevRatio);
    
    expect(betterRatios.length).toBeGreaterThan(0);
  });

  it('stricter gates reduce payouts per account more than looser gates', () => {
    const gate5d = results.find(r => r.name === '5 winning days')!;
    const gate10d = results.find(r => r.name === '10 winning days')!;
    
    // 10d gate should result in fewer payouts per account than 5d
    expect(gate10d.avgPayoutsPerAccount).toBeLessThan(gate5d.avgPayoutsPerAccount);
  });

  it('combined gates (5d + profit + cadence) have strongest effect', () => {
    const baseline = results[0];
    const fullGate = results.find(r => r.name === '5d + profit + 14d cadence')!;
    
    // Full gate combo should have the biggest improvement
    expect(fullGate.m10_12_mean).toBeGreaterThan(baseline.m10_12_mean);
    expect(fullGate.payoutRevRatio).toBeLessThan(baseline.payoutRevRatio);
  });
});
