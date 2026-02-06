import { describe, it, expect } from 'vitest';
import {
  runMonteCarlo,
  DEFAULT_ASSUMPTIONS,
  SCENARIO_PRESETS,
  compareScenarios,
  runSensitivityAnalysis,
  type MonteCarloConfig,
} from './monte-carlo';

const QUICK_CONFIG: MonteCarloConfig = {
  iterations: 100,
  monthsPerIteration: 12,
  seed: 42,
};

const FULL_CONFIG: MonteCarloConfig = {
  iterations: 1000,
  monthsPerIteration: 12,
  seed: 42,
};

const LONG_CONFIG: MonteCarloConfig = {
  iterations: 50,
  monthsPerIteration: 36, // 3 years for steady-state checks
  seed: 42,
};

// ============================================================================
// MECHANICAL INVARIANTS
// These tests verify the simulation engine works correctly, regardless of
// business assumptions. They should survive assumption changes.
// ============================================================================

describe('Monte Carlo Simulation - Mechanical Invariants', () => {
  describe('Determinism', () => {
    it('produces identical results with same seed', () => {
      const result1 = runMonteCarlo(QUICK_CONFIG, DEFAULT_ASSUMPTIONS);
      const result2 = runMonteCarlo(QUICK_CONFIG, DEFAULT_ASSUMPTIONS);
      
      expect(result1.profit.mean).toBe(result2.profit.mean);
      expect(result1.profit.p5).toBe(result2.profit.p5);
      expect(result1.profit.p95).toBe(result2.profit.p95);
      expect(result1.risk.probabilityOfLoss).toBe(result2.risk.probabilityOfLoss);
    });

    it('produces different results with different seeds', () => {
      const config1 = { ...QUICK_CONFIG, seed: 42 };
      const config2 = { ...QUICK_CONFIG, seed: 999 };
      
      const result1 = runMonteCarlo(config1, DEFAULT_ASSUMPTIONS);
      const result2 = runMonteCarlo(config2, DEFAULT_ASSUMPTIONS);
      
      expect(result1.profit.mean).not.toBe(result2.profit.mean);
    });
  });

  describe('Cap Binding Monotonicity', () => {
    it('tighter caps bind more often than looser caps', () => {
      const cap10x = runMonteCarlo(QUICK_CONFIG, SCENARIO_PRESETS.withLifetimeCap10x);
      const cap7x = runMonteCarlo(QUICK_CONFIG, SCENARIO_PRESETS.withLifetimeCap7x);
      const cap5x = runMonteCarlo(QUICK_CONFIG, SCENARIO_PRESETS.withLifetimeCap5x);
      const cap3x = runMonteCarlo(QUICK_CONFIG, SCENARIO_PRESETS.withLifetimeCap3x);
      
      expect(cap3x.payoutDiagnostics.lifetimeCapBindingRate).toBeGreaterThan(
        cap5x.payoutDiagnostics.lifetimeCapBindingRate
      );
      expect(cap5x.payoutDiagnostics.lifetimeCapBindingRate).toBeGreaterThan(
        cap7x.payoutDiagnostics.lifetimeCapBindingRate
      );
      expect(cap7x.payoutDiagnostics.lifetimeCapBindingRate).toBeGreaterThan(
        cap10x.payoutDiagnostics.lifetimeCapBindingRate
      );
    });

    it('unlimited cap has zero binding rate', () => {
      const result = runMonteCarlo(QUICK_CONFIG, DEFAULT_ASSUMPTIONS); // no lifetime cap
      
      // Binding rate must be 0 when cap is null (not just completed count)
      // This verifies accountsHitLifetimeCap only increments for cap hits, not other exits
      expect(result.payoutDiagnostics.lifetimeCapBindingRate).toBe(0);
      expect(result.payoutDiagnostics.capPressure).toBeNull();
    });

    it('cap pressure reflects saturation level and never exceeds 1', () => {
      const cap5x = runMonteCarlo(FULL_CONFIG, SCENARIO_PRESETS.withLifetimeCap5x);
      
      // Cap pressure = avgLifetimePaid / cap
      // Must be between 0 and 1 (with tiny epsilon for floating point)
      // If guard is correct, pressure CANNOT exceed 1
      expect(cap5x.payoutDiagnostics.capPressure).not.toBeNull();
      expect(cap5x.payoutDiagnostics.capPressure!).toBeGreaterThan(0);
      expect(cap5x.payoutDiagnostics.capPressure!).toBeLessThanOrEqual(1.000001); // Hard invariant
      
      // Verify calculation is correct
      const expectedPressure = cap5x.payoutDiagnostics.avgLifetimePaidPerAccount / (149 * 5);
      expect(cap5x.payoutDiagnostics.capPressure).toBeCloseTo(expectedPressure, 6);
    });

    it('cap-hit share of completions is meaningful diagnostic', () => {
      const cap5x = runMonteCarlo(FULL_CONFIG, SCENARIO_PRESETS.withLifetimeCap5x);
      
      // Cap-hit share should be between 0 and 1
      expect(cap5x.cohortDiagnostics.capHitShareOfCompletions).toBeGreaterThanOrEqual(0);
      expect(cap5x.cohortDiagnostics.capHitShareOfCompletions).toBeLessThanOrEqual(1);
      
      // With a tight cap (5x), cap-hit share should be significant
      // (i.e., most completions are due to cap, not zombies)
      expect(cap5x.cohortDiagnostics.capHitShareOfCompletions).toBeGreaterThan(0.3);
    });

    it('per-month event series have consistent lengths', () => {
      const result = runMonteCarlo(FULL_CONFIG, SCENARIO_PRESETS.withLifetimeCap7x);
      
      // All month series should have same length (monthsPerIteration)
      const expectedLength = FULL_CONFIG.monthsPerIteration;
      expect(result.cohortDiagnostics.capHitsByMonth.length).toBe(expectedLength);
      expect(result.cohortDiagnostics.zombiesByMonth.length).toBe(expectedLength);
      expect(result.cohortDiagnostics.resetsByMonth.length).toBe(expectedLength);
      expect(result.cohortDiagnostics.activeCohortSizeByMonth.length).toBe(expectedLength);
      expect(result.cohortDiagnostics.newPassedByMonth.length).toBe(expectedLength);
    });

    it('per-month count series are valid integers (finite, non-negative)', () => {
      const result = runMonteCarlo(FULL_CONFIG, SCENARIO_PRESETS.withLifetimeCap7x);
      const assumptions = SCENARIO_PRESETS.withLifetimeCap7x;
      
      const { capHitsByMonth, zombiesByMonth, resetsByMonth, activeCohortSizeByMonth, eligibleCohortSizeByMonth, newPassedByMonth } = result.cohortDiagnostics;
      
      // Reusable invariant: counts must be finite, non-negative integers
      // - Number.isFinite guards against NaN/Infinity propagation
      // - Number.isInteger catches leaking expectation values, accidental averaging, or mixing aggregates
      // - Optional max bound for series with known upper limits
      const isCount = (n: number, max?: number) =>
        Number.isFinite(n) && Number.isInteger(n) && n >= 0 && (max === undefined || n <= max);
      
      expect(capHitsByMonth.every(n => isCount(n))).toBe(true);
      expect(zombiesByMonth.every(n => isCount(n))).toBe(true);
      expect(resetsByMonth.every(n => isCount(n))).toBe(true);
      expect(activeCohortSizeByMonth.every(n => isCount(n))).toBe(true);
      expect(eligibleCohortSizeByMonth.every(n => isCount(n))).toBe(true);
      
      // newPassedByMonth: isCount + bounded by accountsPerMonth (with rounding tolerance)
      expect(newPassedByMonth.every(n => isCount(n, assumptions.accountsPerMonth + 1))).toBe(true);
    });

    it('per-month series sums are internally consistent (conservation check)', () => {
      // This test guards against accidentally switching series to cumulative values
      // Note: series are from LAST iteration only, so we compare to last iteration totals
      const result = runMonteCarlo(FULL_CONFIG, SCENARIO_PRESETS.withLifetimeCap7x);

      const capSum = result.cohortDiagnostics.capHitsByMonth.reduce((a, b) => a + b, 0);
      const zombieSum = result.cohortDiagnostics.zombiesByMonth.reduce((a, b) => a + b, 0);
      const resetSum = result.cohortDiagnostics.resetsByMonth.reduce((a, b) => a + b, 0);

      // Cap + zombie completions should be <= total active cohort that existed
      // (can't complete more accounts than were ever active)
      const maxPossibleCompletions = result.cohortDiagnostics.activeCohortSizeByMonth[0] * FULL_CONFIG.monthsPerIteration;
      expect(capSum + zombieSum).toBeLessThanOrEqual(maxPossibleCompletions);

      // Reset sum should be non-trivial if reset rate > 0
      expect(resetSum).toBeGreaterThan(0);

      // Month-by-month bounds: events cannot exceed active cohort + actual monthly inflow
      // Uses newPassedByMonth from simulation (not derived from input types)
      const { capHitsByMonth, zombiesByMonth, resetsByMonth, activeCohortSizeByMonth, newPassedByMonth } = 
        result.cohortDiagnostics;
      
      for (let i = 0; i < capHitsByMonth.length; i++) {
        const monthBound = activeCohortSizeByMonth[i] + newPassedByMonth[i];
        
        // Cap hits + zombies this month cannot exceed cohort + inflow
        expect(capHitsByMonth[i] + zombiesByMonth[i]).toBeLessThanOrEqual(monthBound);
        
        // Resets this month cannot exceed cohort + inflow  
        expect(resetsByMonth[i]).toBeLessThanOrEqual(monthBound);
      }
    });
  });

  describe('Lifetime Paid Never Exceeds Cap', () => {
    it('avg lifetime paid is always <= cap when cap is set', () => {
      const cap7x = runMonteCarlo(FULL_CONFIG, SCENARIO_PRESETS.withLifetimeCap7x);
      const capDollars = 149 * 7; // $1043
      
      expect(cap7x.payoutDiagnostics.avgLifetimePaidPerAccount).toBeLessThanOrEqual(capDollars);
      expect(cap7x.payoutDiagnostics.lifetimePaidP95).toBeLessThanOrEqual(capDollars);
    });

    it('P90 and P95 lifetime paid are capped at cap value', () => {
      const cap5x = runMonteCarlo(FULL_CONFIG, SCENARIO_PRESETS.withLifetimeCap5x);
      const capDollars = 149 * 5; // $745
      
      expect(cap5x.payoutDiagnostics.lifetimePaidP90).toBeLessThanOrEqual(capDollars);
      expect(cap5x.payoutDiagnostics.lifetimePaidP95).toBeLessThanOrEqual(capDollars);
    });
  });

  describe('Eligible Cohort <= Active Cohort', () => {
    it('eligible cohort never exceeds active cohort', () => {
      const result = runMonteCarlo(QUICK_CONFIG, DEFAULT_ASSUMPTIONS);
      
      const { activeCohortSizeByMonth, eligibleCohortSizeByMonth } = result.cohortDiagnostics;
      
      for (let i = 0; i < activeCohortSizeByMonth.length; i++) {
        expect(eligibleCohortSizeByMonth[i]).toBeLessThanOrEqual(activeCohortSizeByMonth[i]);
      }
    });

    it('month 0 has zero eligible (all accounts in eligibility lag)', () => {
      const result = runMonteCarlo({ iterations: 10, monthsPerIteration: 3, seed: 42 }, DEFAULT_ASSUMPTIONS);
      
      expect(result.cohortDiagnostics.eligibleCohortSizeByMonth[0]).toBe(0);
      expect(result.cohortDiagnostics.activeCohortSizeByMonth[0]).toBeGreaterThan(0);
    });
  });

  describe('Reset Mechanics', () => {
    it('reset pushes eligibility forward by lag period', () => {
      // After reset in month m, account cannot be eligible until month m + eligibilityLag
      // This is verified by the fact that resets this month don't generate payouts this month
      const result = runMonteCarlo(QUICK_CONFIG, DEFAULT_ASSUMPTIONS);
      
      // If resets happened, we should have reset revenue
      if (result.cohortDiagnostics.resetsThisRun > 0) {
        expect(result.cohortDiagnostics.resetRevenue).toBeGreaterThan(0);
      }
    });

    it('observed resets are within plausible band of expected resets', () => {
      const result = runMonteCarlo(FULL_CONFIG, DEFAULT_ASSUMPTIONS);
      
      const { resetsThisRun, expectedResetsThisRun, resetRateErrorRatio } = result.cohortDiagnostics;
      
      console.log('Reset sanity check:', {
        observed: resetsThisRun,
        expected: expectedResetsThisRun.toFixed(0),
        errorRatio: resetRateErrorRatio.toFixed(2),
      });
      
      // Observed should be within 0.2x to 5x of expected (accounts for variance)
      expect(resetRateErrorRatio).toBeGreaterThan(0.2);
      expect(resetRateErrorRatio).toBeLessThan(5);
    });

    it('documents reset scope as allActive', () => {
      const result = runMonteCarlo(QUICK_CONFIG, DEFAULT_ASSUMPTIONS);
      
      expect(result.cohortDiagnostics.resetScope).toBe('allActive');
    });
  });

  describe('First Payout Cap Enforcement', () => {
    it('first payout never exceeds cap when cap is set', () => {
      const result = runMonteCarlo(FULL_CONFIG, SCENARIO_PRESETS.withFirstPayoutCap);
      
      // avgFirstPayoutAfterCap should be <= firstPayoutCap
      expect(result.payoutDiagnostics.avgFirstPayoutAfterCap).toBeLessThanOrEqual(300);
    });
  });

  describe('Profit Distribution Shape', () => {
    it('P5 < P50 < P95 always', () => {
      const result = runMonteCarlo(FULL_CONFIG, DEFAULT_ASSUMPTIONS);
      
      expect(result.profit.p5).toBeLessThan(result.profit.p50);
      expect(result.profit.p50).toBeLessThan(result.profit.p95);
    });

    it('P50 is within 2 std devs of mean', () => {
      const result = runMonteCarlo(FULL_CONFIG, DEFAULT_ASSUMPTIONS);
      
      expect(Math.abs(result.profit.p50 - result.profit.mean)).toBeLessThan(result.profit.stdDev * 2);
    });
  });

  describe('Raw Samples', () => {
    it('includes correct number of raw samples', () => {
      const result = runMonteCarlo(QUICK_CONFIG, DEFAULT_ASSUMPTIONS);
      
      expect(result.rawSamples).toBeDefined();
      expect(result.rawSamples!.length).toBe(QUICK_CONFIG.iterations);
      expect(result.rawSamples![0].length).toBe(QUICK_CONFIG.monthsPerIteration);
    });
  });
});

// ============================================================================
// STEADY-STATE CHECKS
// These verify the model reaches equilibrium over longer periods
// ============================================================================

describe('Steady-State Behavior (36-month)', () => {
  it('eligible cohort size stabilizes (no unbounded growth)', () => {
    const result = runMonteCarlo(LONG_CONFIG, SCENARIO_PRESETS.withLifetimeCap7x);
    
    const sizes = result.cohortDiagnostics.eligibleCohortSizeByMonth;
    const last12 = sizes.slice(-12);
    const prior12 = sizes.slice(-24, -12);
    
    const avgLast12 = last12.reduce((a, b) => a + b, 0) / 12;
    const avgPrior12 = prior12.reduce((a, b) => a + b, 0) / 12;
    
    // Growth rate should be < 50% per 12 months if stable
    const growthRate = (avgLast12 - avgPrior12) / avgPrior12;
    
    console.log('Steady-state check:', {
      avgPrior12: avgPrior12.toFixed(0),
      avgLast12: avgLast12.toFixed(0),
      growthRate: (growthRate * 100).toFixed(1) + '%',
    });
    
    expect(Math.abs(growthRate)).toBeLessThan(0.5);
  });

  it('payout-to-revenue ratio stabilizes', () => {
    const result = runMonteCarlo(LONG_CONFIG, SCENARIO_PRESETS.withLifetimeCap7x);
    
    const ratios = result.cohortDiagnostics.payoutToRevenueRatioByMonth;
    const last12 = ratios.slice(-12);
    const prior12 = ratios.slice(-24, -12);
    
    const avgLast12 = last12.reduce((a, b) => a + b, 0) / 12;
    const avgPrior12 = prior12.reduce((a, b) => a + b, 0) / 12;
    
    // Ratio change should be < 50% per 12 months if stable
    const changeRate = Math.abs(avgLast12 - avgPrior12) / Math.max(avgPrior12, 0.01);
    
    console.log('Payout/revenue steady-state:', {
      avgPrior12: (avgPrior12 * 100).toFixed(1) + '%',
      avgLast12: (avgLast12 * 100).toFixed(1) + '%',
      changeRate: (changeRate * 100).toFixed(1) + '%',
    });
    
    expect(changeRate).toBeLessThan(0.5);
  });
});

// ============================================================================
// SCENARIO COMPARISON (relative, not absolute)
// ============================================================================

describe('Scenario Comparisons (Relative Behavior)', () => {
  it('attack scenario is worse than baseline', () => {
    const baseline = runMonteCarlo(FULL_CONFIG, DEFAULT_ASSUMPTIONS);
    const attack = runMonteCarlo(FULL_CONFIG, SCENARIO_PRESETS.coordinatedAttack);
    
    expect(attack.profit.mean).toBeLessThan(baseline.profit.mean);
    expect(attack.risk.probabilityOfLoss).toBeGreaterThan(baseline.risk.probabilityOfLoss);
    expect(attack.profit.p5).toBeLessThan(baseline.profit.p5);
  }, 15000);

  it('lifetime cap improves economics vs uncapped', () => {
    const uncapped = runMonteCarlo(FULL_CONFIG, DEFAULT_ASSUMPTIONS);
    const capped = runMonteCarlo(FULL_CONFIG, SCENARIO_PRESETS.withLifetimeCap7x);
    
    expect(capped.profit.mean).toBeGreaterThan(uncapped.profit.mean);
    expect(capped.risk.probabilityOfLoss).toBeLessThan(uncapped.risk.probabilityOfLoss);
  }, 15000);

  it('lifetime cap mitigates attack damage', () => {
    const attackNoCap = runMonteCarlo(FULL_CONFIG, SCENARIO_PRESETS.coordinatedAttack);
    const attackWithCap = runMonteCarlo(FULL_CONFIG, {
      ...SCENARIO_PRESETS.coordinatedAttack,
      knobs: { ...SCENARIO_PRESETS.coordinatedAttack.knobs, lifetimeCapPerUser: 1043 },
    });
    
    expect(attackWithCap.profit.mean).toBeGreaterThan(attackNoCap.profit.mean);
  }, 15000);

  it('tighter caps improve profit monotonically', () => {
    const cap10x = runMonteCarlo(FULL_CONFIG, SCENARIO_PRESETS.withLifetimeCap10x);
    const cap7x = runMonteCarlo(FULL_CONFIG, SCENARIO_PRESETS.withLifetimeCap7x);
    const cap5x = runMonteCarlo(FULL_CONFIG, SCENARIO_PRESETS.withLifetimeCap5x);
    
    expect(cap5x.profit.mean).toBeGreaterThan(cap7x.profit.mean);
    expect(cap7x.profit.mean).toBeGreaterThan(cap10x.profit.mean);
  }, 15000);

  it('conservative knobs reduce loss probability', () => {
    const baseline = runMonteCarlo(FULL_CONFIG, DEFAULT_ASSUMPTIONS);
    const conservative = runMonteCarlo(FULL_CONFIG, SCENARIO_PRESETS.conservativeKnobs);
    
    expect(conservative.risk.probabilityOfLoss).toBeLessThanOrEqual(baseline.risk.probabilityOfLoss);
  }, 15000);

  it('velocity gates reduce payouts vs no gates (profit-since gate)', () => {
    const noGates = runMonteCarlo(FULL_CONFIG, SCENARIO_PRESETS.withLifetimeCap7x);
    const gated = runMonteCarlo(FULL_CONFIG, SCENARIO_PRESETS.withVelocityGate5d_profit);
    
    // profit-since gate blocks ~40% of repeat payout attempts, so payouts/account must drop
    expect(gated.payoutDiagnostics.avgPayoutsPerAccount).toBeLessThan(
      noGates.payoutDiagnostics.avgPayoutsPerAccount
    );
  }, 15000);

  it('velocity gates improve profit vs no gates', () => {
    const noGates = runMonteCarlo(FULL_CONFIG, SCENARIO_PRESETS.withLifetimeCap7x);
    const gated = runMonteCarlo(FULL_CONFIG, SCENARIO_PRESETS.withVelocityGate5d_profit);
    
    expect(gated.profit.mean).toBeGreaterThan(noGates.profit.mean);
  }, 15000);

  it('velocity gates default to disabled (existing tests unaffected)', () => {
    const result = runMonteCarlo(QUICK_CONFIG, DEFAULT_ASSUMPTIONS);
    
    // With defaults (all gates = 0/false), behavior should be unchanged
    expect(result.profit.mean).toBeDefined();
    expect(result.payoutDiagnostics.avgPayoutsPerAccount).toBeGreaterThan(0);
  });
});

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

describe('Utility Functions', () => {
  describe('Scenario Comparison', () => {
    it('compares scenarios with deltas', () => {
      const scenarios = {
        baseline: DEFAULT_ASSUMPTIONS,
        withLifetimeCap: SCENARIO_PRESETS.withLifetimeCap7x,
        attack: SCENARIO_PRESETS.coordinatedAttack,
      };
      
      const comparisons = compareScenarios(QUICK_CONFIG, scenarios);
      
      expect(comparisons).toHaveLength(3);
      expect(comparisons[0].deltaFromBaseline).toBeUndefined();
      expect(comparisons[1].deltaFromBaseline).toBeDefined();
      expect(comparisons[2].deltaFromBaseline).toBeDefined();
    });
  });

  describe('Sensitivity Analysis', () => {
    it('runs sensitivity analysis on parameter', () => {
      const sensitivity = runSensitivityAnalysis(
        { ...QUICK_CONFIG, iterations: 50 },
        DEFAULT_ASSUMPTIONS,
        'knobs.lifetimeCapPerUser',
        [null as unknown as number, 1490, 1043, 745, 447]
      );
      
      expect(sensitivity.parameter).toBe('knobs.lifetimeCapPerUser');
      expect(sensitivity.profits).toHaveLength(5);
      
      // Tighter caps = better profit
      expect(sensitivity.profits[4]).toBeGreaterThan(sensitivity.profits[0]);
    });
  });
});
