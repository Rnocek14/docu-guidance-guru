/**
 * Pass-Rate Sensitivity Analysis: Development Layer Stress Test
 * 
 * Models the economic impact of a +2% pass rate shift (12% → 14% mode)
 * that could result from implementing a Trader Development Layer.
 * 
 * Key question: Does a modest improvement in trader discipline
 * destroy economics, or is it net-positive?
 */

import { describe, it, expect } from 'vitest';
import {
  runMonteCarlo,
  DEFAULT_ASSUMPTIONS,
  SCENARIO_PRESETS,
  type MonteCarloAssumptions,
  type MonteCarloConfig,
  type MonteCarloResult,
} from './monte-carlo';

const CONFIG: MonteCarloConfig = {
  iterations: 500,
  monthsPerIteration: 12,
  seed: 42,
};

// Scenario: +2% pass rate shift (discipline coaching effect)
const DEVELOPMENT_LAYER_ASSUMPTIONS: MonteCarloAssumptions = {
  ...DEFAULT_ASSUMPTIONS,
  // Pass rate shifts up by ~2 percentage points
  passRate: { min: 0.10, mode: 0.14, max: 0.20 },
  // Chargebacks drop ~20% (better rule comprehension)
  chargebackRate: { min: 0.012, mode: 0.020, max: 0.032 },
  // Fraud attempt rate drops slightly (payout gate friction)
  fraudAttemptRate: { min: 0.03, mode: 0.06, max: 0.10 },
};

// Dangerous scenario: What if pass rate jumps too high (15%+ mode)?
const OVERSHOOT_ASSUMPTIONS: MonteCarloAssumptions = {
  ...DEFAULT_ASSUMPTIONS,
  passRate: { min: 0.12, mode: 0.17, max: 0.24 },
  chargebackRate: { min: 0.010, mode: 0.018, max: 0.028 },
};

// Development layer + coordinated attack
const DEV_LAYER_ATTACK: MonteCarloAssumptions = {
  ...DEVELOPMENT_LAYER_ASSUMPTIONS,
  knobs: {
    ...DEVELOPMENT_LAYER_ASSUMPTIONS.knobs,
    attackIntensity: 2,
  },
};

function fmt(n: number): string {
  return n >= 0 ? `+$${n.toLocaleString()}` : `-$${Math.abs(n).toLocaleString()}`;
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function summarize(label: string, r: MonteCarloResult) {
  console.log(`\n── ${label} ──`);
  console.log(`  Mean monthly profit:  $${Math.round(r.profit.mean).toLocaleString()}`);
  console.log(`  P5 (worst 5%):        $${Math.round(r.profit.p5).toLocaleString()}`);
  console.log(`  P95 (best 5%):        $${Math.round(r.profit.p95).toLocaleString()}`);
  console.log(`  Loss probability:     ${pct(r.risk.probabilityOfLoss)}`);
  console.log(`  Max drawdown:         $${Math.round(r.risk.maxDrawdown).toLocaleString()}`);
  console.log(`  Effective margin:     ${pct(r.diagnostics.effectiveMargin)}`);
  console.log(`  Payout/Revenue ratio: ${pct(r.diagnostics.payoutToRevenueRatio)}`);
  console.log(`  Avg monthly payouts:  $${Math.round(r.diagnostics.avgMonthlyPayouts).toLocaleString()}`);
  console.log(`  Avg monthly revenue:  $${Math.round(r.diagnostics.avgMonthlyRevenue).toLocaleString()}`);
  console.log(`  Avg monthly CBs:      $${Math.round(r.diagnostics.avgMonthlyChargebacks).toLocaleString()}`);
}

function delta(label: string, baseline: MonteCarloResult, scenario: MonteCarloResult) {
  const profitDelta = scenario.profit.mean - baseline.profit.mean;
  const marginDelta = scenario.diagnostics.effectiveMargin - baseline.diagnostics.effectiveMargin;
  const lossDelta = scenario.risk.probabilityOfLoss - baseline.risk.probabilityOfLoss;
  const payoutDelta = scenario.diagnostics.avgMonthlyPayouts - baseline.diagnostics.avgMonthlyPayouts;
  const cbDelta = scenario.diagnostics.avgMonthlyChargebacks - baseline.diagnostics.avgMonthlyChargebacks;
  
  console.log(`\n── DELTA: ${label} ──`);
  console.log(`  Profit change:        ${fmt(Math.round(profitDelta))}/mo`);
  console.log(`  Margin change:        ${(marginDelta * 100).toFixed(1)} pp`);
  console.log(`  Loss prob change:     ${(lossDelta * 100).toFixed(1)} pp`);
  console.log(`  Payout change:        ${fmt(Math.round(payoutDelta))}/mo`);
  console.log(`  Chargeback change:    ${fmt(Math.round(cbDelta))}/mo`);
  
  return { profitDelta, marginDelta, lossDelta, payoutDelta, cbDelta };
}

describe('Pass-Rate Sensitivity: Development Layer', () => {
  it('compares baseline vs +2% pass rate shift', () => {
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('    PASS-RATE SENSITIVITY: DEVELOPMENT LAYER STRESS TEST');
    console.log('    500 iterations × 12 months | seed: 42');
    console.log('═══════════════════════════════════════════════════════════════');
    
    const baseline = runMonteCarlo(CONFIG, DEFAULT_ASSUMPTIONS);
    const devLayer = runMonteCarlo(CONFIG, DEVELOPMENT_LAYER_ASSUMPTIONS);
    const overshoot = runMonteCarlo(CONFIG, OVERSHOOT_ASSUMPTIONS);
    const baselineAttack = runMonteCarlo(CONFIG, SCENARIO_PRESETS.coordinatedAttack);
    const devLayerAttack = runMonteCarlo(CONFIG, DEV_LAYER_ATTACK);
    
    // Print full comparison
    summarize('BASELINE (12% mode pass rate)', baseline);
    summarize('DEV LAYER (+2% → 14% mode, -20% CBs)', devLayer);
    summarize('OVERSHOOT (17% mode — DANGER ZONE)', overshoot);
    summarize('BASELINE + ATTACK', baselineAttack);
    summarize('DEV LAYER + ATTACK', devLayerAttack);
    
    const d1 = delta('Baseline → Dev Layer', baseline, devLayer);
    const d2 = delta('Baseline → Overshoot', baseline, overshoot);
    const d3 = delta('Attack: Baseline → Dev Layer', baselineAttack, devLayerAttack);
    
    // Economic verdict
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('    ECONOMIC VERDICT');
    console.log('═══════════════════════════════════════════════════════════════');
    
    const netImpact = d1.profitDelta + Math.abs(d1.cbDelta); // CB savings partially offset payout increase
    console.log(`\n  Net monthly impact (profit Δ + CB savings): ${fmt(Math.round(netImpact))}`);
    
    if (d1.marginDelta > -0.05) {
      console.log('  ✅ Margin erosion < 5pp — SAFE to proceed with Development Layer');
    } else if (d1.marginDelta > -0.10) {
      console.log('  ⚠️  Margin erosion 5-10pp — Proceed with tighter caps');
    } else {
      console.log('  🚨 Margin erosion > 10pp — DO NOT proceed without rebalancing');
    }
    
    if (d2.marginDelta < -0.10) {
      console.log('  🚨 OVERSHOOT WARNING: 17% pass rate destroys margin — monitor closely');
    }
    
    // The test passes as long as margin doesn't completely collapse
    expect(devLayer.diagnostics.effectiveMargin).toBeGreaterThan(0);
    expect(devLayer.profit.mean).toBeGreaterThan(-5000); // not catastrophic
  });
});
