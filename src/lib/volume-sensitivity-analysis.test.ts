/**
 * Volume Sensitivity Analysis
 * Find optimal and minimum viable account volumes
 */

import { describe, it, expect } from 'vitest';
import { runMonteCarlo, MonteCarloConfig, MonteCarloAssumptions } from './monte-carlo';

const BASE_ASSUMPTIONS: Omit<MonteCarloAssumptions, 'accountsPerMonth'> = {
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
    minWinningDaysPerPayout: 0,
    requireProfitSinceLastPayout: false,
    payoutCadenceDays: 0,
  },
};

const CONFIG: MonteCarloConfig = {
  iterations: 500,
  monthsPerIteration: 6,
  seed: 42,
};

describe('Volume Sensitivity Analysis', () => {
  it('should find optimal and minimum viable volumes with REAL percentiles', () => {
    console.log('\n📊 VOLUME SENSITIVITY ANALYSIS (with honest P1/P5)\n');
    console.log('Testing account volumes from 10 to 500/month...\n');
    
    const volumes = [10, 20, 30, 40, 50, 75, 100, 150, 200, 300, 500];
    const results: Array<{
      volume: number;
      profit6Mo: number;
      profitP5: number;
      profitP1: number;
      worstMonth: number;
      monthlyProfit: number;
      margin: number;
      lossProb: number;
      payoutRatio: number;
      marginPerAccount: number;
    }> = [];
    
    for (const volume of volumes) {
      const assumptions: MonteCarloAssumptions = {
        ...BASE_ASSUMPTIONS,
        accountsPerMonth: volume,
      };
      
      const result = runMonteCarlo(CONFIG, assumptions);
      
      // FIXED: Compute REAL P1 from raw samples, not fake estimate
      let realP1_6mo = 0;
      if (result.rawSamples) {
        const iterationTotals = result.rawSamples.map(iter => iter.reduce((a, b) => a + b, 0));
        iterationTotals.sort((a, b) => a - b);
        realP1_6mo = iterationTotals[Math.floor(iterationTotals.length * 0.01)];
      }
      
      const profit6Mo = Math.round(result.profit.mean * 6);
      const marginPerAccount = profit6Mo / (volume * 6);
      
      results.push({
        volume,
        profit6Mo,
        profitP5: Math.round(result.profit.p5 * 6),
        profitP1: Math.round(realP1_6mo), // NOW REAL P1
        worstMonth: Math.round(result.risk.worstMonth),
        monthlyProfit: Math.round(result.profit.mean),
        margin: result.diagnostics.effectiveMargin,
        lossProb: result.risk.probabilityOfLoss,
        payoutRatio: result.diagnostics.payoutToRevenueRatio,
        marginPerAccount,
      });
    }
    
    // Find breakeven point (now using REAL P1)
    const breakevenP1 = results.find(r => r.profitP1 > 0);
    const breakevenP5 = results.find(r => r.profitP5 > 0);
    
    // Find optimal (best margin)
    const optimal = results.reduce((best, curr) => 
      curr.margin > best.margin ? curr : best
    );
    
    // Print table
    console.log('══════════════════════════════════════════════════════════════════════════════════════════════════════════════');
    console.log('  Volume  │  6-Mo Profit  │  P5 (5%)   │  P1 (1%)   │  Worst Mo  │  Margin  │  Loss%  │  Status');
    console.log('══════════════════════════════════════════════════════════════════════════════════════════════════════════════');
    
    for (const r of results) {
      const status = r.profitP1 < 0 ? '❌ P1 LOSS' : 
                     r.profitP5 < 0 ? '⚠️ P5 LOSS' :
                     r.volume === optimal.volume ? '⭐ OPTIMAL' :
                     r.margin > 0.45 ? '✅ GREAT' : '✅ OK';
      
      console.log(
        `  ${r.volume.toString().padStart(3)}     │  ` +
        `${('$' + r.profit6Mo.toLocaleString()).padStart(10)}  │  ` +
        `${('$' + r.profitP5.toLocaleString()).padStart(8)}  │  ` +
        `${('$' + r.profitP1.toLocaleString()).padStart(8)}  │  ` +
        `${('$' + r.worstMonth.toLocaleString()).padStart(8)}  │  ` +
        `${(r.margin * 100).toFixed(1).padStart(5)}%  │  ` +
        `${(r.lossProb * 100).toFixed(1).padStart(5)}%  │  ` +
        status
      );
    }
    
    console.log('══════════════════════════════════════════════════════════════════════════════════════════════════════════════');
    console.log('');
    
    // Key findings with honest numbers
    console.log('───────────────────────────────────────────────────────────────────────────────');
    console.log('                         KEY FINDINGS (HONEST PERCENTILES)');
    console.log('───────────────────────────────────────────────────────────────────────────────');
    console.log('');
    
    // P1 breakeven
    console.log('🔻 MINIMUM VIABLE (P1 > 0, true 99% confidence):');
    if (breakevenP1) {
      console.log(`   ${breakevenP1.volume} accounts/month`);
      console.log(`   6-mo profit: $${breakevenP1.profit6Mo.toLocaleString()}`);
      console.log(`   P1 (worst 1%): $${breakevenP1.profitP1.toLocaleString()}`);
      console.log(`   P5 (worst 5%): $${breakevenP1.profitP5.toLocaleString()}`);
    } else {
      console.log(`   ❌ No volume tested has P1 > 0`);
    }
    console.log('');
    
    // P5 breakeven
    console.log('⚡ P5 BREAKEVEN (95% confidence):');
    if (breakevenP5) {
      console.log(`   ${breakevenP5.volume} accounts/month`);
    }
    console.log('');
    
    // Optimal
    console.log('⭐ OPTIMAL (best margin):');
    console.log(`   ${optimal.volume} accounts/month`);
    console.log(`   6-mo profit: $${optimal.profit6Mo.toLocaleString()}`);
    console.log(`   Margin: ${(optimal.margin * 100).toFixed(1)}%`);
    console.log('');
    
    // Danger zones
    const dangerP1 = results.filter(r => r.profitP1 < 0);
    const dangerP5 = results.filter(r => r.profitP5 < 0);
    
    if (dangerP1.length > 0) {
      console.log('❌ DANGER ZONE (P1 < 0, 1% chance of loss):');
      for (const d of dangerP1) {
        console.log(`   ${d.volume} accounts: P1 = $${d.profitP1.toLocaleString()}, worst month = $${d.worstMonth.toLocaleString()}`);
      }
      console.log('');
    }
    
    if (dangerP5.length > dangerP1.length) {
      console.log('⚠️ ELEVATED RISK (P5 < 0 but P1 > 0):');
      for (const d of dangerP5.filter(r => r.profitP1 >= 0)) {
        console.log(`   ${d.volume} accounts: P5 = $${d.profitP5.toLocaleString()}`);
      }
      console.log('');
    }
    
    console.log('═══════════════════════════════════════════════════════════════════════════════');
    
    expect(results.length).toBe(volumes.length);
  });
});
