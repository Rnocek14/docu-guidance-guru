/**
 * Deep-dive risk analysis - extracting full probability distributions
 */

import { describe, it, expect } from 'vitest';
import { runMonteCarlo, MonteCarloConfig, MonteCarloAssumptions } from './monte-carlo';

const SOLO_OPS_ASSUMPTIONS: MonteCarloAssumptions = {
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
    lifetimeCapPerUser: 149 * 7,
    attackIntensity: 0,
  },
};

const CONFIG_1000_ITERATIONS: MonteCarloConfig = {
  iterations: 1000,
  monthsPerIteration: 6,
  seed: 42,
};

describe('Deep Risk Analysis - 6 Month Solo Ops', () => {
  it('should compute full probability distribution', () => {
    console.log('\n🔬 RUNNING 1,000 ITERATION DEEP ANALYSIS...\n');
    
    const result = runMonteCarlo(CONFIG_1000_ITERATIONS, SOLO_OPS_ASSUMPTIONS);
    
    // Extract raw samples for custom percentile analysis
    const allMonthlyProfits: number[] = [];
    const iterationTotals: number[] = [];
    
    if (result.rawSamples) {
      for (const iteration of result.rawSamples) {
        let iterTotal = 0;
        for (const monthProfit of iteration) {
          allMonthlyProfits.push(monthProfit);
          iterTotal += monthProfit;
        }
        iterationTotals.push(iterTotal);
      }
    }
    
    // Sort for percentile calculations
    allMonthlyProfits.sort((a, b) => a - b);
    iterationTotals.sort((a, b) => a - b);
    
    const percentile = (arr: number[], p: number) => arr[Math.floor(p * (arr.length - 1))];
    
    // === MONTHLY PROFIT DISTRIBUTION ===
    const monthlyP1 = percentile(allMonthlyProfits, 0.01);
    const monthlyP5 = percentile(allMonthlyProfits, 0.05);
    const monthlyP10 = percentile(allMonthlyProfits, 0.10);
    const monthlyP25 = percentile(allMonthlyProfits, 0.25);
    const monthlyP50 = percentile(allMonthlyProfits, 0.50);
    const monthlyP75 = percentile(allMonthlyProfits, 0.75);
    const monthlyP90 = percentile(allMonthlyProfits, 0.90);
    const monthlyP95 = percentile(allMonthlyProfits, 0.95);
    const monthlyP99 = percentile(allMonthlyProfits, 0.99);
    
    // === 6-MONTH TOTAL DISTRIBUTION ===
    const totalP1 = percentile(iterationTotals, 0.01);
    const totalP5 = percentile(iterationTotals, 0.05);
    const totalP10 = percentile(iterationTotals, 0.10);
    const totalP25 = percentile(iterationTotals, 0.25);
    const totalP50 = percentile(iterationTotals, 0.50);
    const totalP75 = percentile(iterationTotals, 0.75);
    const totalP90 = percentile(iterationTotals, 0.90);
    const totalP95 = percentile(iterationTotals, 0.95);
    const totalP99 = percentile(iterationTotals, 0.99);
    
    // === LOSS PROBABILITY ANALYSIS ===
    const losingMonths = allMonthlyProfits.filter(p => p < 0).length;
    const losingIterations = iterationTotals.filter(t => t < 0).length;
    const breakEvenIterations = iterationTotals.filter(t => t >= 0 && t < 10000).length;
    
    // === EXTREME SCENARIOS ===
    const worstMonth = allMonthlyProfits[0];
    const bestMonth = allMonthlyProfits[allMonthlyProfits.length - 1];
    const worst6Mo = iterationTotals[0];
    const best6Mo = iterationTotals[iterationTotals.length - 1];
    
    // === CONSECUTIVE LOSS ANALYSIS ===
    let maxConsecutiveLosses = 0;
    if (result.rawSamples) {
      for (const iteration of result.rawSamples) {
        let currentStreak = 0;
        for (const monthProfit of iteration) {
          if (monthProfit < 0) {
            currentStreak++;
            maxConsecutiveLosses = Math.max(maxConsecutiveLosses, currentStreak);
          } else {
            currentStreak = 0;
          }
        }
      }
    }
    
    // === PRINT COMPREHENSIVE REPORT ===
    console.log('═══════════════════════════════════════════════════════════════════════════════');
    console.log('                    COMPREHENSIVE 6-MONTH RISK ANALYSIS');
    console.log('                    1,000 Iterations × 6 Months = 6,000 Month Samples');
    console.log('═══════════════════════════════════════════════════════════════════════════════');
    console.log('');
    console.log('ASSUMPTIONS:');
    console.log(`  New accounts/month:     100 @ $149`);
    console.log(`  Fixed costs/month:      $1,500 (solo ops)`);
    console.log(`  Pass rate:              8-18% (mode 12%)`);
    console.log(`  First payout cap:       $300`);
    console.log(`  Lifetime cap:           $1,043 (7×)`);
    console.log('');
    
    console.log('───────────────────────────────────────────────────────────────────────────────');
    console.log('                         MONTHLY PROFIT DISTRIBUTION');
    console.log('───────────────────────────────────────────────────────────────────────────────');
    console.log('');
    console.log(`  Worst-case (P1):     $${Math.round(monthlyP1).toLocaleString()}`);
    console.log(`  Very bad (P5):       $${Math.round(monthlyP5).toLocaleString()}`);
    console.log(`  Bad month (P10):     $${Math.round(monthlyP10).toLocaleString()}`);
    console.log(`  Below avg (P25):     $${Math.round(monthlyP25).toLocaleString()}`);
    console.log(`  ────────────────────`);
    console.log(`  MEDIAN (P50):        $${Math.round(monthlyP50).toLocaleString()}`);
    console.log(`  ────────────────────`);
    console.log(`  Above avg (P75):     $${Math.round(monthlyP75).toLocaleString()}`);
    console.log(`  Good month (P90):    $${Math.round(monthlyP90).toLocaleString()}`);
    console.log(`  Great month (P95):   $${Math.round(monthlyP95).toLocaleString()}`);
    console.log(`  Best-case (P99):     $${Math.round(monthlyP99).toLocaleString()}`);
    console.log('');
    console.log(`  EXTREMES:`);
    console.log(`    Worst month ever:  $${Math.round(worstMonth).toLocaleString()}`);
    console.log(`    Best month ever:   $${Math.round(bestMonth).toLocaleString()}`);
    console.log('');
    
    console.log('───────────────────────────────────────────────────────────────────────────────');
    console.log('                         6-MONTH TOTAL DISTRIBUTION');
    console.log('───────────────────────────────────────────────────────────────────────────────');
    console.log('');
    console.log(`  Worst-case (P1):     $${Math.round(totalP1).toLocaleString()}`);
    console.log(`  Very bad (P5):       $${Math.round(totalP5).toLocaleString()}`);
    console.log(`  Bad run (P10):       $${Math.round(totalP10).toLocaleString()}`);
    console.log(`  Below avg (P25):     $${Math.round(totalP25).toLocaleString()}`);
    console.log(`  ────────────────────`);
    console.log(`  MEDIAN (P50):        $${Math.round(totalP50).toLocaleString()}`);
    console.log(`  MEAN:                $${Math.round(result.profit.mean * 6).toLocaleString()}`);
    console.log(`  ────────────────────`);
    console.log(`  Above avg (P75):     $${Math.round(totalP75).toLocaleString()}`);
    console.log(`  Good run (P90):      $${Math.round(totalP90).toLocaleString()}`);
    console.log(`  Great run (P95):     $${Math.round(totalP95).toLocaleString()}`);
    console.log(`  Best-case (P99):     $${Math.round(totalP99).toLocaleString()}`);
    console.log('');
    console.log(`  EXTREMES:`);
    console.log(`    Worst 6-mo ever:   $${Math.round(worst6Mo).toLocaleString()}`);
    console.log(`    Best 6-mo ever:    $${Math.round(best6Mo).toLocaleString()}`);
    console.log('');
    
    console.log('───────────────────────────────────────────────────────────────────────────────');
    console.log('                         PROBABILITY OF LOSS');
    console.log('───────────────────────────────────────────────────────────────────────────────');
    console.log('');
    const monthlyLossProb = (losingMonths / allMonthlyProfits.length) * 100;
    const iterationLossProb = (losingIterations / iterationTotals.length) * 100;
    const breakEvenProb = (breakEvenIterations / iterationTotals.length) * 100;
    
    console.log(`  Chance of ANY losing month:     ${monthlyLossProb.toFixed(2)}%`);
    console.log(`  Chance of 6-month net loss:     ${iterationLossProb.toFixed(2)}%`);
    console.log(`  Chance of break-even 6-mo:      ${breakEvenProb.toFixed(2)}% (profit < $10k)`);
    console.log(`  Chance of profitable 6-mo:      ${(100 - iterationLossProb).toFixed(2)}%`);
    console.log('');
    console.log(`  Max consecutive losing months:  ${maxConsecutiveLosses}`);
    console.log(`  Max drawdown:                   $${Math.round(result.risk.maxDrawdown).toLocaleString()}`);
    console.log('');
    
    console.log('───────────────────────────────────────────────────────────────────────────────');
    console.log('                         FINANCIAL BREAKDOWN (6-MONTH)');
    console.log('───────────────────────────────────────────────────────────────────────────────');
    console.log('');
    console.log(`  Expected Revenue:       $${Math.round(result.diagnostics.avgMonthlyRevenue * 6).toLocaleString()}`);
    console.log(`  Expected Payouts:       $${Math.round(result.diagnostics.avgMonthlyPayouts * 6).toLocaleString()}`);
    console.log(`  Expected Fraud Loss:    $${Math.round(result.diagnostics.avgMonthlyFraudLoss * 6).toLocaleString()}`);
    console.log(`  Expected Chargebacks:   $${Math.round(result.diagnostics.avgMonthlyChargebacks * 6).toLocaleString()}`);
    console.log(`  Expected Costs:         $${Math.round(result.diagnostics.avgMonthlyCosts * 6).toLocaleString()}`);
    console.log('');
    console.log(`  Payout/Revenue Ratio:   ${(result.diagnostics.payoutToRevenueRatio * 100).toFixed(1)}%`);
    console.log(`  Effective Margin:       ${(result.diagnostics.effectiveMargin * 100).toFixed(1)}%`);
    console.log('');
    
    console.log('───────────────────────────────────────────────────────────────────────────────');
    console.log('                         CAP EFFECTIVENESS');
    console.log('───────────────────────────────────────────────────────────────────────────────');
    console.log('');
    console.log(`  First Payout Cap Binding:       ${(result.payoutDiagnostics.firstPayoutCapBindingRate * 100).toFixed(1)}%`);
    console.log(`  Lifetime Cap Binding:           ${(result.payoutDiagnostics.lifetimeCapBindingRate * 100).toFixed(1)}%`);
    console.log(`  Avg Payout Size:                $${Math.round(result.payoutDiagnostics.avgPayoutSize)}`);
    console.log(`  Avg Lifetime Paid/Account:      $${Math.round(result.payoutDiagnostics.avgLifetimePaidPerAccount)}`);
    console.log(`  Cap Pressure:                   ${result.payoutDiagnostics.capPressure ? (result.payoutDiagnostics.capPressure * 100).toFixed(1) + '%' : 'N/A'}`);
    console.log('');
    console.log(`  Lifetime Paid P50:              $${Math.round(result.payoutDiagnostics.lifetimePaidP50)}`);
    console.log(`  Lifetime Paid P90:              $${Math.round(result.payoutDiagnostics.lifetimePaidP90)}`);
    console.log(`  Lifetime Paid P95:              $${Math.round(result.payoutDiagnostics.lifetimePaidP95)}`);
    console.log('');
    
    console.log('═══════════════════════════════════════════════════════════════════════════════');
    console.log('                              VERDICT');
    console.log('═══════════════════════════════════════════════════════════════════════════════');
    console.log('');
    
    if (iterationLossProb < 1) {
      console.log('  ✅ HIGHLY CONFIDENT: Less than 1% chance of 6-month loss');
    } else if (iterationLossProb < 5) {
      console.log('  ✅ CONFIDENT: Less than 5% chance of 6-month loss');
    } else if (iterationLossProb < 10) {
      console.log('  ⚠️ MODERATE: 5-10% chance of 6-month loss');
    } else {
      console.log('  ❌ RISKY: >10% chance of 6-month loss');
    }
    
    console.log(`  📊 Expected 6-month profit: $${Math.round(result.profit.mean * 6).toLocaleString()}`);
    console.log(`  📊 Median 6-month profit:   $${Math.round(totalP50).toLocaleString()}`);
    console.log(`  📊 Monthly profit (median): $${Math.round(monthlyP50).toLocaleString()}`);
    console.log('');
    console.log('═══════════════════════════════════════════════════════════════════════════════');
    
    // Assertions for test to pass
    expect(result.profit.mean).toBeGreaterThan(0);
    expect(allMonthlyProfits.length).toBe(6000); // 1000 iterations × 6 months
  });
});
