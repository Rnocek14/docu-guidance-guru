/**
 * Test file to run 6-month slow growth simulation
 */

import { describe, it, expect } from 'vitest';
import { runSlowGrowthSimulation, formatSlowGrowthReport } from './slow-growth-simulation';

describe('6-Month Slow Growth Simulation', () => {
  it('should run simulation and produce valid results', () => {
    const result = runSlowGrowthSimulation();
    
    // Basic sanity checks
    expect(result.config.monthsPerIteration).toBe(6);
    expect(result.summary.totalProfit6Mo).toBeDefined();
    expect(typeof result.summary.monthlyProfitMean).toBe('number');
    expect(result.breakdown.effectiveMargin).toBeLessThanOrEqual(1);
    expect(result.breakdown.effectiveMargin).toBeGreaterThanOrEqual(-1);
    
    // Log the report for visibility
    console.log('\n' + formatSlowGrowthReport());
  });
});
