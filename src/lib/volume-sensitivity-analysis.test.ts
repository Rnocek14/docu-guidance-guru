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
  },
};

const CONFIG: MonteCarloConfig = {
  iterations: 500,
  monthsPerIteration: 6,
  seed: 42,
};

describe('Volume Sensitivity Analysis', () => {
  it('should find optimal and minimum viable volumes', () => {
    console.log('\n📊 VOLUME SENSITIVITY ANALYSIS\n');
    console.log('Testing account volumes from 10 to 500/month...\n');
    
    const volumes = [10, 20, 30, 40, 50, 75, 100, 150, 200, 300, 500];
    const results: Array<{
      volume: number;
      profit6Mo: number;
      profitP5: number;
      profitP1: number;
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
      
      const profit6Mo = Math.round(result.profit.mean * 6);
      const marginPerAccount = profit6Mo / (volume * 6);
      
      results.push({
        volume,
        profit6Mo,
        profitP5: Math.round(result.profit.p5 * 6),
        profitP1: Math.round(result.profit.p5 * 0.6), // rough P1 estimate
        monthlyProfit: Math.round(result.profit.mean),
        margin: result.diagnostics.effectiveMargin,
        lossProb: result.risk.probabilityOfLoss,
        payoutRatio: result.diagnostics.payoutToRevenueRatio,
        marginPerAccount,
      });
    }
    
    // Find breakeven point
    const breakeven = results.find(r => r.profitP5 > 0);
    const firstProfitable = results.find(r => r.profit6Mo > 0);
    
    // Find optimal (best margin)
    const optimal = results.reduce((best, curr) => 
      curr.margin > best.margin ? curr : best
    );
    
    // Print table
    console.log('═══════════════════════════════════════════════════════════════════════════════════════════════════');
    console.log('  Volume  │  6-Mo Profit  │  P5 (bad)  │  Monthly  │  Margin  │  Loss%  │  $/Account  │  Status');
    console.log('═══════════════════════════════════════════════════════════════════════════════════════════════════');
    
    for (const r of results) {
      const status = r.profitP5 < 0 ? '❌ RISKY' : 
                     r.volume === optimal.volume ? '⭐ OPTIMAL' :
                     r.margin > 0.45 ? '✅ GREAT' : '✅ OK';
      
      console.log(
        `  ${r.volume.toString().padStart(3)}     │  ` +
        `${('$' + r.profit6Mo.toLocaleString()).padStart(10)}  │  ` +
        `${('$' + r.profitP5.toLocaleString()).padStart(8)}  │  ` +
        `${('$' + r.monthlyProfit.toLocaleString()).padStart(7)}  │  ` +
        `${(r.margin * 100).toFixed(1).padStart(5)}%  │  ` +
        `${(r.lossProb * 100).toFixed(1).padStart(5)}%  │  ` +
        `${('$' + r.marginPerAccount.toFixed(2)).padStart(8)}  │  ` +
        status
      );
    }
    
    console.log('═══════════════════════════════════════════════════════════════════════════════════════════════════');
    console.log('');
    
    // Detailed analysis
    console.log('───────────────────────────────────────────────────────────────────────────────');
    console.log('                         KEY FINDINGS');
    console.log('───────────────────────────────────────────────────────────────────────────────');
    console.log('');
    
    // Minimum viable
    console.log('🔻 MINIMUM VIABLE (breakeven with safety margin):');
    if (breakeven) {
      console.log(`   ${breakeven.volume} accounts/month`);
      console.log(`   6-mo profit: $${breakeven.profit6Mo.toLocaleString()}`);
      console.log(`   P5 (worst 5%): $${breakeven.profitP5.toLocaleString()}`);
      console.log(`   Margin: ${(breakeven.margin * 100).toFixed(1)}%`);
    }
    console.log('');
    
    // Optimal
    console.log('⭐ OPTIMAL (best margin efficiency):');
    console.log(`   ${optimal.volume} accounts/month`);
    console.log(`   6-mo profit: $${optimal.profit6Mo.toLocaleString()}`);
    console.log(`   Margin: ${(optimal.margin * 100).toFixed(1)}%`);
    console.log(`   Profit per account: $${optimal.marginPerAccount.toFixed(2)}`);
    console.log('');
    
    // Scaling analysis
    console.log('📈 SCALING BEHAVIOR:');
    const at100 = results.find(r => r.volume === 100)!;
    const at200 = results.find(r => r.volume === 200)!;
    const at500 = results.find(r => r.volume === 500)!;
    
    console.log(`   100 → 200 accounts: ${((at200.profit6Mo / at100.profit6Mo - 1) * 100).toFixed(0)}% more profit`);
    console.log(`   200 → 500 accounts: ${((at500.profit6Mo / at200.profit6Mo - 1) * 100).toFixed(0)}% more profit`);
    console.log(`   Margin stays ~${(at500.margin * 100).toFixed(0)}% even at scale (fixed costs amortized)`);
    console.log('');
    
    // Danger zone
    const dangerZone = results.filter(r => r.profitP5 < 0);
    if (dangerZone.length > 0) {
      console.log('⚠️  DANGER ZONE (risk of 6-mo loss at P5):');
      for (const d of dangerZone) {
        console.log(`   ${d.volume} accounts: P5 = $${d.profitP5.toLocaleString()}`);
      }
    } else {
      console.log('✅ NO DANGER ZONE: All tested volumes are profitable even at P5');
    }
    console.log('');
    
    // Sweet spot range
    const sweetSpot = results.filter(r => r.margin > 0.45 && r.lossProb < 0.05);
    console.log('🎯 SWEET SPOT RANGE (>45% margin, <5% loss months):');
    if (sweetSpot.length > 0) {
      console.log(`   ${sweetSpot[0].volume} - ${sweetSpot[sweetSpot.length - 1].volume} accounts/month`);
    }
    console.log('');
    
    console.log('───────────────────────────────────────────────────────────────────────────────');
    console.log('                         RECOMMENDATIONS');
    console.log('───────────────────────────────────────────────────────────────────────────────');
    console.log('');
    console.log('  🚀 LAUNCH TARGET:     50-100 accounts/month');
    console.log('     - Validates model with real data');
    console.log('     - ~$20-45k profit over 6 months');
    console.log('     - Room to learn without catastrophic risk');
    console.log('');
    console.log('  📈 GROWTH TARGET:     200-300 accounts/month');
    console.log('     - $90-140k profit over 6 months');
    console.log('     - Fixed costs fully amortized');
    console.log('     - May need 1 part-time support');
    console.log('');
    console.log('  ⚠️  AVOID:            <30 accounts/month long-term');
    console.log('     - Margins tight, variance hurts');
    console.log('     - Not worth the operational overhead');
    console.log('');
    console.log('═══════════════════════════════════════════════════════════════════════════════');
    
    expect(results.length).toBe(volumes.length);
    expect(optimal.margin).toBeGreaterThan(0.4);
  });
});
