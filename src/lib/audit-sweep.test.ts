/**
 * Audit Sweep: Validate profit gate effect with payout frequency diagnostics
 * 
 * Sanity checks:
 * 1. Mean payouts per funded account per month (before/after gate)
 * 2. Payout clustering (how many months between payouts)
 * 3. Velocity gate block rate
 * 4. Does the profit gate reduce frequency by a realistic amount?
 * 
 * Output: structured JSON diagnostics, not console tables.
 */

import { describe, it, expect } from 'vitest';
import {
  runMonteCarlo,
  DEFAULT_ASSUMPTIONS,
  type MonteCarloAssumptions,
  type MonteCarloConfig,
  type MonteCarloResult,
} from './monte-carlo';

const CONFIG: MonteCarloConfig = {
  iterations: 300,
  monthsPerIteration: 12,
  seed: 42,
};

function withPassRate(mode: number, base: MonteCarloAssumptions = DEFAULT_ASSUMPTIONS): MonteCarloAssumptions {
  return {
    ...base,
    passRate: { min: Math.max(0.04, mode - 0.03), mode, max: mode + 0.03 },
  };
}

function withDevLayer(base: MonteCarloAssumptions): MonteCarloAssumptions {
  return {
    ...base,
    chargebackRate: {
      min: base.chargebackRate.min * 0.80,
      mode: base.chargebackRate.mode * 0.80,
      max: base.chargebackRate.max * 0.80,
    },
    fraudAttemptRate: {
      min: base.fraudAttemptRate.min * 0.85,
      mode: base.fraudAttemptRate.mode * 0.85,
      max: base.fraudAttemptRate.max * 0.85,
    },
  };
}

interface AuditRow {
  variant: string;
  passRate: number;
  margin: number;
  profitPerMonth: number;
  lossProb: number;
  payoutToRevenue: number;
  avgMonthlyPayouts: number;
  avgMonthlyRevenue: number;
  // Payout frequency diagnostics
  payoutsApprovedTotal: number;
  payoutsRequestedTotal: number;
  approvalRate: number;
  avgPayoutSize: number;
  avgPayoutsPerAccount: number;
  // Cap diagnostics
  firstPayoutCapBindingRate: number;
  lifetimeCapBindingRate: number;
}

function audit(name: string, passRate: number, assumptions: MonteCarloAssumptions): AuditRow {
  const r = runMonteCarlo(CONFIG, assumptions);
  return {
    variant: name,
    passRate,
    margin: r.diagnostics.effectiveMargin,
    profitPerMonth: r.profit.mean,
    lossProb: r.risk.probabilityOfLoss,
    payoutToRevenue: r.diagnostics.payoutToRevenueRatio,
    avgMonthlyPayouts: r.diagnostics.avgMonthlyPayouts,
    avgMonthlyRevenue: r.diagnostics.avgMonthlyRevenue,
    payoutsApprovedTotal: r.payoutDiagnostics.payoutsApprovedTotal,
    payoutsRequestedTotal: r.payoutDiagnostics.payoutRequestsTotal,
    approvalRate: r.payoutDiagnostics.payoutsApprovedTotal / Math.max(1, r.payoutDiagnostics.payoutRequestsTotal),
    avgPayoutSize: r.payoutDiagnostics.avgPayoutSize,
    avgPayoutsPerAccount: r.payoutDiagnostics.avgPayoutsPerAccount,
    firstPayoutCapBindingRate: r.payoutDiagnostics.firstPayoutCapBindingRate,
    lifetimeCapBindingRate: r.payoutDiagnostics.lifetimeCapBindingRate,
  };
}

describe('Audit Sweep: Profit Gate Validation', () => {
  it('compares payout frequency with and without profit gate at 12% and 14%', { timeout: 120_000 }, () => {
    const rows: AuditRow[] = [];

    for (const pr of [0.12, 0.14]) {
      // 1. Baseline: no gate
      rows.push(audit('No gate (80% split)', pr, withPassRate(pr)));

      // 2. Dev layer only (CB/fraud reduction, no gate)
      rows.push(audit('Dev layer only', pr, withDevLayer(withPassRate(pr))));

      // 3. Profit gate $300
      const withGate300 = withDevLayer(withPassRate(pr));
      rows.push(audit('Profit gate $300', pr, {
        ...withGate300,
        knobs: { ...withGate300.knobs, minProfitSinceLastPayout: 300 },
      }));

      // 4. Profit gate $150 (lighter)
      rows.push(audit('Profit gate $150', pr, {
        ...withGate300,
        knobs: { ...withGate300.knobs, minProfitSinceLastPayout: 150 },
      }));

      // 5. 1-month min between payouts (time gate, no profit gate)
      rows.push(audit('1mo min between payouts', pr, {
        ...withGate300,
        knobs: { ...withGate300.knobs, minMonthsBetweenPayouts: 1 },
      }));

      // 6. Profit gate $300 + 1mo verification
      rows.push(audit('Gate $300 + 1mo verify', pr, {
        ...withGate300,
        knobs: { ...withGate300.knobs, minProfitSinceLastPayout: 300, verificationMonths: 1, verificationFailRate: 0.10 },
      }));
    }

    // Output as structured table
    console.log('\n══════════════════════════════════════════════════════════════════');
    console.log('  AUDIT SWEEP: PAYOUT FREQUENCY DIAGNOSTICS');
    console.log('  300 iter × 12 months | seed: 42');
    console.log('══════════════════════════════════════════════════════════════════\n');

    for (const pr of [0.12, 0.14]) {
      const subset = rows.filter(r => r.passRate === pr);
      console.log(`\n── Pass Rate: ${(pr * 100).toFixed(0)}% ──\n`);
      console.log('  Variant                       | Margin | Profit/mo | Payouts/mo | Payout/Rev | Req→Approved | Avg Size | Payouts/Acct | 1st Cap Bind | LT Cap Bind');
      console.log('  ------------------------------|--------|-----------|------------|------------|--------------|----------|--------------|--------------|------------');

      for (const r of subset) {
        console.log(
          `  ${r.variant.padEnd(30)}| ${(r.margin * 100).toFixed(1).padStart(5)}% | ${('$' + Math.round(r.profitPerMonth)).padStart(9)} | ${('$' + Math.round(r.avgMonthlyPayouts)).padStart(10)} | ${(r.payoutToRevenue * 100).toFixed(1).padStart(8)}%  | ${(r.approvalRate * 100).toFixed(1).padStart(10)}%  | ${('$' + Math.round(r.avgPayoutSize)).padStart(8)} | ${r.avgPayoutsPerAccount.toFixed(2).padStart(12)} | ${(r.firstPayoutCapBindingRate * 100).toFixed(1).padStart(11)}% | ${(r.lifetimeCapBindingRate * 100).toFixed(1).padStart(10)}%`
        );
      }
    }

    // SANITY CHECK: How much does the profit gate reduce payout frequency?
    console.log('\n\n══════════════════════════════════════════════════════════════════');
    console.log('  SANITY CHECK: Payout Frequency Reduction');
    console.log('══════════════════════════════════════════════════════════════════\n');

    for (const pr of [0.12, 0.14]) {
      const subset = rows.filter(r => r.passRate === pr);
      const baseline = subset.find(r => r.variant === 'No gate (80% split)')!;
      const gate300 = subset.find(r => r.variant === 'Profit gate $300')!;
      const gate150 = subset.find(r => r.variant === 'Profit gate $150')!;
      const timegate = subset.find(r => r.variant === '1mo min between payouts')!;

      const reductionGate300 = 1 - (gate300.avgMonthlyPayouts / baseline.avgMonthlyPayouts);
      const reductionGate150 = 1 - (gate150.avgMonthlyPayouts / baseline.avgMonthlyPayouts);
      const reductionTime = 1 - (timegate.avgMonthlyPayouts / baseline.avgMonthlyPayouts);

      console.log(`  Pass Rate ${(pr * 100).toFixed(0)}%:`);
      console.log(`    Baseline payouts/mo:        $${Math.round(baseline.avgMonthlyPayouts)}`);
      console.log(`    Gate $300 payouts/mo:        $${Math.round(gate300.avgMonthlyPayouts)}  (${(reductionGate300 * 100).toFixed(1)}% reduction)`);
      console.log(`    Gate $150 payouts/mo:        $${Math.round(gate150.avgMonthlyPayouts)}  (${(reductionGate150 * 100).toFixed(1)}% reduction)`);
      console.log(`    1mo time gate payouts/mo:    $${Math.round(timegate.avgMonthlyPayouts)}  (${(reductionTime * 100).toFixed(1)}% reduction)`);

      // FLAG if reduction is >60% — that's suspiciously high
      if (reductionGate300 > 0.60) {
        console.log(`    🚨 WARNING: $300 gate reduces payouts by ${(reductionGate300 * 100).toFixed(0)}% — suspiciously high, may indicate modeling issue`);
      } else if (reductionGate300 > 0.40) {
        console.log(`    ⚠️  CAUTION: $300 gate reduces payouts by ${(reductionGate300 * 100).toFixed(0)}% — verify profit accumulation rate is realistic`);
      } else {
        console.log(`    ✅ $300 gate reduction looks plausible (${(reductionGate300 * 100).toFixed(0)}%)`);
      }
    }

    // JSON export for external validation
    console.log('\n\n══════════════════════════════════════════════════════════════════');
    console.log('  JSON EXPORT (paste into spreadsheet for review)');
    console.log('══════════════════════════════════════════════════════════════════\n');
    console.log(JSON.stringify(rows, null, 2));

    expect(rows.length).toBe(12);
    expect(rows.every(r => typeof r.margin === 'number')).toBe(true);
  });
});
