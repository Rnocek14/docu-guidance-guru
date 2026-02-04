/**
 * Lifetime Payout Cap Sensitivity Analysis Tests
 * 
 * Runs the full analysis and outputs results for decision-making.
 */

import { describe, it, expect } from 'vitest';
import {
  analyzeLifetimeCaps,
  formatLifetimeCapReport,
  designTierLadder,
  formatTierLadder,
  LOCKED_PRICING,
} from './lifetime-cap-analysis';

describe('Lifetime Payout Cap Sensitivity Analysis', () => {
  it('runs full lifetime cap analysis and outputs report', () => {
    const summary = analyzeLifetimeCaps();
    
    // Print the full report
    console.log('\n' + formatLifetimeCapReport(summary));
    
    // Validate structure
    expect(summary.results.length).toBeGreaterThan(0);
    expect(summary.recommendation).toBeDefined();
    expect(summary.recommendation.optimalMultiple).toBeDefined();
    expect(summary.comparisonTable.length).toBeGreaterThan(0);
  }, 180000);  // Allow 3 minutes for full analysis

  it('validates locked-in pricing is used', () => {
    const summary = analyzeLifetimeCaps();
    
    expect(summary.pricing.entryFee).toBe(149);
    expect(summary.pricing.resetFee).toBe(99);
    expect(summary.pricing.firstPayoutCap).toBe(300);
    expect(summary.pricing.payoutSplitPercent).toBe(80);
    expect(summary.pricing.accountSizes).toEqual([50000, 100000]);
  }, 30000);

  it('validates cap multiples have bounded exposure', () => {
    const summary = analyzeLifetimeCaps();
    
    // Unlimited should have infinite exposure
    const unlimited = summary.results.find(r => r.capMultiple === null)!;
    expect(unlimited.riskProfile.maxExposurePerAccount).toBe(Infinity);
    expect(unlimited.riskProfile.fraudSurfaceScore).toBe(100);
    
    // 5x cap should have $745 exposure
    const fiveX = summary.results.find(r => r.capMultiple === 5)!;
    expect(fiveX.capDollars).toBe(149 * 5);  // $745
    expect(fiveX.riskProfile.maxExposurePerAccount).toBe(745);
    expect(fiveX.riskProfile.fraudSurfaceScore).toBeLessThan(100);
  }, 180000);

  it('validates optimal cap retains sufficient margin', () => {
    const summary = analyzeLifetimeCaps();
    
    // Optimal cap must retain at least 85% of margin
    expect(summary.recommendation.metrics.marginPreserved).toBeGreaterThanOrEqual(85);
  }, 180000);

  it('designs tier ladder based on optimal cap', () => {
    const summary = analyzeLifetimeCaps();
    
    if (summary.recommendation.optimalMultiple) {
      const tiers = designTierLadder(summary.recommendation.optimalMultiple);
      
      console.log('\n' + formatTierLadder(tiers));
      
      // Validate tier structure
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
  }, 180000);

  it('compares cap values for detailed analysis', () => {
    const summary = analyzeLifetimeCaps();
    
    console.log('\n--- LIFETIME CAP COMPARISON ---\n');
    
    for (const result of summary.results) {
      console.log(`${result.capLabel}:`);
      console.log(`  Cap Dollars: ${result.capDollars ? `$${result.capDollars}` : 'Unlimited'}`);
      console.log(`  Aggregated Mean: $${(result.aggregated.meanProfit / 1000).toFixed(1)}k`);
      console.log(`  Aggregated P5: $${(result.aggregated.p5Profit / 1000).toFixed(1)}k`);
      console.log(`  Loss Probability: ${(result.aggregated.lossProb * 100).toFixed(1)}%`);
      console.log(`  Fraud Surface Score: ${result.riskProfile.fraudSurfaceScore}/100`);
      console.log(`  Payouts to Cap: ${result.riskProfile.breakevenPayouts === Infinity ? '∞' : result.riskProfile.breakevenPayouts}`);
      console.log('');
    }
    
    expect(true).toBe(true);  // Log output test
  }, 180000);
});
