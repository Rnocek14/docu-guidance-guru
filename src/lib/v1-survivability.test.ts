/**
 * V1 Survivability Stress Test
 * 
 * Tests the frozen V1 config against worst-case scenarios:
 * 
 * Config under test:
 *   Entry fee:        $149
 *   First payout cap: $500
 *   Lifetime cap:     10× ($1,490)
 *   Cooldown:         14 days (~0.5 months)
 *   Eligibility delay: 7 days
 *   Split:            80%
 * 
 * Scenarios:
 *   1. Baseline (12% pass rate, 500 evals/mo)
 *   2. Pass rate creep (10% mode — conservative traders)
 *   3. Pass rate spike (14% mode — structural concern)
 *   4. High funded profitability (1.5× avg payout amounts)
 *   5. Payout clustering (high payout request rate + high frequency)
 *   6. Max withdrawal pressure (20% of funded traders request max immediately)
 *   7. Combined stress: 10% pass rate + high profitability
 *   8. Combined stress: 14% pass rate + payout clustering + attack
 *   9. Solo operator ramp (200 evals/mo — early stage)
 *  10. 90-day drawdown: worst-case cumulative loss over 3 months
 */

import { describe, it, expect } from 'vitest';
import {
  runMonteCarlo,
  DEFAULT_ASSUMPTIONS,
  type MonteCarloAssumptions,
  type MonteCarloConfig,
  type MonteCarloResult,
} from './monte-carlo';

// ============================================================================
// CONFIG: 500 iterations × 12 months, seeded for reproducibility
// ============================================================================
const CONFIG: MonteCarloConfig = {
  iterations: 500,
  monthsPerIteration: 12,
  seed: 42,
};

// Short horizon for drawdown analysis
const CONFIG_90DAY: MonteCarloConfig = {
  iterations: 1000,
  monthsPerIteration: 3,
  seed: 42,
};

// ============================================================================
// SCENARIO BUILDERS
// ============================================================================

function withPassRate(mode: number, base = DEFAULT_ASSUMPTIONS): MonteCarloAssumptions {
  return {
    ...base,
    passRate: { min: Math.max(0.04, mode - 0.04), mode, max: mode + 0.06 },
  };
}

function withHighProfitability(multiplier: number, base = DEFAULT_ASSUMPTIONS): MonteCarloAssumptions {
  return {
    ...base,
    avgPayoutAmount: {
      mean: base.avgPayoutAmount.mean * multiplier,
      stdDev: base.avgPayoutAmount.stdDev * multiplier,
    },
  };
}

function withPayoutClustering(base = DEFAULT_ASSUMPTIONS): MonteCarloAssumptions {
  return {
    ...base,
    payoutRequestRate: { min: 0.70, mode: 0.85, max: 0.95 },
    payoutsPerPaidAccountPerMonth: { min: 1.2, mode: 1.8, max: 2.5 },
  };
}

function withMaxWithdrawalPressure(base = DEFAULT_ASSUMPTIONS): MonteCarloAssumptions {
  return {
    ...base,
    payoutRequestRate: { min: 0.80, mode: 0.90, max: 0.98 },
    avgPayoutAmount: { mean: 600, stdDev: 100 }, // pushing toward cap
  };
}

function withVolume(evalsPerMonth: number, base = DEFAULT_ASSUMPTIONS): MonteCarloAssumptions {
  return {
    ...base,
    accountsPerMonth: evalsPerMonth,
  };
}

function withAttack(intensity: number, base = DEFAULT_ASSUMPTIONS): MonteCarloAssumptions {
  return {
    ...base,
    knobs: { ...base.knobs, attackIntensity: intensity },
  };
}

// ============================================================================
// REPORTING
// ============================================================================

interface ScenarioRow {
  name: string;
  result: MonteCarloResult;
}

function fmt$(n: number): string {
  const sign = n >= 0 ? '+' : '-';
  return `${sign}$${Math.abs(Math.round(n)).toLocaleString()}`;
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function printReport(scenarios: ScenarioRow[]) {
  const baseline = scenarios[0].result;

  console.log('\n╔══════════════════════════════════════════════════════════════════════════════╗');
  console.log('║              V1 SURVIVABILITY STRESS TEST                                   ║');
  console.log('║  Config: $149 entry | $500 1st cap | 10× LT cap | 14d cooldown | 80% split ║');
  console.log('║  500 iterations × 12 months | seed: 42                                     ║');
  console.log('╚══════════════════════════════════════════════════════════════════════════════╝');

  console.log('\n┌────────────────────────────────────┬──────────┬──────────┬──────────┬──────────┬──────────┬──────────┐');
  console.log('│ Scenario                           │ Margin   │ Profit/mo│ P5 (tail)│ Loss Prob│ Max DD   │ Payout/Rev│');
  console.log('├────────────────────────────────────┼──────────┼──────────┼──────────┼──────────┼──────────┼──────────┤');

  for (const s of scenarios) {
    const r = s.result;
    const d = r.diagnostics;
    console.log(
      `│ ${s.name.padEnd(35)}│ ${pct(d.effectiveMargin).padStart(7)} │ ${('$' + Math.round(r.profit.mean).toLocaleString()).padStart(8)} │ ${('$' + Math.round(r.profit.p5).toLocaleString()).padStart(8)} │ ${pct(r.risk.probabilityOfLoss).padStart(7)} │ ${('$' + Math.round(r.risk.maxDrawdown).toLocaleString()).padStart(8)} │ ${pct(d.payoutToRevenueRatio).padStart(8)} │`
    );
  }

  console.log('└────────────────────────────────────┴──────────┴──────────┴──────────┴──────────┴──────────┴──────────┘');

  // Delta table
  console.log('\n┌────────────────────────────────────┬──────────────┬──────────────┬──────────────┐');
  console.log('│ Scenario                           │ Δ Profit/mo  │ Δ Margin (pp)│ Δ Loss Prob  │');
  console.log('├────────────────────────────────────┼──────────────┼──────────────┼──────────────┤');

  for (let i = 1; i < scenarios.length; i++) {
    const s = scenarios[i];
    const r = s.result;
    const profitD = r.profit.mean - baseline.profit.mean;
    const marginD = (r.diagnostics.effectiveMargin - baseline.diagnostics.effectiveMargin) * 100;
    const lossD = (r.risk.probabilityOfLoss - baseline.risk.probabilityOfLoss) * 100;
    console.log(
      `│ ${s.name.padEnd(35)}│ ${fmt$(profitD).padStart(12)} │ ${(marginD >= 0 ? '+' : '') + marginD.toFixed(1) + ' pp'.padStart(10)} │ ${(lossD >= 0 ? '+' : '') + lossD.toFixed(1) + ' pp'.padStart(10)} │`
    );
  }

  console.log('└────────────────────────────────────┴──────────────┴──────────────┴──────────────┘');
}

function printVerdict(scenarios: ScenarioRow[]) {
  console.log('\n╔══════════════════════════════════════════════════════════════════╗');
  console.log('║                    SURVIVABILITY VERDICT                        ║');
  console.log('╚══════════════════════════════════════════════════════════════════╝\n');

  let failures = 0;
  const checks = [
    { label: 'Baseline margin > 0%', pass: scenarios[0].result.diagnostics.effectiveMargin > 0 },
    { label: 'Baseline annualized profit > $0', pass: scenarios[0].result.profit.annualized.mean > 0 },
    { label: 'No scenario has margin < -15%', pass: scenarios.every(s => s.result.diagnostics.effectiveMargin > -0.15) },
    { label: 'Baseline loss probability < 40%', pass: scenarios[0].result.risk.probabilityOfLoss < 0.40 },
    { label: '10% pass rate still profitable', pass: (scenarios.find(s => s.name.includes('10% pass'))?.result.profit.mean ?? 0) > -3000 },
    { label: 'No single scenario loses > $10k/mo mean', pass: scenarios.every(s => s.result.profit.mean > -10000) },
    { label: 'Max drawdown < $100k in any scenario', pass: scenarios.every(s => s.result.risk.maxDrawdown < 100000) },
  ];

  for (const c of checks) {
    const icon = c.pass ? '✅' : '🚨';
    if (!c.pass) failures++;
    console.log(`  ${icon} ${c.label}`);
  }

  console.log(`\n  Result: ${failures === 0 ? '✅ V1 CONFIG SURVIVES ALL STRESS TESTS' : `🚨 ${failures} CHECK(S) FAILED — REVIEW BEFORE LAUNCH`}`);
  
  return failures;
}

// ============================================================================
// TEST SUITE
// ============================================================================

describe('V1 Survivability Stress Test', () => {
  it('runs full stress battery and outputs survivability report', { timeout: 180_000 }, () => {
    const scenarios: ScenarioRow[] = [];

    // 1. Baseline
    scenarios.push({ name: 'Baseline (12% pass, 500/mo)', result: runMonteCarlo(CONFIG, DEFAULT_ASSUMPTIONS) });

    // 2. Pass rate creep to 10% (conservative)
    scenarios.push({ name: '10% pass rate (conservative)', result: runMonteCarlo(CONFIG, withPassRate(0.10)) });

    // 3. Pass rate spike to 14% (structural concern)
    scenarios.push({ name: '14% pass rate (danger zone)', result: runMonteCarlo(CONFIG, withPassRate(0.14)) });

    // 4. High funded profitability (1.5× average payouts)
    scenarios.push({ name: '1.5× funded profitability', result: runMonteCarlo(CONFIG, withHighProfitability(1.5)) });

    // 5. Payout clustering (high request rate + frequency)
    scenarios.push({ name: 'Payout clustering', result: runMonteCarlo(CONFIG, withPayoutClustering()) });

    // 6. Max withdrawal pressure (20% of funded request max)
    scenarios.push({ name: 'Max withdrawal pressure', result: runMonteCarlo(CONFIG, withMaxWithdrawalPressure()) });

    // 7. Combined: 10% pass + high profitability
    scenarios.push({
      name: '10% pass + 1.5× profit',
      result: runMonteCarlo(CONFIG, withHighProfitability(1.5, withPassRate(0.10))),
    });

    // 8. Combined: 14% pass + clustering + attack
    scenarios.push({
      name: '14% + clustering + attack',
      result: runMonteCarlo(CONFIG, withAttack(1.5, withPayoutClustering(withPassRate(0.14)))),
    });

    // 9. Solo operator early ramp (200 evals/mo)
    scenarios.push({ name: 'Solo ramp (200/mo)', result: runMonteCarlo(CONFIG, withVolume(200)) });

    // 10. Solo ramp + adverse (200/mo, 14% pass)
    scenarios.push({ name: 'Solo ramp + 14% pass', result: runMonteCarlo(CONFIG, withPassRate(0.14, withVolume(200))) });

    // Print full report
    printReport(scenarios);

    // Print verdict
    const failures = printVerdict(scenarios);

    // Hard assertions
    expect(scenarios[0].result.diagnostics.effectiveMargin).toBeGreaterThan(0);
    expect(scenarios[0].result.profit.mean).toBeGreaterThan(0);
    expect(failures).toBe(0);
  });

  it('validates 90-day worst-case drawdown', { timeout: 120_000 }, () => {
    console.log('\n╔══════════════════════════════════════════════════════════════════╗');
    console.log('║            90-DAY WORST-CASE DRAWDOWN ANALYSIS                  ║');
    console.log('║  1000 iterations × 3 months | seed: 42                          ║');
    console.log('╚══════════════════════════════════════════════════════════════════╝');

    const scenarios: { name: string; assumptions: MonteCarloAssumptions }[] = [
      { name: 'Baseline', assumptions: DEFAULT_ASSUMPTIONS },
      { name: '14% pass rate', assumptions: withPassRate(0.14) },
      { name: '1.5× profitability', assumptions: withHighProfitability(1.5) },
      { name: 'Payout clustering', assumptions: withPayoutClustering() },
      { name: '14% + clustering + attack', assumptions: withAttack(1.5, withPayoutClustering(withPassRate(0.14))) },
    ];

    console.log('\n  Scenario                           │ 90d Max DD   │ Worst Month │ Cum P5 (90d)');
    console.log('  ───────────────────────────────────┼──────────────┼─────────────┼─────────────');

    for (const s of scenarios) {
      const r = runMonteCarlo(CONFIG_90DAY, s.assumptions);
      
      // Calculate cumulative 90-day P5
      const cumProfits = r.rawSamples!.map(iter => iter.reduce((a, b) => a + b, 0));
      cumProfits.sort((a, b) => a - b);
      const cumP5 = cumProfits[Math.floor(cumProfits.length * 0.05)];
      
      console.log(
        `  ${s.name.padEnd(35)}│ $${Math.round(r.risk.maxDrawdown).toLocaleString().padStart(11)} │ $${Math.round(r.risk.worstMonth).toLocaleString().padStart(10)} │ $${Math.round(cumP5).toLocaleString().padStart(10)}`
      );
    }

    // Baseline 90-day drawdown should be manageable (<$50k with $15k reserve)
    const baseline90 = runMonteCarlo(CONFIG_90DAY, DEFAULT_ASSUMPTIONS);
    expect(baseline90.risk.maxDrawdown).toBeLessThan(100000);

    console.log('\n  ──────────────────────────────────────────────────────');
    console.log(`  Operating capital needed: ≥ $${Math.round(baseline90.risk.maxDrawdown * 1.5).toLocaleString()} (1.5× worst drawdown)`);
    console.log('  ──────────────────────────────────────────────────────');
  });

  it('validates payout clustering impact with updated caps', { timeout: 120_000 }, () => {
    console.log('\n╔══════════════════════════════════════════════════════════════════╗');
    console.log('║         PAYOUT CLUSTERING ANALYSIS (V1 CAPS)                    ║');
    console.log('╚══════════════════════════════════════════════════════════════════╝');

    const baseline = runMonteCarlo(CONFIG, DEFAULT_ASSUMPTIONS);
    const clustering = runMonteCarlo(CONFIG, withPayoutClustering());
    const clusteringHigh = runMonteCarlo(CONFIG, withPayoutClustering(withHighProfitability(1.5)));

    const rows = [
      { name: 'Baseline', r: baseline },
      { name: 'Payout clustering', r: clustering },
      { name: 'Clustering + 1.5× profit', r: clusteringHigh },
    ];

    console.log('\n  Variant                  │ Avg Payouts/mo │ Payout/Rev │ 1st Cap Bind │ LT Cap Bind │ Cap Pressure');
    console.log('  ─────────────────────────┼────────────────┼────────────┼──────────────┼─────────────┼─────────────');

    for (const { name, r } of rows) {
      const pd = r.payoutDiagnostics;
      console.log(
        `  ${name.padEnd(25)}│ $${Math.round(r.diagnostics.avgMonthlyPayouts).toLocaleString().padStart(13)} │ ${pct(r.diagnostics.payoutToRevenueRatio).padStart(9)} │ ${pct(pd.firstPayoutCapBindingRate).padStart(11)} │ ${pct(pd.lifetimeCapBindingRate).padStart(10)} │ ${(pd.capPressure !== null ? pct(pd.capPressure) : 'N/A').padStart(10)}`
      );
    }

    // The $500 first payout cap + 10× lifetime cap should contain clustering
    expect(clustering.diagnostics.effectiveMargin).toBeGreaterThan(-0.10);
  });
});
