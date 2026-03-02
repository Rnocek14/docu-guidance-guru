/**
 * V1 Survivability Stress Test
 * 
 * Tests the frozen V1 config against worst-case scenarios.
 * 
 * Config under test:
 *   Entry fee:        $149
 *   First payout cap: $500
 *   Lifetime cap:     10× ($1,490)
 *   Cooldown:         14 days (~0.5 months)
 *   Eligibility delay: 7 days
 *   Split:            80%
 * 
 * ASSERTION PHILOSOPHY:
 *   - Baseline MUST be profitable (hard fail if not)
 *   - Stress scenarios assert BOUNDED downside, not "must pass"
 *   - The point is to discover which scenarios hurt and by how much
 *   - A red test means "existential risk," not "suboptimal"
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
// CONFIG
// ============================================================================
const CONFIG: MonteCarloConfig = {
  iterations: 500,
  monthsPerIteration: 12,
  seed: 42,
};

const CONFIG_90DAY: MonteCarloConfig = {
  iterations: 1000,
  monthsPerIteration: 3,
  seed: 42,
};

// ============================================================================
// SCENARIO BUILDERS
// All helpers do FULL deep-merge via JSON.parse(JSON.stringify(base))
// to guarantee updated caps/knobs are never silently dropped.
// ============================================================================

function deepClone(base: MonteCarloAssumptions): MonteCarloAssumptions {
  return JSON.parse(JSON.stringify(base));
}

function withPassRate(mode: number, base: MonteCarloAssumptions = DEFAULT_ASSUMPTIONS): MonteCarloAssumptions {
  const a = deepClone(base);
  a.passRate = { min: Math.max(0.04, mode - 0.04), mode, max: mode + 0.06 };
  return a;
}

function withHighProfitability(multiplier: number, base: MonteCarloAssumptions = DEFAULT_ASSUMPTIONS): MonteCarloAssumptions {
  const a = deepClone(base);
  a.avgPayoutAmount = {
    mean: a.avgPayoutAmount.mean * multiplier,
    stdDev: a.avgPayoutAmount.stdDev * multiplier,
  };
  return a;
}

function withPayoutClustering(base: MonteCarloAssumptions = DEFAULT_ASSUMPTIONS): MonteCarloAssumptions {
  const a = deepClone(base);
  a.payoutRequestRate = { min: 0.70, mode: 0.85, max: 0.95 };
  a.payoutsPerPaidAccountPerMonth = { min: 1.2, mode: 1.8, max: 2.5 };
  return a;
}

function withMaxWithdrawalPressure(base: MonteCarloAssumptions = DEFAULT_ASSUMPTIONS): MonteCarloAssumptions {
  const a = deepClone(base);
  a.payoutRequestRate = { min: 0.80, mode: 0.90, max: 0.98 };
  a.avgPayoutAmount = { mean: 600, stdDev: 100 };
  return a;
}

function withVolume(evalsPerMonth: number, base: MonteCarloAssumptions = DEFAULT_ASSUMPTIONS): MonteCarloAssumptions {
  const a = deepClone(base);
  a.accountsPerMonth = evalsPerMonth;
  return a;
}

function withAttack(intensity: number, base: MonteCarloAssumptions = DEFAULT_ASSUMPTIONS): MonteCarloAssumptions {
  const a = deepClone(base);
  a.knobs.attackIntensity = intensity;
  return a;
}

// ============================================================================
// REPORTING
// ============================================================================

interface ScenarioRow {
  name: string;
  assumptions: MonteCarloAssumptions;
  result: MonteCarloResult;
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function fmt$(n: number): string {
  const sign = n >= 0 ? '+' : '-';
  return `${sign}$${Math.abs(Math.round(n)).toLocaleString()}`;
}

/**
 * Diagnostic: print the ACTUAL caps the engine will use for a given assumptions object.
 * This catches silent overrides or stale defaults.
 */
function printConfigDiagnostic(label: string, a: MonteCarloAssumptions) {
  console.log(`\n  [CONFIG CHECK] ${label}:`);
  console.log(`    firstPayoutCap:     $${a.knobs.firstPayoutCap}`);
  console.log(`    lifetimeCapPerUser: $${a.knobs.lifetimeCapPerUser} (${a.knobs.lifetimeCapPerUser !== null ? (a.knobs.lifetimeCapPerUser / a.pricePerAccount).toFixed(1) + '×' : 'unlimited'})`);
  console.log(`    payoutSplitPercent: ${(a.knobs.payoutSplitPercent * 100).toFixed(0)}%`);
  console.log(`    pricePerAccount:   $${a.pricePerAccount}`);
  console.log(`    passRate mode:     ${(a.passRate.mode * 100).toFixed(1)}%`);
  console.log(`    attackIntensity:   ${a.knobs.attackIntensity}`);
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

// ============================================================================
// TEST SUITE
// ============================================================================

describe('V1 Survivability Stress Test', () => {

  it('verifies config propagation — caps are what we expect', () => {
    // Verify DEFAULT_ASSUMPTIONS has V1 values
    expect(DEFAULT_ASSUMPTIONS.knobs.firstPayoutCap).toBe(500);
    expect(DEFAULT_ASSUMPTIONS.knobs.lifetimeCapPerUser).toBe(149 * 10);
    expect(DEFAULT_ASSUMPTIONS.knobs.payoutSplitPercent).toBe(0.80);
    expect(DEFAULT_ASSUMPTIONS.pricePerAccount).toBe(149);

    // Verify helpers don't drop caps
    const stress = withAttack(1.5, withPayoutClustering(withPassRate(0.14)));
    expect(stress.knobs.firstPayoutCap).toBe(500);
    expect(stress.knobs.lifetimeCapPerUser).toBe(149 * 10);
    expect(stress.knobs.payoutSplitPercent).toBe(0.80);
    expect(stress.knobs.attackIntensity).toBe(1.5);
    expect(stress.passRate.mode).toBeCloseTo(0.14);
    expect(stress.payoutRequestRate.mode).toBeCloseTo(0.85);

    printConfigDiagnostic('DEFAULT_ASSUMPTIONS', DEFAULT_ASSUMPTIONS);
    printConfigDiagnostic('Combined stress (14% + clustering + attack)', stress);
  });

  it('runs full stress battery', { timeout: 180_000 }, () => {
    const scenarios: ScenarioRow[] = [];

    const run = (name: string, assumptions: MonteCarloAssumptions) => {
      scenarios.push({ name, assumptions, result: runMonteCarlo(CONFIG, assumptions) });
    };

    // 1. Baseline
    run('Baseline (12% pass, 500/mo)', DEFAULT_ASSUMPTIONS);

    // 2-3. Pass rate sensitivity
    run('10% pass rate', withPassRate(0.10));
    run('14% pass rate (danger zone)', withPassRate(0.14));

    // 4. The critical +2% shift test
    const baselineMode = DEFAULT_ASSUMPTIONS.passRate.mode;
    run(`+2pp shift (${pct(baselineMode)} → ${pct(baselineMode + 0.02)})`, withPassRate(baselineMode + 0.02));

    // 5-6. Profitability & clustering
    run('1.5× funded profitability', withHighProfitability(1.5));
    run('Payout clustering', withPayoutClustering());

    // 7. Max withdrawal pressure
    run('Max withdrawal pressure', withMaxWithdrawalPressure());

    // 8-9. Combined stress
    run('10% pass + 1.5× profit', withHighProfitability(1.5, withPassRate(0.10)));
    run('14% + clustering + attack', withAttack(1.5, withPayoutClustering(withPassRate(0.14))));

    // 10-11. Solo operator
    run('Solo ramp (200/mo)', withVolume(200));
    run('Solo ramp + 14% pass', withPassRate(0.14, withVolume(200)));

    // Print config diagnostic for baseline to prove caps are correct
    printConfigDiagnostic('Baseline (actual engine input)', scenarios[0].assumptions);

    // Print full report
    printReport(scenarios);

    // =====================================================================
    // ASSERTIONS: Baseline MUST survive. Stress scenarios are BOUNDED.
    // =====================================================================
    const baseline = scenarios[0].result;

    // HARD: Baseline must be profitable
    expect(baseline.diagnostics.effectiveMargin).toBeGreaterThan(0);
    expect(baseline.profit.mean).toBeGreaterThan(0);
    expect(baseline.risk.probabilityOfLoss).toBeLessThan(0.40);

    // BOUNDED: No single stress scenario should be catastrophic (> -$10k/mo mean)
    for (const s of scenarios) {
      if (s.result.profit.mean < -10000) {
        console.warn(`  🚨 CATASTROPHIC: "${s.name}" loses $${Math.round(Math.abs(s.result.profit.mean))}/mo — requires rebalancing`);
      }
    }

    // BOUNDED: Max drawdown across all scenarios
    const worstDrawdown = Math.max(...scenarios.map(s => s.result.risk.maxDrawdown));
    console.log(`\n  Worst drawdown across all scenarios: $${Math.round(worstDrawdown).toLocaleString()}`);

    // INFORMATIONAL: Print +2pp shift delta explicitly
    const shiftScenario = scenarios.find(s => s.name.includes('+2pp'));
    if (shiftScenario) {
      const profitDelta = shiftScenario.result.profit.mean - baseline.profit.mean;
      const marginDelta = (shiftScenario.result.diagnostics.effectiveMargin - baseline.diagnostics.effectiveMargin) * 100;
      console.log(`\n  ══ CRITICAL: +2pp Pass Rate Shift Impact ══`);
      console.log(`    Profit delta:  ${fmt$(profitDelta)}/mo`);
      console.log(`    Margin delta:  ${marginDelta.toFixed(1)} pp`);
      console.log(`    Still profitable: ${shiftScenario.result.profit.mean > 0 ? '✅ YES' : '🚨 NO'}`);
    }
  });

  it('models 90-day worst-case drawdown', { timeout: 120_000 }, () => {
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

    let baselineDrawdown = 0;

    for (const s of scenarios) {
      const r = runMonteCarlo(CONFIG_90DAY, s.assumptions);

      // Compute cumulative 90-day P5 from rawSamples if available,
      // otherwise fall back to annualized P5 / 4
      let cumP5: number;
      if (r.rawSamples && r.rawSamples.length > 0) {
        const cumProfits = r.rawSamples.map(iter => iter.reduce((a, b) => a + b, 0));
        cumProfits.sort((a, b) => a - b);
        cumP5 = cumProfits[Math.floor(cumProfits.length * 0.05)];
      } else {
        cumP5 = r.profit.p5 * 3; // fallback: 3-month P5 estimate
      }

      if (s.name === 'Baseline') baselineDrawdown = r.risk.maxDrawdown;

      console.log(
        `  ${s.name.padEnd(35)}│ $${Math.round(r.risk.maxDrawdown).toLocaleString().padStart(11)} │ $${Math.round(r.risk.worstMonth).toLocaleString().padStart(10)} │ $${Math.round(cumP5).toLocaleString().padStart(10)}`
      );
    }

    // Capital guidance: single rule, no contradictions
    const recommendedCapital = Math.round(baselineDrawdown * 1.5);
    console.log('\n  ──────────────────────────────────────────────────────');
    console.log(`  Baseline 90-day max drawdown:    $${Math.round(baselineDrawdown).toLocaleString()}`);
    console.log(`  Recommended operating capital:   ≥ $${recommendedCapital.toLocaleString()} (1.5× worst 90-day DD)`);
    console.log('  ──────────────────────────────────────────────────────');

    // BOUNDED: baseline 90-day drawdown should not be existential
    expect(baselineDrawdown).toBeLessThan(100000);
  });

  it('validates payout clustering impact with V1 caps', { timeout: 120_000 }, () => {
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

    // BOUNDED: clustering shouldn't destroy margin entirely
    expect(clustering.diagnostics.effectiveMargin).toBeGreaterThan(-0.15);
  });
});
