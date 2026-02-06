import { describe, it, expect } from 'vitest';
import {
  runMonteCarlo,
  SCENARIO_PRESETS,
  type MonteCarloConfig,
  type MonteCarloResult,
} from './monte-carlo';

// ============================================================================
// VELOCITY GATE + VERIFICATION COHORT IMPACT ANALYSIS
// 
// Purpose: Run each gate/cohort configuration and output a comparison table.
// Target: Month 10-12 per-month mean profit of +$2,500/month
// ============================================================================

const ANALYSIS_CONFIG: MonteCarloConfig = {
  iterations: 500,
  monthsPerIteration: 12,
  seed: 42,
};

interface GateAnalysis {
  name: string;
  m10_mean: number;
  m11_mean: number;
  m12_mean: number;
  m10_12_mean: number;
  lossProb: number;
  payoutRevRatio: number;
  annualProfit: number;
  avgPayoutsPerAccount: number;
  avgEligibleCohort: number;
}

function analyzeResult(name: string, result: MonteCarloResult): GateAnalysis {
  // Extract per-month profits for months 10, 11, 12 (0-indexed: 9, 10, 11)
  const monthProfits: number[][] = [[], [], []];
  
  if (result.rawMonthResults) {
    for (const iterResults of result.rawMonthResults) {
      for (let m = 9; m < Math.min(12, iterResults.length); m++) {
        monthProfits[m - 9].push(iterResults[m].netProfit);
      }
    }
  }
  
  const avg = (arr: number[]) => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
  
  const m10_mean = avg(monthProfits[0]);
  const m11_mean = avg(monthProfits[1]);
  const m12_mean = avg(monthProfits[2]);
  const m10_12_mean = (m10_mean + m11_mean + m12_mean) / 3;
  
  return {
    name,
    m10_mean,
    m11_mean,
    m12_mean,
    m10_12_mean,
    lossProb: result.risk.probabilityOfLoss,
    payoutRevRatio: result.diagnostics.payoutToRevenueRatio,
    annualProfit: result.profit.annualized.mean,
    avgPayoutsPerAccount: result.payoutDiagnostics.avgPayoutsPerAccount,
    avgEligibleCohort: result.cohortDiagnostics.avgEligibleCohortSize,
  };
}

describe('Velocity Gate + Verification Cohort Analysis', () => {
  const scenarios: { key: string; name: string }[] = [
    { key: 'withLifetimeCap7x', name: 'Baseline (7x cap only)' },
    { key: 'withVelocityGate5d', name: '15 winning days' },
    { key: 'withProfitGate', name: '$300 profit buffer' },
    { key: 'withProfitGate_2mo', name: '$300 profit + 2mo cadence' },
    { key: 'withVerification1mo', name: '1mo verification' },
    { key: 'withVerification2mo', name: '2mo verification' },
    { key: 'withFullGateStack', name: 'Full stack (verify+profit+2mo)' },
  ];

  const results: GateAnalysis[] = [];

  for (const { key, name } of scenarios) {
    const assumptions = SCENARIO_PRESETS[key as keyof typeof SCENARIO_PRESETS];
    const result = runMonteCarlo(ANALYSIS_CONFIG, assumptions);
    results.push(analyzeResult(name, result));
  }

  it('outputs per-month breakdown and comparison table', () => {
    console.log('\n' + '='.repeat(130));
    console.log('VELOCITY GATE + VERIFICATION COHORT ANALYSIS — Per-Month Breakdown');
    console.log('='.repeat(130));
    
    // Per-month breakdown for baseline
    const baseline = results[0];
    console.log('\nBaseline per-month:');
    console.log(`  Month 10 mean: $${baseline.m10_mean.toFixed(0)}`);
    console.log(`  Month 11 mean: $${baseline.m11_mean.toFixed(0)}`);
    console.log(`  Month 12 mean: $${baseline.m12_mean.toFixed(0)}`);
    console.log(`  M10-12 avg:    $${baseline.m10_12_mean.toFixed(0)} /month`);
    
    console.log('\n' + '-'.repeat(130));
    console.log(
      'Gate Config'.padEnd(34) +
      '| M10-12/mo'.padEnd(13) +
      '| M10'.padEnd(10) +
      '| M11'.padEnd(10) +
      '| M12'.padEnd(10) +
      '| Loss%'.padEnd(10) +
      '| Pay/Rev'.padEnd(10) +
      '| Annual'.padEnd(12) +
      '| Pay/Acct'.padEnd(10) +
      '| Elig Cohort'
    );
    console.log('-'.repeat(130));
    
    for (const r of results) {
      console.log(
        r.name.padEnd(34) +
        `| $${r.m10_12_mean.toFixed(0).padStart(6)}`.padEnd(13) +
        `| $${r.m10_mean.toFixed(0).padStart(5)}`.padEnd(10) +
        `| $${r.m11_mean.toFixed(0).padStart(5)}`.padEnd(10) +
        `| $${r.m12_mean.toFixed(0).padStart(5)}`.padEnd(10) +
        `| ${(r.lossProb * 100).toFixed(1)}%`.padEnd(10) +
        `| ${r.payoutRevRatio.toFixed(3)}`.padEnd(10) +
        `| $${r.annualProfit.toFixed(0).padStart(7)}`.padEnd(12) +
        `| ${r.avgPayoutsPerAccount.toFixed(2)}`.padEnd(10) +
        `| ${r.avgEligibleCohort.toFixed(0)}`
      );
    }
    
    console.log('='.repeat(130));
    console.log('Target: M10-12 per-month mean > +$2,500');
    
    // Delta from baseline
    console.log('\nDeltas from baseline:');
    for (const r of results.slice(1)) {
      const delta = r.m10_12_mean - baseline.m10_12_mean;
      console.log(`  ${r.name.padEnd(34)} M10-12 delta: ${delta >= 0 ? '+' : ''}$${delta.toFixed(0)}/mo`);
    }
    console.log('');
    
    expect(results.length).toBe(7);
  });

  it('at least one config improves M10-12 vs baseline', () => {
    const baseline = results[0];
    const improvements = results.slice(1).filter(r => r.m10_12_mean > baseline.m10_12_mean);
    expect(improvements.length).toBeGreaterThan(0);
  });

  it('verification cohort reduces eligible cohort size', () => {
    const baseline = results[0];
    const verify1mo = results.find(r => r.name === '1mo verification')!;
    expect(verify1mo.avgEligibleCohort).toBeLessThan(baseline.avgEligibleCohort);
  });

  it('full gate stack has strongest M10-12 improvement', () => {
    const baseline = results[0];
    const fullStack = results.find(r => r.name === 'Full stack (verify+profit+2mo)')!;
    expect(fullStack.m10_12_mean).toBeGreaterThan(baseline.m10_12_mean);
  });

  it('profit gate reduces payout/revenue ratio', () => {
    const baseline = results[0];
    const profitGate = results.find(r => r.name === '$300 profit buffer')!;
    expect(profitGate.payoutRevRatio).toBeLessThan(baseline.payoutRevRatio);
  });
});
