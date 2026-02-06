/**
 * 12-Month Platform Projection with Full Diagnostics
 * 
 * Three diagnostic outputs:
 * A) Month-level P&L waterfall (revenue, resets, costs, payouts, fraud, chargebacks, net)
 * B) Cohort counters (active, passed, eligible, % cap hit, zombies)
 * C) Multi-seed stability check (proves results aren't seed-dependent)
 */
import { describe, it, expect } from 'vitest';
import { runMonteCarlo, MonteCarloConfig, MonteCarloAssumptions, MonthResult } from './monte-carlo';

const BASE_ASSUMPTIONS: MonteCarloAssumptions = {
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
    minWinningDaysPerPayout: 0,
    minProfitSinceLastPayout: 0,
    minMonthsBetweenPayouts: 0,
    verificationMonths: 0,
    verificationFailRate: 0,
  },
};

const FULL_CONFIG: MonteCarloConfig = {
  iterations: 2000,
  monthsPerIteration: 12,
  seed: 42,
};

// ── Helper: aggregate MonthResult[] across iterations for a given month index ──
function aggregateMonth(allResults: MonthResult[][], monthIdx: number) {
  const months = allResults.map(iter => iter[monthIdx]);
  const n = months.length;
  const sum = (fn: (r: MonthResult) => number) => months.reduce((s, r) => s + fn(r), 0);
  const mean = (fn: (r: MonthResult) => number) => sum(fn) / n;
  const sorted = (fn: (r: MonthResult) => number) => months.map(fn).sort((a, b) => a - b);
  const p = (arr: number[], pct: number) => arr[Math.floor(arr.length * pct)];

  return {
    revenue: mean(r => r.revenue),
    resetRevenue: mean(r => r.resetRevenue),
    variableCosts: mean(r => r.variableCosts),
    fixedCosts: mean(r => r.fixedCosts),
    payouts: mean(r => r.payouts),
    fraudLoss: mean(r => r.fraudLoss),
    chargebacks: mean(r => r.chargebacks),
    netProfit: mean(r => r.netProfit),

    // P95 payouts for stress
    payoutsP95: p(sorted(r => r.payouts), 0.95),

    // Cohort counters
    activeCohort: mean(r => r.activeCohortSize),
    eligibleCohort: mean(r => r.eligibleCohortSize),
    newPassed: mean(r => r.newPassedAccountsThisMonth),
    resets: mean(r => r.resetsThisMonth),
    zombies: mean(r => r.payoutDetails.zombieAccountsCompleted),
    capHits: mean(r => r.payoutDetails.accountsCompletedByCap),
    payoutRequests: mean(r => r.payoutDetails.requestCount),
    payoutsApproved: mean(r => r.payoutDetails.approvedCount),
    firstPayoutCapHits: mean(r => r.payoutDetails.firstPayoutCapHits),
  };
}

const fmt = (n: number) => {
  const sign = n >= 0 ? '' : '-';
  return `${sign}$${Math.abs(Math.round(n)).toLocaleString()}`;
};
const fmtPct = (n: number) => `${(n * 100).toFixed(1)}%`;
const pad = (s: string, w: number) => s.padStart(w);

describe('12-Month Platform Projection', () => {

  it('A) Month-level P&L waterfall', () => {
    const result = runMonteCarlo(FULL_CONFIG, BASE_ASSUMPTIONS);
    const raw = result.rawMonthResults!;

    console.log('\n═══════════════════════════════════════════════════════════════════════════════════════════');
    console.log('  MONTH-LEVEL P&L WATERFALL (mean across 2,000 iterations)');
    console.log('  seed=42 | 100 accts/mo @ $149 | 7× lifetime cap | $300 first-payout cap');
    console.log('═══════════════════════════════════════════════════════════════════════════════════════════\n');
    console.log('┌───────┬──────────┬─────────┬─────────┬─────────┬──────────┬─────────┬──────────┬──────────┐');
    console.log('│ Month │ Revenue  │ Resets  │ Var$    │ Fixed$  │ Payouts  │ Fraud   │ CB       │ NET      │');
    console.log('├───────┼──────────┼─────────┼─────────┼─────────┼──────────┼─────────┼──────────┼──────────┤');

    let cumNet = 0;
    for (let m = 0; m < 12; m++) {
      const s = aggregateMonth(raw, m);
      cumNet += s.netProfit;
      console.log(
        `│   ${String(m + 1).padStart(2)}  │` +
        `${pad(fmt(s.revenue), 8)} │` +
        `${pad(fmt(s.resetRevenue), 7)} │` +
        `${pad(fmt(s.variableCosts), 7)} │` +
        `${pad(fmt(s.fixedCosts), 7)} │` +
        `${pad(fmt(s.payouts), 8)} │` +
        `${pad(fmt(s.fraudLoss), 7)} │` +
        `${pad(fmt(s.chargebacks), 8)} │` +
        `${pad(fmt(s.netProfit), 8)} │`
      );
    }
    console.log('└───────┴──────────┴─────────┴─────────┴─────────┴──────────┴─────────┴──────────┴──────────┘');
    console.log(`\n  Cumulative 12-month net: ${fmt(cumNet)}`);
    console.log(`  Note: "Revenue" = new account fees only. "Resets" = separate line.`);

    // Verify Month 10+ loss is driven by payouts, not fraud
    const m10 = aggregateMonth(raw, 9);
    const payoutShare = m10.payouts / (m10.payouts + m10.fraudLoss + m10.chargebacks);
    console.log(`\n  Month 10 loss attribution: payouts=${fmtPct(payoutShare)} fraud=${fmtPct(m10.fraudLoss / (m10.payouts + m10.fraudLoss + m10.chargebacks))} CB=${fmtPct(m10.chargebacks / (m10.payouts + m10.fraudLoss + m10.chargebacks))}`);

    expect(result.rawMonthResults).toBeDefined();
    expect(payoutShare).toBeGreaterThan(0.85); // payouts dominate late-month losses
  }, 300000);

  it('B) Cohort counters per month', () => {
    const result = runMonteCarlo(FULL_CONFIG, BASE_ASSUMPTIONS);
    const raw = result.rawMonthResults!;

    console.log('\n═══════════════════════════════════════════════════════════════════════════════════════════');
    console.log('  COHORT COUNTERS (mean across 2,000 iterations)');
    console.log('═══════════════════════════════════════════════════════════════════════════════════════════\n');
    console.log('┌───────┬─────────┬─────────┬──────────┬──────────┬──────────┬─────────┬─────────┬─────────┐');
    console.log('│ Month │ NewPass │ Active  │ Eligible │ PayReqs  │ Approved │ CapHits │ Zombies │ Resets  │');
    console.log('├───────┼─────────┼─────────┼──────────┼──────────┼──────────┼─────────┼─────────┼─────────┤');

    for (let m = 0; m < 12; m++) {
      const s = aggregateMonth(raw, m);
      console.log(
        `│   ${String(m + 1).padStart(2)}  │` +
        `${pad(String(Math.round(s.newPassed)), 7)} │` +
        `${pad(String(Math.round(s.activeCohort)), 7)} │` +
        `${pad(String(Math.round(s.eligibleCohort)), 8)} │` +
        `${pad(String(Math.round(s.payoutRequests)), 8)} │` +
        `${pad(String(Math.round(s.payoutsApproved)), 8)} │` +
        `${pad(String(Math.round(s.capHits)), 7)} │` +
        `${pad(String(Math.round(s.zombies)), 7)} │` +
        `${pad(String(Math.round(s.resets)), 7)} │`
      );
    }
    console.log('└───────┴─────────┴─────────┴──────────┴──────────┴──────────┴─────────┴─────────┴─────────┘');

    // Verify: no payouts in month 1 without eligible accounts (21-day lag = 1 month)
    const m1 = aggregateMonth(raw, 0);
    console.log(`\n  Month 1 eligible: ${Math.round(m1.eligibleCohort)} (should be 0 due to 21-day lag)`);
    console.log(`  Month 1 payouts: ${fmt(m1.payouts)} (should be ~$0)`);
    expect(m1.eligibleCohort).toBeLessThan(1); // No one eligible in month 1

    // Verify: active cohort grows then stabilizes as cap/zombie attrition kicks in
    const m6 = aggregateMonth(raw, 5);
    const m12 = aggregateMonth(raw, 11);
    console.log(`\n  Active cohort M6: ${Math.round(m6.activeCohort)} → M12: ${Math.round(m12.activeCohort)}`);
    console.log(`  Cap hit rate M12: ${fmtPct(m12.capHits / Math.max(1, m12.activeCohort))} of active cohort/month`);

    expect(m6.activeCohort).toBeGreaterThan(m1.activeCohort);
  }, 300000);

  it('C) Multi-seed stability check', () => {
    const seeds = [42, 137, 2024, 7777, 31415];
    const results: Array<{
      seed: number;
      month12Mean: number;
      cumProfit: number;
      p99Drawdown: number;
      worstMonth: number;
    }> = [];

    for (const seed of seeds) {
      const config: MonteCarloConfig = { iterations: 2000, monthsPerIteration: 12, seed };
      const r = runMonteCarlo(config, BASE_ASSUMPTIONS);
      const rawProfits = r.rawSamples!;

      // Month 12 mean
      const m12profits = rawProfits.map(iter => iter[11]).sort((a, b) => a - b);
      const m12mean = m12profits.reduce((s, v) => s + v, 0) / m12profits.length;

      // Cumulative profit
      const cumProfits = rawProfits.map(iter => iter.reduce((s, v) => s + v, 0));
      const cumMean = cumProfits.reduce((s, v) => s + v, 0) / cumProfits.length;

      // P99 drawdown
      const drawdowns: number[] = [];
      for (const iter of rawProfits) {
        let peak = 0, cum = 0, maxDD = 0;
        for (const p of iter) {
          cum += p;
          peak = Math.max(peak, cum);
          maxDD = Math.max(maxDD, peak - cum);
        }
        drawdowns.push(maxDD);
      }
      drawdowns.sort((a, b) => a - b);
      const p99DD = drawdowns[Math.floor(drawdowns.length * 0.99)];

      // Worst month
      let worst = 0;
      for (const iter of rawProfits) for (const p of iter) worst = Math.min(worst, p);

      results.push({ seed, month12Mean: m12mean, cumProfit: cumMean, p99Drawdown: p99DD, worstMonth: worst });
    }

    console.log('\n═══════════════════════════════════════════════════════════════════════════════════');
    console.log('  MULTI-SEED STABILITY CHECK (2,000 iterations each, same assumptions)');
    console.log('═══════════════════════════════════════════════════════════════════════════════════\n');
    console.log('┌────────┬──────────────┬──────────────┬──────────────┬──────────────┐');
    console.log('│  Seed  │ M12 Mean     │ 12mo Cum     │ P99 Drawdown │ Worst Month  │');
    console.log('├────────┼──────────────┼──────────────┼──────────────┼──────────────┤');

    for (const r of results) {
      console.log(
        `│ ${String(r.seed).padStart(6)} │` +
        `${pad(fmt(r.month12Mean), 12)} │` +
        `${pad(fmt(r.cumProfit), 12)} │` +
        `${pad(fmt(r.p99Drawdown), 12)} │` +
        `${pad(fmt(r.worstMonth), 12)} │`
      );
    }
    console.log('└────────┴──────────────┴──────────────┴──────────────┴──────────────┘');

    // Stability assertions: all seeds should agree within ±15% of seed-42 baseline
    const baseline = results.find(r => r.seed === 42)!;
    for (const r of results) {
      const cumDrift = Math.abs(r.cumProfit - baseline.cumProfit) / Math.abs(baseline.cumProfit);
      console.log(`  Seed ${r.seed}: cumulative drift from baseline = ${(cumDrift * 100).toFixed(1)}%`);
      expect(cumDrift).toBeLessThan(0.15); // <15% drift = stable
    }

    // Also check P99 drawdown stability (critical for reserve sizing)
    const ddValues = results.map(r => r.p99Drawdown);
    const ddMean = ddValues.reduce((s, v) => s + v, 0) / ddValues.length;
    const ddRange = Math.max(...ddValues) - Math.min(...ddValues);
    console.log(`\n  P99 Drawdown range: ${fmt(Math.min(...ddValues))} – ${fmt(Math.max(...ddValues))} (spread: ${fmt(ddRange)})`);
    console.log(`  P99 Drawdown mean across seeds: ${fmt(ddMean)}`);

    expect(ddRange / ddMean).toBeLessThan(0.5); // Range < 50% of mean = stable enough
  }, 600000);

  it('Original: month-by-month P&L and cash reserves', () => {
    const result = runMonteCarlo(FULL_CONFIG, BASE_ASSUMPTIONS);
    const monthlyProfits = result.rawSamples!;

    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('     12-MONTH P&L + CASH RESERVE (2,000 sims, seed=42)');
    console.log('═══════════════════════════════════════════════════════════════\n');

    // Month-by-month table
    console.log('┌───────┬──────────┬──────────┬──────────┬──────────┬──────────┬─────────┐');
    console.log('│ Month │   Mean   │   P5     │  Median  │   P95    │  Worst   │ Loss %  │');
    console.log('├───────┼──────────┼──────────┼──────────┼──────────┼──────────┼─────────┤');

    for (let m = 0; m < 12; m++) {
      const mp = monthlyProfits.map(iter => iter[m]).sort((a, b) => a - b);
      const mean = mp.reduce((s, v) => s + v, 0) / mp.length;
      const p5 = mp[Math.floor(mp.length * 0.05)];
      const p50 = mp[Math.floor(mp.length * 0.50)];
      const p95 = mp[Math.floor(mp.length * 0.95)];
      const worst = mp[0];
      const lossPct = mp.filter(p => p < 0).length / mp.length;

      console.log(
        `│   ${String(m + 1).padStart(2)}  │` +
        `${pad(fmt(mean), 8)} │${pad(fmt(p5), 8)} │${pad(fmt(p50), 8)} │${pad(fmt(p95), 8)} │${pad(fmt(worst), 8)} │${pad(fmtPct(lossPct), 7)} │`
      );
    }
    console.log('└───────┴──────────┴──────────┴──────────┴──────────┴──────────┴─────────┘');

    // Cash reserve
    const allDrawdowns: number[] = [];
    let worstSingleMonth = 0;
    for (const iter of monthlyProfits) {
      let peak = 0, cum = 0, maxDD = 0;
      for (const p of iter) {
        cum += p;
        peak = Math.max(peak, cum);
        maxDD = Math.max(maxDD, peak - cum);
        worstSingleMonth = Math.min(worstSingleMonth, p);
      }
      allDrawdowns.push(maxDD);
    }
    allDrawdowns.sort((a, b) => a - b);
    const p95DD = allDrawdowns[Math.floor(allDrawdowns.length * 0.95)];
    const p99DD = allDrawdowns[Math.floor(allDrawdowns.length * 0.99)];
    const maxDD = allDrawdowns[allDrawdowns.length - 1];

    console.log('\n── CASH RESERVE ──\n');
    console.log(`  Minimum (P95):     ${fmt(p95DD)}`);
    console.log(`  Recommended (P99): ${fmt(p99DD)}`);
    console.log(`  Paranoid (worst):  ${fmt(maxDD)}`);
    console.log(`  Worst single month: ${fmt(worstSingleMonth)}`);

    expect(result.profit.mean).toBeGreaterThan(0);
    expect(result.rawSamples!.length).toBe(2000);
  }, 300000);
});
