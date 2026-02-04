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
    
    console.log('Payout diagnostics (no lifetime cap):', {
      avgPayoutSize: result.payoutDiagnostics.avgPayoutSize.toFixed(2),
      firstCapBindingRate: (result.payoutDiagnostics.firstPayoutCapBindingRate * 100).toFixed(1) + '%',
      lifetimeCapBindingRate: (result.payoutDiagnostics.lifetimeCapBindingRate * 100).toFixed(1) + '%',
      avgLifetimePaid: result.payoutDiagnostics.avgLifetimePaidPerAccount.toFixed(2),
    });
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
