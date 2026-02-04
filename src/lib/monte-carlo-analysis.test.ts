/**
 * First Payout Cap Sensitivity Analysis Tests
 * 
 * Runs the full analysis and outputs results for decision-making.
 */

import { describe, it, expect } from 'vitest';
import { analyzeFirstPayoutCap, formatAnalysisReport } from './monte-carlo-analysis';

describe('First Payout Cap Sensitivity Analysis', () => {
  it('runs full cap analysis and outputs report', () => {
    const summary = analyzeFirstPayoutCap();
    
    // Print the full report
    console.log('\n' + formatAnalysisReport(summary));
    
    // Validate structure
    expect(summary.results.length).toBeGreaterThan(0);
    expect(summary.recommendation).toBeDefined();
    expect(summary.recommendation.optimalCap).toBeDefined();
  }, 120000);

  it('validates that caps reduce attack exposure', () => {
    const summary = analyzeFirstPayoutCap();
    
    const noCap = summary.results.find(r => r.cap === null)!;
    const cap300 = summary.results.find(r => r.cap === 300)!;
    
    // $300 cap should reduce attack loss probability
    expect(cap300.coordinatedAttack.lossProb).toBeLessThanOrEqual(noCap.coordinatedAttack.lossProb);
    
    // $300 cap should reduce attack drawdown
    expect(cap300.coordinatedAttack.maxDrawdown).toBeLessThanOrEqual(noCap.coordinatedAttack.maxDrawdown);
    
    // Baseline should still be profitable
    expect(cap300.baseline.meanProfit).toBeGreaterThan(0);
  }, 120000);

  it('validates optimal cap retains sufficient baseline profit', () => {
    const summary = analyzeFirstPayoutCap();
    
    // Optimal cap must retain at least 85% of baseline mean
    expect(summary.recommendation.metrics.baselineMeanRetained).toBeGreaterThanOrEqual(85);
  }, 120000);

  it('compares cap values for detailed analysis', () => {
    const summary = analyzeFirstPayoutCap();
    
    // Log individual comparisons
    console.log('\n--- CAP VALUE COMPARISON ---\n');
    
    for (const result of summary.results) {
      if (result.cap === null) continue;
      
      console.log(`$${result.cap} Cap:`);
      console.log(`  Baseline Mean Delta: ${result.vsNoCap.baselineMeanDelta.toFixed(2)}%`);
      console.log(`  Baseline P5 Delta: ${result.vsNoCap.baselineP5Delta.toFixed(2)}%`);
      console.log(`  Attack Loss Prob Delta: ${(result.vsNoCap.attackLossProbDelta * 100).toFixed(2)} pp`);
      console.log(`  Attack Drawdown Delta: $${Math.round(result.vsNoCap.attackDrawdownDelta).toLocaleString()}`);
      console.log('');
    }
    
    expect(true).toBe(true); // Log output test
  }, 120000);
});
