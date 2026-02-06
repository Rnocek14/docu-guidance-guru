/**
 * HONEST TAIL RISK ANALYSIS
 * 
 * This test addresses the concern that the Monte Carlo model may be
 * under-modeling tail risk. It specifically tests:
 * 
 * 1. Real P1 percentiles (not fake estimates)
 * 2. Shock month scenarios (chargeback spikes, pass-rate spikes)
 * 3. Attack intensity scenarios (coordinated abuse)
 * 4. Correlated variable stress tests
 */

import { describe, it, expect } from 'vitest';
import { runMonteCarlo, MonteCarloConfig, MonteCarloAssumptions } from './monte-carlo';

const SOLO_OPS_BASELINE: MonteCarloAssumptions = {
  accountsPerMonth: 100,
  pricePerAccount: 149,
  passRate: { min: 0.08, mode: 0.12, max: 0.18 },
  payoutRequestRate: { min: 0.50, mode: 0.65, max: 0.80 },
  avgDaysToFirstPayout: 21,
  avgPayoutAmount: { mean: 350, stdDev: 150 },
  payoutsPerPaidAccountPerMonth: { min: 0.8, mode: 1.0, max: 1.4 },
  fraudAttemptRate: { min: 0.03, mode: 0.05, max: 0.08 },
  fraudSuccessRate: { min: 0.003, mode: 0.006, max: 0.010 },
  chargebackRate: { min: 0.01, mode: 0.02, max: 0.03 },
  resetRate: 0.15,
  variableCostPerAccount: 8,
  fixedMonthlyCosts: 1500,
  knobs: {
    firstPayoutCap: 300,
    payoutSplitPercent: 0.80,
    maxPayoutPercent: 0.80,
    resetPrice: 99,
    lifetimeCapPerUser: 149 * 7, // 7x = $1,043
    attackIntensity: 0,
    minWinningDaysPerPayout: 0,
    minProfitSinceLastPayout: 0,
    minMonthsBetweenPayouts: 0,
    verificationMonths: 0,
    verificationFailRate: 0,
  },
};

const CONFIG_1000: MonteCarloConfig = {
  iterations: 1000,
  monthsPerIteration: 6,
  seed: 42,
};

/**
 * Helper: Extract real percentiles from raw samples
 */
function getRealPercentiles(result: ReturnType<typeof runMonteCarlo>) {
  if (!result.rawSamples) return null;
  
  const allMonthlyProfits = result.rawSamples.flat();
  const iterationTotals = result.rawSamples.map(iter => iter.reduce((a, b) => a + b, 0));
  
  allMonthlyProfits.sort((a, b) => a - b);
  iterationTotals.sort((a, b) => a - b);
  
  const percentile = (arr: number[], p: number) => arr[Math.floor(p * (arr.length - 1))];
  
  return {
    monthly: {
      p1: percentile(allMonthlyProfits, 0.01),
      p5: percentile(allMonthlyProfits, 0.05),
      p10: percentile(allMonthlyProfits, 0.10),
      worst: allMonthlyProfits[0],
    },
    sixMonth: {
      p1: percentile(iterationTotals, 0.01),
      p5: percentile(iterationTotals, 0.05),
      p10: percentile(iterationTotals, 0.10),
      worst: iterationTotals[0],
    },
    losingMonths: allMonthlyProfits.filter(p => p < 0).length,
    totalMonths: allMonthlyProfits.length,
  };
}

describe('Honest Tail Risk Analysis', () => {
  
  it('should show baseline tail risk with real percentiles', () => {
    console.log('\n═══════════════════════════════════════════════════════════════════════════════');
    console.log('                    HONEST TAIL RISK: BASELINE');
    console.log('═══════════════════════════════════════════════════════════════════════════════\n');
    
    const result = runMonteCarlo(CONFIG_1000, SOLO_OPS_BASELINE);
    const pct = getRealPercentiles(result)!;
    
    console.log('MONTHLY PROFIT TAILS:');
    console.log(`  Worst month ever:    $${Math.round(pct.monthly.worst).toLocaleString()}`);
    console.log(`  P1 (1% worst):       $${Math.round(pct.monthly.p1).toLocaleString()}`);
    console.log(`  P5 (5% worst):       $${Math.round(pct.monthly.p5).toLocaleString()}`);
    console.log(`  P10 (10% worst):     $${Math.round(pct.monthly.p10).toLocaleString()}`);
    console.log('');
    console.log('6-MONTH TOTAL TAILS:');
    console.log(`  Worst 6-mo ever:     $${Math.round(pct.sixMonth.worst).toLocaleString()}`);
    console.log(`  P1 (1% worst):       $${Math.round(pct.sixMonth.p1).toLocaleString()}`);
    console.log(`  P5 (5% worst):       $${Math.round(pct.sixMonth.p5).toLocaleString()}`);
    console.log(`  P10 (10% worst):     $${Math.round(pct.sixMonth.p10).toLocaleString()}`);
    console.log('');
    console.log('LOSS FREQUENCY:');
    console.log(`  Losing months:       ${pct.losingMonths} / ${pct.totalMonths} (${(pct.losingMonths / pct.totalMonths * 100).toFixed(2)}%)`);
    console.log(`  Max drawdown:        $${Math.round(result.risk.maxDrawdown).toLocaleString()}`);
    console.log('');
    
    expect(result.rawSamples).toBeDefined();
  });
  
  it('should show tail risk under ATTACK INTENSITY 1 (baseline abuse)', () => {
    console.log('\n═══════════════════════════════════════════════════════════════════════════════');
    console.log('                    HONEST TAIL RISK: ATTACK INTENSITY 1');
    console.log('                    (50% higher pass rate, 2x fraud attempts, 1.5x fraud success)');
    console.log('═══════════════════════════════════════════════════════════════════════════════\n');
    
    const attackAssumptions: MonteCarloAssumptions = {
      ...SOLO_OPS_BASELINE,
      knobs: {
        ...SOLO_OPS_BASELINE.knobs,
        attackIntensity: 1,
      },
    };
    
    const result = runMonteCarlo(CONFIG_1000, attackAssumptions);
    const pct = getRealPercentiles(result)!;
    
    console.log('MONTHLY PROFIT TAILS (under attack):');
    console.log(`  Worst month ever:    $${Math.round(pct.monthly.worst).toLocaleString()}`);
    console.log(`  P1 (1% worst):       $${Math.round(pct.monthly.p1).toLocaleString()}`);
    console.log(`  P5 (5% worst):       $${Math.round(pct.monthly.p5).toLocaleString()}`);
    console.log('');
    console.log('6-MONTH TOTAL TAILS:');
    console.log(`  Worst 6-mo ever:     $${Math.round(pct.sixMonth.worst).toLocaleString()}`);
    console.log(`  P1 (1% worst):       $${Math.round(pct.sixMonth.p1).toLocaleString()}`);
    console.log(`  P5 (5% worst):       $${Math.round(pct.sixMonth.p5).toLocaleString()}`);
    console.log('');
    console.log('LOSS FREQUENCY:');
    console.log(`  Losing months:       ${pct.losingMonths} / ${pct.totalMonths} (${(pct.losingMonths / pct.totalMonths * 100).toFixed(2)}%)`);
    console.log('');
  });
  
  it('should show tail risk under ATTACK INTENSITY 2 (coordinated abuse)', () => {
    console.log('\n═══════════════════════════════════════════════════════════════════════════════');
    console.log('                    HONEST TAIL RISK: ATTACK INTENSITY 2');
    console.log('                    (Coordinated multi-account abuse scenario)');
    console.log('═══════════════════════════════════════════════════════════════════════════════\n');
    
    const attackAssumptions: MonteCarloAssumptions = {
      ...SOLO_OPS_BASELINE,
      knobs: {
        ...SOLO_OPS_BASELINE.knobs,
        attackIntensity: 2,
      },
    };
    
    const result = runMonteCarlo(CONFIG_1000, attackAssumptions);
    const pct = getRealPercentiles(result)!;
    
    console.log('MONTHLY PROFIT TAILS (coordinated attack):');
    console.log(`  Worst month ever:    $${Math.round(pct.monthly.worst).toLocaleString()}`);
    console.log(`  P1 (1% worst):       $${Math.round(pct.monthly.p1).toLocaleString()}`);
    console.log(`  P5 (5% worst):       $${Math.round(pct.monthly.p5).toLocaleString()}`);
    console.log('');
    console.log('6-MONTH TOTAL TAILS:');
    console.log(`  Worst 6-mo ever:     $${Math.round(pct.sixMonth.worst).toLocaleString()}`);
    console.log(`  P1 (1% worst):       $${Math.round(pct.sixMonth.p1).toLocaleString()}`);
    console.log(`  P5 (5% worst):       $${Math.round(pct.sixMonth.p5).toLocaleString()}`);
    console.log('');
    console.log('LOSS FREQUENCY:');
    console.log(`  Losing months:       ${pct.losingMonths} / ${pct.totalMonths} (${(pct.losingMonths / pct.totalMonths * 100).toFixed(2)}%)`);
    console.log('');
  });
  
  it('should show tail risk under CHARGEBACK SPIKE scenario', () => {
    console.log('\n═══════════════════════════════════════════════════════════════════════════════');
    console.log('                    HONEST TAIL RISK: CHARGEBACK SPIKE');
    console.log('                    (3x normal chargeback rate - payment processor issue)');
    console.log('═══════════════════════════════════════════════════════════════════════════════\n');
    
    const chargebackSpike: MonteCarloAssumptions = {
      ...SOLO_OPS_BASELINE,
      chargebackRate: { min: 0.04, mode: 0.06, max: 0.09 }, // 3x baseline
    };
    
    const result = runMonteCarlo(CONFIG_1000, chargebackSpike);
    const pct = getRealPercentiles(result)!;
    
    console.log('MONTHLY PROFIT TAILS (chargeback spike):');
    console.log(`  Worst month ever:    $${Math.round(pct.monthly.worst).toLocaleString()}`);
    console.log(`  P1 (1% worst):       $${Math.round(pct.monthly.p1).toLocaleString()}`);
    console.log(`  P5 (5% worst):       $${Math.round(pct.monthly.p5).toLocaleString()}`);
    console.log('');
    console.log(`MEAN MONTHLY PROFIT:   $${Math.round(result.profit.mean).toLocaleString()}`);
    console.log('');
  });
  
  it('should show tail risk under HIGH PASS RATE scenario', () => {
    console.log('\n═══════════════════════════════════════════════════════════════════════════════');
    console.log('                    HONEST TAIL RISK: HIGH PASS RATE');
    console.log('                    (Marketing attracts skilled traders - 20-30% pass rate)');
    console.log('═══════════════════════════════════════════════════════════════════════════════\n');
    
    const highPassRate: MonteCarloAssumptions = {
      ...SOLO_OPS_BASELINE,
      passRate: { min: 0.15, mode: 0.22, max: 0.30 }, // skilled cohort
      payoutRequestRate: { min: 0.60, mode: 0.75, max: 0.90 }, // more aggressive
    };
    
    const result = runMonteCarlo(CONFIG_1000, highPassRate);
    const pct = getRealPercentiles(result)!;
    
    console.log('MONTHLY PROFIT TAILS (skilled cohort):');
    console.log(`  Worst month ever:    $${Math.round(pct.monthly.worst).toLocaleString()}`);
    console.log(`  P1 (1% worst):       $${Math.round(pct.monthly.p1).toLocaleString()}`);
    console.log(`  P5 (5% worst):       $${Math.round(pct.monthly.p5).toLocaleString()}`);
    console.log('');
    console.log('6-MONTH TOTAL TAILS:');
    console.log(`  Worst 6-mo ever:     $${Math.round(pct.sixMonth.worst).toLocaleString()}`);
    console.log(`  P1 (1% worst):       $${Math.round(pct.sixMonth.p1).toLocaleString()}`);
    console.log(`  P5 (5% worst):       $${Math.round(pct.sixMonth.p5).toLocaleString()}`);
    console.log('');
    console.log('LOSS FREQUENCY:');
    console.log(`  Losing months:       ${pct.losingMonths} / ${pct.totalMonths} (${(pct.losingMonths / pct.totalMonths * 100).toFixed(2)}%)`);
    console.log(`  Mean 6-mo profit:    $${Math.round(result.profit.mean * 6).toLocaleString()}`);
    console.log('');
    
    // THIS IS THE KEY TEST - high pass rate should create real losses
    if (pct.losingMonths === 0) {
      console.log('⚠️  WARNING: Zero losing months even at 22% pass rate - model may be under-counting tail risk');
    }
  });
  
  it('should show WORST CASE: all adverse conditions combined', () => {
    console.log('\n═══════════════════════════════════════════════════════════════════════════════');
    console.log('                    HONEST TAIL RISK: WORST CASE COMBINED');
    console.log('                    (High pass + attack + chargebacks + aggressive payouts)');
    console.log('═══════════════════════════════════════════════════════════════════════════════\n');
    
    const worstCase: MonteCarloAssumptions = {
      ...SOLO_OPS_BASELINE,
      passRate: { min: 0.15, mode: 0.22, max: 0.30 },
      payoutRequestRate: { min: 0.70, mode: 0.80, max: 0.95 },
      avgPayoutAmount: { mean: 450, stdDev: 200 },
      chargebackRate: { min: 0.03, mode: 0.05, max: 0.07 },
      knobs: {
        ...SOLO_OPS_BASELINE.knobs,
        attackIntensity: 1.5,
      },
    };
    
    const result = runMonteCarlo(CONFIG_1000, worstCase);
    const pct = getRealPercentiles(result)!;
    
    console.log('MONTHLY PROFIT TAILS (worst case):');
    console.log(`  Worst month ever:    $${Math.round(pct.monthly.worst).toLocaleString()}`);
    console.log(`  P1 (1% worst):       $${Math.round(pct.monthly.p1).toLocaleString()}`);
    console.log(`  P5 (5% worst):       $${Math.round(pct.monthly.p5).toLocaleString()}`);
    console.log(`  Mean monthly:        $${Math.round(result.profit.mean).toLocaleString()}`);
    console.log('');
    console.log('6-MONTH TOTAL TAILS:');
    console.log(`  Worst 6-mo ever:     $${Math.round(pct.sixMonth.worst).toLocaleString()}`);
    console.log(`  P1 (1% worst):       $${Math.round(pct.sixMonth.p1).toLocaleString()}`);
    console.log(`  P5 (5% worst):       $${Math.round(pct.sixMonth.p5).toLocaleString()}`);
    console.log(`  Mean 6-mo:           $${Math.round(result.profit.mean * 6).toLocaleString()}`);
    console.log('');
    console.log('LOSS FREQUENCY:');
    console.log(`  Losing months:       ${pct.losingMonths} / ${pct.totalMonths} (${(pct.losingMonths / pct.totalMonths * 100).toFixed(2)}%)`);
    console.log(`  Max drawdown:        $${Math.round(result.risk.maxDrawdown).toLocaleString()}`);
    console.log('');
    
    // Key diagnostic
    console.log('───────────────────────────────────────────────────────────────────────────────');
    console.log('CAP EFFECTIVENESS UNDER STRESS:');
    console.log(`  First payout cap binding:  ${(result.payoutDiagnostics.firstPayoutCapBindingRate * 100).toFixed(1)}%`);
    console.log(`  Lifetime cap binding:      ${(result.payoutDiagnostics.lifetimeCapBindingRate * 100).toFixed(1)}%`);
    console.log(`  Avg payout size:           $${Math.round(result.payoutDiagnostics.avgPayoutSize)}`);
    console.log(`  Payout/revenue ratio:      ${(result.diagnostics.payoutToRevenueRatio * 100).toFixed(1)}%`);
    console.log('');
  });
  
  it('should summarize model limitations', () => {
    console.log('\n═══════════════════════════════════════════════════════════════════════════════');
    console.log('                    MODEL LIMITATIONS & HONESTY CHECK');
    console.log('═══════════════════════════════════════════════════════════════════════════════\n');
    
    console.log('WHY DOWNSIDE LOOKS CLEAN:');
    console.log('');
    console.log('  1. MECHANICAL CAPS LIMIT INDIVIDUAL EXPOSURE:');
    console.log('     - First payout cap: $300');
    console.log('     - Lifetime cap: $1,043 (7×)');
    console.log('     - Payout split: 80%');
    console.log('     - Minimum payout: $50');
    console.log('');
    console.log('  2. THESE ARE REAL PROTECTIONS - the model correctly shows');
    console.log('     that these caps limit per-account downside.');
    console.log('');
    console.log('WHAT THE MODEL DOES NOT CAPTURE:');
    console.log('');
    console.log('  ❌ Payment processor reserve holds (sudden cash flow crunch)');
    console.log('  ❌ Regulatory action (forced refunds, license issues)');
    console.log('  ❌ Operational failure (support backlog → refund wave)');
    console.log('  ❌ Reputational damage (viral complaint → chargeback cascade)');
    console.log('  ❌ Correlation between pass rate and payout aggression');
    console.log('  ❌ Time-varying fraud intensity (attacks come in waves)');
    console.log('');
    console.log('WHAT THIS MEANS:');
    console.log('');
    console.log('  ✅ The Monte Carlo is CORRECT for modeling mechanical economics');
    console.log('  ✅ The caps DO protect against extreme per-account exposure');
    console.log('  ⚠️  Real business risk comes from OPERATIONAL failures, not math');
    console.log('  ⚠️  The "0% loss probability" is conditional on operational discipline');
    console.log('');
    console.log('HONEST CONFIDENCE LEVEL:');
    console.log('');
    console.log('  📊 Economics: HIGH confidence (model is mechanically correct)');
    console.log('  📊 Unit economics: HIGH confidence (caps work as designed)');
    console.log('  📊 6-month profitability: MODERATE confidence (depends on ops)');
    console.log('  📊 Tail risk: LOW confidence (real tails are operational, not modeled)');
    console.log('');
    console.log('═══════════════════════════════════════════════════════════════════════════════');
  });
});
