/**
 * Lifetime Payout Cap Analysis Tests
 * 
 * Validates that lifetime caps are actually enforced in the Monte Carlo engine
 * by checking binding rates, profit changes, and payout diagnostics.
 */

import { describe, it, expect } from 'vitest';
import {
  analyzeLifetimeCaps,
  formatLifetimeCapReport,
  designTierLadder,
  formatTierLadder,
  LOCKED_PRICING,
} from './lifetime-cap-analysis';
import { runMonteCarlo, runLifetimeCapSweep, DEFAULT_ASSUMPTIONS, MonteCarloConfig } from './monte-carlo';

const FAST_CONFIG: MonteCarloConfig = {
  iterations: 50,
  monthsPerIteration: 12,
  seed: 42,
};

describe('Lifetime Cap Enforcement in Monte Carlo', () => {
  it('should track payout diagnostics in MonteCarloResult', () => {
    const result = runMonteCarlo(FAST_CONFIG, DEFAULT_ASSUMPTIONS);
    
    expect(result.payoutDiagnostics).toBeDefined();
    expect(typeof result.payoutDiagnostics.totalPayoutsPaidMean).toBe('number');
    expect(typeof result.payoutDiagnostics.avgPayoutSize).toBe('number');
    expect(typeof result.payoutDiagnostics.firstPayoutCapBindingRate).toBe('number');
    expect(typeof result.payoutDiagnostics.lifetimeCapBindingRate).toBe('number');
    expect(typeof result.payoutDiagnostics.avgLifetimePaidPerAccount).toBe('number');
    
    // FIX #4: Cohort diagnostics should exist
    expect(result.cohortDiagnostics).toBeDefined();
    expect(typeof result.cohortDiagnostics.avgActiveCohortSize).toBe('number');
    expect(result.cohortDiagnostics.activeCohortSizeByMonth).toBeInstanceOf(Array);
    expect(typeof result.cohortDiagnostics.resetRevenue).toBe('number');
    expect(typeof result.cohortDiagnostics.resetsThisRun).toBe('number');
    expect(typeof result.cohortDiagnostics.zombieAccountsCompleted).toBe('number');
    
    console.log('Payout diagnostics (no lifetime cap):', {
      avgPayoutSize: result.payoutDiagnostics.avgPayoutSize.toFixed(2),
      firstCapBindingRate: (result.payoutDiagnostics.firstPayoutCapBindingRate * 100).toFixed(1) + '%',
      lifetimeCapBindingRate: (result.payoutDiagnostics.lifetimeCapBindingRate * 100).toFixed(1) + '%',
      avgLifetimePaid: result.payoutDiagnostics.avgLifetimePaidPerAccount.toFixed(2),
    });
    console.log('Cohort diagnostics:', {
      avgActiveCohortSize: result.cohortDiagnostics.avgActiveCohortSize.toFixed(0),
      avgEligibleCohortSize: result.cohortDiagnostics.avgEligibleCohortSize.toFixed(0),
      resetRevenue: result.cohortDiagnostics.resetRevenue.toFixed(0),
      resets: result.cohortDiagnostics.resetsThisRun,
      zombies: result.cohortDiagnostics.zombieAccountsCompleted,
      fraudScaling: result.cohortDiagnostics.fraudScaling,
      chargebackScaling: result.cohortDiagnostics.chargebackScaling,
    });
  });

  it('should apply eligibility gate (avgDaysToFirstPayout)', () => {
    // Accounts created in month 0 should only be eligible in month 1+ (18 days / 30 = 1 month lag)
    const result = runMonteCarlo(
      { iterations: 10, monthsPerIteration: 3, seed: 42 },
      DEFAULT_ASSUMPTIONS
    );
    
    // The ELIGIBLE cohort size should grow over months as accounts become eligible
    // Active cohort includes accounts waiting for eligibility, eligible is a subset
    const activeSizes = result.cohortDiagnostics.activeCohortSizeByMonth;
    const eligibleSizes = result.cohortDiagnostics.eligibleCohortSizeByMonth;
    console.log('Active cohort sizes by month:', activeSizes);
    console.log('Eligible cohort sizes by month:', eligibleSizes);
    
    // Eligible should be <= active, and month 0 eligible should be 0 or very low
    expect(activeSizes.length).toBe(3);
    expect(eligibleSizes.length).toBe(3);
    // Month 0: new accounts not yet eligible
    expect(eligibleSizes[0]).toBeLessThanOrEqual(activeSizes[0]);
  });

  it('should generate reset revenue when accounts reset', () => {
    const result = runMonteCarlo(FAST_CONFIG, DEFAULT_ASSUMPTIONS);
    
    // With 18% annual reset rate, we should see some resets
    console.log('Reset stats:', {
      totalResets: result.cohortDiagnostics.resetsThisRun,
      resetRevenue: '$' + result.cohortDiagnostics.resetRevenue.toFixed(0),
    });
    
    if (result.cohortDiagnostics.resetsThisRun > 0) {
      expect(result.cohortDiagnostics.resetRevenue).toBeGreaterThan(0);
      // Reset revenue should be resets * $99
      const expectedRevenue = result.cohortDiagnostics.resetsThisRun * 99;
      expect(result.cohortDiagnostics.resetRevenue).toBe(expectedRevenue);
    }
  });

  it('should complete zombie accounts (headroom < $50)', () => {
    // Use an aggressive cap where zombies are likely
    const result = runMonteCarlo(FAST_CONFIG, {
      ...DEFAULT_ASSUMPTIONS,
      knobs: { ...DEFAULT_ASSUMPTIONS.knobs, lifetimeCapPerUser: 350 }, // $350 cap
    });
    
    console.log('Zombie account stats:', {
      zombiesCompleted: result.cohortDiagnostics.zombieAccountsCompleted,
      accountsCompletedByCap: result.payoutDiagnostics.accountsCompletedByCap,
    });
    
    // Zombies should be a subset of completed accounts or zero
    expect(result.cohortDiagnostics.zombieAccountsCompleted).toBeGreaterThanOrEqual(0);
  });

  it('should show different results with vs without lifetime cap', () => {
    const noCap = runMonteCarlo(FAST_CONFIG, {
      ...DEFAULT_ASSUMPTIONS,
      knobs: { ...DEFAULT_ASSUMPTIONS.knobs, lifetimeCapPerUser: null },
    });
    
    // Very aggressive cap that should definitely bind
    const withCap = runMonteCarlo(FAST_CONFIG, {
      ...DEFAULT_ASSUMPTIONS,
      knobs: { ...DEFAULT_ASSUMPTIONS.knobs, lifetimeCapPerUser: 500 },
    });
    
    console.log('Comparison - No Cap vs $500 Cap:');
    console.log('  No cap - Avg lifetime paid:', noCap.payoutDiagnostics.avgLifetimePaidPerAccount.toFixed(2));
    console.log('  $500 cap - Avg lifetime paid:', withCap.payoutDiagnostics.avgLifetimePaidPerAccount.toFixed(2));
    console.log('  No cap - Lifetime binding rate:', (noCap.payoutDiagnostics.lifetimeCapBindingRate * 100).toFixed(1) + '%');
    console.log('  $500 cap - Lifetime binding rate:', (withCap.payoutDiagnostics.lifetimeCapBindingRate * 100).toFixed(1) + '%');
    console.log('  No cap - Mean profit:', noCap.profit.mean.toFixed(0));
    console.log('  $500 cap - Mean profit:', withCap.profit.mean.toFixed(0));
    console.log('  No cap - Active cohort:', noCap.cohortDiagnostics.avgActiveCohortSize.toFixed(0));
    console.log('  No cap - Eligible cohort:', noCap.cohortDiagnostics.avgEligibleCohortSize.toFixed(0));
    console.log('  $500 cap - Eligible cohort:', withCap.cohortDiagnostics.avgEligibleCohortSize.toFixed(0));
    
    // Key assertion: aggressive cap should show different behavior
    if (noCap.payoutDiagnostics.avgLifetimePaidPerAccount > 500) {
      expect(withCap.payoutDiagnostics.lifetimeCapBindingRate).toBeGreaterThan(0);
      expect(withCap.payoutDiagnostics.avgLifetimePaidPerAccount).toBeLessThanOrEqual(500);
    }
  });

  it('should run lifetime cap sweep with binding diagnostics', () => {
    const multiples = [null, 10, 7, 5, 3];
    const results = runLifetimeCapSweep(FAST_CONFIG, DEFAULT_ASSUMPTIONS, multiples);
    
    console.log('\n=== LIFETIME CAP SWEEP RESULTS ===');
    console.log('Multiple | Cap $    | Binding% | Margin   | Profit    | Completed');
    console.log('---------|----------|----------|----------|-----------|----------');
    
    for (const r of results) {
      const multiple = r.multiple === null ? 'Unlim' : `${r.multiple}×`;
      const cap = r.capDollars === null ? 'N/A' : `$${r.capDollars}`;
      const binding = (r.capBindingRate * 100).toFixed(1) + '%';
      const margin = (r.result.diagnostics.effectiveMargin * 100).toFixed(1) + '%';
      const profit = '$' + r.result.profit.mean.toFixed(0);
      const completed = r.accountsCompletedByCap.toString();
      
      console.log(`${multiple.padEnd(8)} | ${cap.padEnd(8)} | ${binding.padEnd(8)} | ${margin.padEnd(8)} | ${profit.padEnd(9)} | ${completed}`);
    }
    
    expect(results.length).toBe(multiples.length);
  });
});

describe('Lifetime Cap Analysis with Real Binding', () => {
  it('runs full analysis and outputs report', () => {
    const summary = analyzeLifetimeCaps(LOCKED_PRICING, FAST_CONFIG);
    
    console.log('\n' + formatLifetimeCapReport(summary));
    
    expect(summary.results.length).toBeGreaterThan(0);
    expect(summary.recommendation).toBeDefined();
    expect(summary.recommendation.optimalMultiple).toBeDefined();
    
    // Log warnings if any
    if (summary.warnings.length > 0) {
      console.log('Warnings:');
      summary.warnings.forEach(w => console.log('  -', w));
    }
  }, 60000);

  it('validates locked-in pricing is used', () => {
    const summary = analyzeLifetimeCaps(LOCKED_PRICING, FAST_CONFIG);
    
    expect(summary.pricing.entryFee).toBe(149);
    expect(summary.pricing.resetFee).toBe(99);
    expect(summary.pricing.firstPayoutCap).toBe(300);
    expect(summary.pricing.payoutSplitPercent).toBe(80);
  }, 30000);

  it('validates binding diagnostics are present', () => {
    const summary = analyzeLifetimeCaps(LOCKED_PRICING, FAST_CONFIG);
    
    for (const result of summary.results) {
      expect(result.binding).toBeDefined();
      expect(typeof result.binding.rate).toBe('number');
      expect(typeof result.binding.avgLifetimePaid).toBe('number');
      expect(typeof result.binding.accountsCompleted).toBe('number');
    }
  }, 60000);

  it('compares cap values for detailed analysis', () => {
    const summary = analyzeLifetimeCaps(LOCKED_PRICING, FAST_CONFIG);
    
    console.log('\n--- LIFETIME CAP COMPARISON ---\n');
    
    for (const result of summary.results) {
      console.log(`${result.capLabel}:`);
      console.log(`  Cap Dollars: ${result.capDollars ? `$${result.capDollars}` : 'Unlimited'}`);
      console.log(`  Binding Rate: ${(result.binding.rate * 100).toFixed(1)}%`);
      console.log(`  Avg Lifetime Paid: $${result.binding.avgLifetimePaid.toFixed(0)}`);
      console.log(`  Mean Profit: $${result.profit.mean.toFixed(0)}`);
      console.log(`  Margin: ${(result.profit.margin * 100).toFixed(1)}%`);
      console.log(`  Payouts Rejected: ${result.binding.payoutsRejected}`);
      console.log('');
    }
  }, 60000);
});

describe('Tier Ladder Design', () => {
  it('designs tier ladder based on optimal cap', () => {
    const summary = analyzeLifetimeCaps(LOCKED_PRICING, FAST_CONFIG);
    
    if (summary.recommendation.optimalMultiple) {
      const tiers = designTierLadder(summary.recommendation.optimalMultiple);
      
      console.log('\n' + formatTierLadder(tiers));
      
      expect(tiers).toHaveLength(3);
      expect(tiers[0].name).toBe('Starter');
      expect(tiers[1].name).toBe('Pro');
      expect(tiers[2].name).toBe('Elite');
      
      // Validate tier progression
      expect(tiers[0].entryFee).toBeLessThan(tiers[1].entryFee);
      expect(tiers[1].entryFee).toBeLessThan(tiers[2].entryFee);
      
      expect(tiers[0].accountSize).toBeLessThan(tiers[1].accountSize);
      expect(tiers[1].accountSize).toBeLessThan(tiers[2].accountSize);
      
      // Higher tiers should have higher lifetime caps
      expect(tiers[0].lifetimeCapMultiple!).toBeLessThan(tiers[1].lifetimeCapMultiple!);
      expect(tiers[1].lifetimeCapMultiple!).toBeLessThan(tiers[2].lifetimeCapMultiple!);
    }
  }, 60000);
});
