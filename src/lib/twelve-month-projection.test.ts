/**
 * 12-Month Platform Projection with Month-by-Month Breakdown
 * Uses the slow-growth assumptions (solo operator, 100 accounts/month)
 */
import { describe, it, expect } from 'vitest';
import { runMonteCarlo, MonteCarloConfig, MonteCarloAssumptions } from './monte-carlo';

describe('12-Month Platform Projection', () => {
  it('produces month-by-month P&L and cash reserve requirements', () => {
    // Your actual production assumptions (Starter tier)
    const assumptions: MonteCarloAssumptions = {
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

    const config: MonteCarloConfig = {
      iterations: 2000,
      monthsPerIteration: 12,
      seed: 42,
    };

    const result = runMonteCarlo(config, assumptions);

    // ── Month-by-month from raw samples ──
    const monthlyProfits = result.rawSamples!;
    
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('     12-MONTH PLATFORM PROJECTION (2,000 simulations)');
    console.log('     100 new accounts/month @ $149 | 7× lifetime cap');
    console.log('═══════════════════════════════════════════════════════════════\n');

    // Calculate per-month statistics
    const monthStats: Array<{
      month: number;
      mean: number;
      p5: number;
      p50: number;
      p95: number;
      worstCase: number;
      lossProb: number;
    }> = [];

    let cumulativeMean = 0;
    let worstCumulativeP5 = 0;

    for (let m = 0; m < 12; m++) {
      const monthProfits = monthlyProfits.map(iter => iter[m]).sort((a, b) => a - b);
      const mean = monthProfits.reduce((s, v) => s + v, 0) / monthProfits.length;
      const p5 = monthProfits[Math.floor(monthProfits.length * 0.05)];
      const p50 = monthProfits[Math.floor(monthProfits.length * 0.50)];
      const p95 = monthProfits[Math.floor(monthProfits.length * 0.95)];
      const worstCase = monthProfits[0];
      const lossProb = monthProfits.filter(p => p < 0).length / monthProfits.length;

      cumulativeMean += mean;

      monthStats.push({ month: m + 1, mean, p5, p50, p95, worstCase, lossProb });
    }

    // Print month-by-month table
    console.log('┌───────┬──────────┬──────────┬──────────┬──────────┬──────────┬─────────┐');
    console.log('│ Month │   Mean   │   P5     │  Median  │   P95    │  Worst   │ Loss %  │');
    console.log('├───────┼──────────┼──────────┼──────────┼──────────┼──────────┼─────────┤');
    
    for (const s of monthStats) {
      const mean = `$${Math.round(s.mean).toLocaleString()}`.padStart(8);
      const p5 = `$${Math.round(s.p5).toLocaleString()}`.padStart(8);
      const p50 = `$${Math.round(s.p50).toLocaleString()}`.padStart(8);
      const p95 = `$${Math.round(s.p95).toLocaleString()}`.padStart(8);
      const worst = `$${Math.round(s.worstCase).toLocaleString()}`.padStart(8);
      const loss = `${(s.lossProb * 100).toFixed(1)}%`.padStart(7);
      console.log(`│   ${String(s.month).padStart(2)}  │${mean} │${p5} │${p50} │${p95} │${worst} │${loss} │`);
    }
    console.log('└───────┴──────────┴──────────┴──────────┴──────────┴──────────┴─────────┘');

    // ── Cumulative P&L ──
    console.log('\n── CUMULATIVE P&L (running total) ──\n');
    console.log('┌───────┬──────────┬──────────┬──────────┬──────────┐');
    console.log('│ Month │ Cum Mean │  Cum P5  │ Cum P50  │ Cum P95  │');
    console.log('├───────┼──────────┼──────────┼──────────┼──────────┤');

    for (let m = 0; m < 12; m++) {
      // Calculate cumulative profits per iteration
      const cumProfits = monthlyProfits.map(iter => {
        let sum = 0;
        for (let i = 0; i <= m; i++) sum += iter[i];
        return sum;
      }).sort((a, b) => a - b);

      const cumMean = cumProfits.reduce((s, v) => s + v, 0) / cumProfits.length;
      const cumP5 = cumProfits[Math.floor(cumProfits.length * 0.05)];
      const cumP50 = cumProfits[Math.floor(cumProfits.length * 0.50)];
      const cumP95 = cumProfits[Math.floor(cumProfits.length * 0.95)];

      if (m === 0) worstCumulativeP5 = cumP5;
      else worstCumulativeP5 = Math.min(worstCumulativeP5, cumP5);

      const cm = `$${Math.round(cumMean).toLocaleString()}`.padStart(8);
      const cp5 = `$${Math.round(cumP5).toLocaleString()}`.padStart(8);
      const cp50 = `$${Math.round(cumP50).toLocaleString()}`.padStart(8);
      const cp95 = `$${Math.round(cumP95).toLocaleString()}`.padStart(8);
      console.log(`│   ${String(m + 1).padStart(2)}  │${cm} │${cp5} │${cp50} │${cp95} │`);
    }
    console.log('└───────┴──────────┴──────────┴──────────┴──────────┘');

    // ── Cash Reserve Calculation ──
    console.log('\n── CASH RESERVE REQUIREMENTS ──\n');

    // Max drawdown across all iterations
    let maxDrawdownAcrossAll = 0;
    for (const iter of monthlyProfits) {
      let peak = 0;
      let cumulative = 0;
      for (const monthly of iter) {
        cumulative += monthly;
        peak = Math.max(peak, cumulative);
        const drawdown = peak - cumulative;
        maxDrawdownAcrossAll = Math.max(maxDrawdownAcrossAll, drawdown);
      }
    }

    // Worst single month across all iterations
    let worstSingleMonth = 0;
    for (const iter of monthlyProfits) {
      for (const monthly of iter) {
        worstSingleMonth = Math.min(worstSingleMonth, monthly);
      }
    }

    // P1 drawdown (1st percentile - what you'd see once in 100 runs)
    const allDrawdowns: number[] = [];
    for (const iter of monthlyProfits) {
      let peak = 0;
      let cumulative = 0;
      let maxDD = 0;
      for (const monthly of iter) {
        cumulative += monthly;
        peak = Math.max(peak, cumulative);
        maxDD = Math.max(maxDD, peak - cumulative);
      }
      allDrawdowns.push(maxDD);
    }
    allDrawdowns.sort((a, b) => a - b);
    const p95Drawdown = allDrawdowns[Math.floor(allDrawdowns.length * 0.95)];
    const p99Drawdown = allDrawdowns[Math.floor(allDrawdowns.length * 0.99)];

    console.log(`  Worst single month (absolute floor):  $${Math.round(worstSingleMonth).toLocaleString()}`);
    console.log(`  Max drawdown (worst iteration):       $${Math.round(maxDrawdownAcrossAll).toLocaleString()}`);
    console.log(`  P95 drawdown (1 in 20 chance):        $${Math.round(p95Drawdown).toLocaleString()}`);
    console.log(`  P99 drawdown (1 in 100 chance):       $${Math.round(p99Drawdown).toLocaleString()}`);
    console.log('');
    console.log('  ┌─────────────────────────────────────────────────────────┐');
    console.log(`  │  MINIMUM CASH RESERVE (covers P95):  $${Math.round(p95Drawdown).toLocaleString().padStart(7)}        │`);
    console.log(`  │  RECOMMENDED RESERVE (covers P99):   $${Math.round(p99Drawdown).toLocaleString().padStart(7)}        │`);
    console.log(`  │  PARANOID RESERVE (absolute worst):  $${Math.round(maxDrawdownAcrossAll).toLocaleString().padStart(7)}        │`);
    console.log('  └─────────────────────────────────────────────────────────┘');

    // ── Summary ──
    console.log('\n── 12-MONTH SUMMARY ──\n');
    console.log(`  Expected annual profit:     $${Math.round(result.profit.mean * 12).toLocaleString()}`);
    console.log(`  Pessimistic (P5) annual:    $${Math.round(result.profit.p5 * 12).toLocaleString()}`);
    console.log(`  Optimistic (P95) annual:    $${Math.round(result.profit.p95 * 12).toLocaleString()}`);
    console.log(`  Effective margin:           ${(result.diagnostics.effectiveMargin * 100).toFixed(1)}%`);
    console.log(`  Payout/Revenue ratio:       ${(result.diagnostics.payoutToRevenueRatio * 100).toFixed(1)}%`);
    console.log(`  Monthly revenue (avg):      $${Math.round(result.diagnostics.avgMonthlyRevenue).toLocaleString()}`);
    console.log(`  Monthly payouts (avg):      $${Math.round(result.diagnostics.avgMonthlyPayouts).toLocaleString()}`);
    console.log(`  Prob of any losing month:   ${(result.risk.probabilityOfLoss * 100).toFixed(1)}%`);
    console.log('');

    expect(result.profit.mean).toBeGreaterThan(0);
    expect(result.rawSamples).toBeDefined();
    expect(result.rawSamples!.length).toBe(2000);
  }, 300000);
});
