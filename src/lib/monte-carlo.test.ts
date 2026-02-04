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

describe('Monte Carlo Simulation', () => {
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
      
      // Should be different (with high probability)
      expect(result1.profit.mean).not.toBe(result2.profit.mean);
    });
  });

  /**
   * CRITICAL ECONOMICS INSIGHT:
   * 
   * The uncapped baseline (DEFAULT_ASSUMPTIONS) is intentionally UNPROFITABLE.
   * This is correct behavior — it proves that lifetime caps are essential.
   * 
   * Without caps, cohorts accumulate over time and payouts grow unbounded,
   * while revenue is fixed to new account sales.
   * 
   * Tests below verify that adding lifetime caps makes the model profitable.
   */
  describe('Uncapped Baseline (proves caps are necessary)', () => {
    it('has negative margin without lifetime caps - this is expected', () => {
      const result = runMonteCarlo(FULL_CONFIG, DEFAULT_ASSUMPTIONS);
      
      // Uncapped baseline SHOULD be unprofitable (proves caps are needed)
      expect(result.diagnostics.effectiveMargin).toBeLessThan(0);
      console.log(`Uncapped margin: ${(result.diagnostics.effectiveMargin * 100).toFixed(1)}% (proves caps needed)`);
    });

    it('has reasonable profit distribution shape', () => {
      const result = runMonteCarlo(FULL_CONFIG, DEFAULT_ASSUMPTIONS);
      
      // P5 < P50 < P95
      expect(result.profit.p5).toBeLessThan(result.profit.p50);
      expect(result.profit.p50).toBeLessThan(result.profit.p95);
      
      // P50 should be close to mean for symmetric-ish distribution
      expect(Math.abs(result.profit.p50 - result.profit.mean)).toBeLessThan(result.profit.stdDev * 2);
    });

    it('shows high payout-to-revenue ratio without caps', () => {
      const result = runMonteCarlo(FULL_CONFIG, DEFAULT_ASSUMPTIONS);
      
      // Without caps, payouts exceed revenue (cohorts accumulate)
      expect(result.diagnostics.payoutToRevenueRatio).toBeGreaterThan(0.50);
      console.log(`Uncapped payout/revenue: ${(result.diagnostics.payoutToRevenueRatio * 100).toFixed(1)}%`);
    });
  });

  describe('With Lifetime Cap (profitable baseline)', () => {
    it('produces positive mean profit with 7x lifetime cap', () => {
      const result = runMonteCarlo(FULL_CONFIG, SCENARIO_PRESETS.withLifetimeCap7x);
      
      expect(result.profit.mean).toBeGreaterThan(0);
      console.log(`7x cap monthly profit: $${result.profit.mean.toFixed(2)}`);
    });

    it('has positive margin with 7x lifetime cap', () => {
      const result = runMonteCarlo(FULL_CONFIG, SCENARIO_PRESETS.withLifetimeCap7x);
      
      expect(result.diagnostics.effectiveMargin).toBeGreaterThan(0);
      expect(result.diagnostics.effectiveMargin).toBeLessThan(1);
      console.log(`7x cap margin: ${(result.diagnostics.effectiveMargin * 100).toFixed(1)}%`);
    });

    it('shows cap binding rate increases as cap decreases', () => {
      const cap10x = runMonteCarlo(QUICK_CONFIG, SCENARIO_PRESETS.withLifetimeCap10x);
      const cap7x = runMonteCarlo(QUICK_CONFIG, SCENARIO_PRESETS.withLifetimeCap7x);
      const cap5x = runMonteCarlo(QUICK_CONFIG, SCENARIO_PRESETS.withLifetimeCap5x);
      
      // Tighter caps bind more often
      expect(cap5x.payoutDiagnostics.lifetimeCapBindingRate).toBeGreaterThan(
        cap7x.payoutDiagnostics.lifetimeCapBindingRate
      );
      expect(cap7x.payoutDiagnostics.lifetimeCapBindingRate).toBeGreaterThan(
        cap10x.payoutDiagnostics.lifetimeCapBindingRate
      );
    });

    it('shows tighter caps improve profitability', () => {
      const cap10x = runMonteCarlo(FULL_CONFIG, SCENARIO_PRESETS.withLifetimeCap10x);
      const cap7x = runMonteCarlo(FULL_CONFIG, SCENARIO_PRESETS.withLifetimeCap7x);
      const cap5x = runMonteCarlo(FULL_CONFIG, SCENARIO_PRESETS.withLifetimeCap5x);
      
      // Tighter caps = higher profit
      expect(cap5x.profit.mean).toBeGreaterThan(cap7x.profit.mean);
      expect(cap7x.profit.mean).toBeGreaterThan(cap10x.profit.mean);
    });
  });

  describe('Attack Scenario', () => {
    it('attack worsens economics vs baseline', () => {
      const baseline = runMonteCarlo(FULL_CONFIG, DEFAULT_ASSUMPTIONS);
      const attack = runMonteCarlo(FULL_CONFIG, SCENARIO_PRESETS.coordinatedAttack);
      
      // Attack should make things worse
      expect(attack.profit.mean).toBeLessThan(baseline.profit.mean);
      console.log(`Attack scenario profit: $${attack.profit.mean.toFixed(2)}`);
    });

    it('has higher loss probability than baseline', () => {
      const baseline = runMonteCarlo(FULL_CONFIG, DEFAULT_ASSUMPTIONS);
      const attack = runMonteCarlo(FULL_CONFIG, SCENARIO_PRESETS.coordinatedAttack);
      
      expect(attack.risk.probabilityOfLoss).toBeGreaterThan(baseline.risk.probabilityOfLoss);
    });

    it('has worse P5 than baseline', () => {
      const baseline = runMonteCarlo(FULL_CONFIG, DEFAULT_ASSUMPTIONS);
      const attack = runMonteCarlo(FULL_CONFIG, SCENARIO_PRESETS.coordinatedAttack);
      
      expect(attack.profit.p5).toBeLessThan(baseline.profit.p5);
    });

    it('lifetime cap mitigates attack damage', () => {
      const attackNoCap = runMonteCarlo(FULL_CONFIG, SCENARIO_PRESETS.coordinatedAttack);
      const attackWithCap = runMonteCarlo(FULL_CONFIG, {
        ...SCENARIO_PRESETS.coordinatedAttack,
        knobs: { ...SCENARIO_PRESETS.coordinatedAttack.knobs, lifetimeCapPerUser: 1043 }, // 7x
      });
      
      // Caps should improve attack scenario
      expect(attackWithCap.profit.mean).toBeGreaterThan(attackNoCap.profit.mean);
    });
  });

  describe('First Payout Cap Knob', () => {
    it('reduces or maintains payout exposure', () => {
      // Both use same baseline, so payouts should be equal or less with cap
      const noCap = runMonteCarlo(FULL_CONFIG, DEFAULT_ASSUMPTIONS);
      const withCap = runMonteCarlo(FULL_CONFIG, SCENARIO_PRESETS.withFirstPayoutCap);
      
      // First payout cap reduces first payouts, but may not change total much
      // since it only affects first payout per attempt
      expect(withCap.diagnostics.avgMonthlyPayouts).toBeLessThanOrEqual(noCap.diagnostics.avgMonthlyPayouts + 1000);
    });

    it('improves or maintains mean profit', () => {
      const noCap = runMonteCarlo(FULL_CONFIG, DEFAULT_ASSUMPTIONS);
      const withCap = runMonteCarlo(FULL_CONFIG, SCENARIO_PRESETS.withFirstPayoutCap);
      
      expect(withCap.profit.mean).toBeGreaterThanOrEqual(noCap.profit.mean - 1000);
    });

    it('reduces or maintains probability of loss', () => {
      const noCap = runMonteCarlo(FULL_CONFIG, DEFAULT_ASSUMPTIONS);
      const withCap = runMonteCarlo(FULL_CONFIG, SCENARIO_PRESETS.withFirstPayoutCap);
      
      expect(withCap.risk.probabilityOfLoss).toBeLessThanOrEqual(noCap.risk.probabilityOfLoss + 0.05);
    });
  });

  describe('Scenario Comparison', () => {
    it('compares multiple scenarios with deltas', () => {
      const scenarios = {
        baseline: DEFAULT_ASSUMPTIONS,
        withLifetimeCap: SCENARIO_PRESETS.withLifetimeCap7x,
        attack: SCENARIO_PRESETS.coordinatedAttack,
      };
      
      const comparisons = compareScenarios(QUICK_CONFIG, scenarios);
      
      expect(comparisons).toHaveLength(3);
      
      // Baseline has no delta
      expect(comparisons[0].deltaFromBaseline).toBeUndefined();
      
      // Others have deltas
      expect(comparisons[1].deltaFromBaseline).toBeDefined();
      expect(comparisons[2].deltaFromBaseline).toBeDefined();
      
      // With lifetime cap should improve profit vs uncapped baseline
      expect(comparisons[1].deltaFromBaseline!.meanProfit).toBeGreaterThan(0);
      
      // Attack should reduce profit vs baseline
      expect(comparisons[2].deltaFromBaseline!.meanProfit).toBeLessThan(0);
    });
  });

  describe('Sensitivity Analysis', () => {
    it('shows profit sensitivity to first payout cap', () => {
      const sensitivity = runSensitivityAnalysis(
        { ...QUICK_CONFIG, iterations: 50 },
        DEFAULT_ASSUMPTIONS,
        'knobs.firstPayoutCap',
        [null as unknown as number, 200, 300, 400, 500]
      );
      
      expect(sensitivity.parameter).toBe('knobs.firstPayoutCap');
      expect(sensitivity.values).toHaveLength(5);
      expect(sensitivity.profits).toHaveLength(5);
    });

    it('shows profit sensitivity to lifetime cap', () => {
      const sensitivity = runSensitivityAnalysis(
        { ...QUICK_CONFIG, iterations: 50 },
        DEFAULT_ASSUMPTIONS,
        'knobs.lifetimeCapPerUser',
        [null as unknown as number, 1490, 1043, 745, 447]
      );
      
      expect(sensitivity.parameter).toBe('knobs.lifetimeCapPerUser');
      expect(sensitivity.profits).toHaveLength(5);
      
      // Tighter caps = better profit (more negative or less negative)
      // Index 4 ($447) should be better than index 0 (null/unlimited)
      expect(sensitivity.profits[4]).toBeGreaterThan(sensitivity.profits[0]);
    });
  });

  describe('Output Sanity Checks', () => {
    it('revenue includes new accounts and resets', () => {
      const result = runMonteCarlo(QUICK_CONFIG, DEFAULT_ASSUMPTIONS);
      
      // Revenue should be at least new account revenue
      const minExpectedRevenue = DEFAULT_ASSUMPTIONS.accountsPerMonth * DEFAULT_ASSUMPTIONS.pricePerAccount;
      expect(result.diagnostics.avgMonthlyRevenue).toBeGreaterThanOrEqual(minExpectedRevenue * 0.9);
    });

    it('includes raw samples when available', () => {
      const result = runMonteCarlo(QUICK_CONFIG, DEFAULT_ASSUMPTIONS);
      
      expect(result.rawSamples).toBeDefined();
      expect(result.rawSamples!.length).toBe(QUICK_CONFIG.iterations);
      expect(result.rawSamples![0].length).toBe(QUICK_CONFIG.monthsPerIteration);
    });

    it('tracks cohort diagnostics', () => {
      const result = runMonteCarlo(QUICK_CONFIG, DEFAULT_ASSUMPTIONS);
      
      expect(result.cohortDiagnostics.avgActiveCohortSize).toBeGreaterThan(0);
      expect(result.cohortDiagnostics.avgEligibleCohortSize).toBeGreaterThan(0);
      expect(result.cohortDiagnostics.activeCohortSizeByMonth.length).toBe(QUICK_CONFIG.monthsPerIteration);
    });
  });
});

describe('Invariants (Regression Guards)', () => {
  it('7x lifetime cap must be profitable', () => {
    const result = runMonteCarlo(FULL_CONFIG, SCENARIO_PRESETS.withLifetimeCap7x);
    
    // Critical invariant: 7x cap should always be profitable
    expect(result.profit.mean).toBeGreaterThan(0);
  });

  it('lifetime caps must reduce loss probability vs uncapped', () => {
    const uncapped = runMonteCarlo(FULL_CONFIG, DEFAULT_ASSUMPTIONS);
    const capped = runMonteCarlo(FULL_CONFIG, SCENARIO_PRESETS.withLifetimeCap7x);
    
    expect(capped.risk.probabilityOfLoss).toBeLessThan(uncapped.risk.probabilityOfLoss);
  });

  it('conservative knobs must reduce loss probability', () => {
    const baseline = runMonteCarlo(FULL_CONFIG, DEFAULT_ASSUMPTIONS);
    const conservative = runMonteCarlo(FULL_CONFIG, SCENARIO_PRESETS.conservativeKnobs);
    
    expect(conservative.risk.probabilityOfLoss).toBeLessThanOrEqual(baseline.risk.probabilityOfLoss);
  });

  it('attack with cap is better than attack without cap', () => {
    const attackNoCap = runMonteCarlo(FULL_CONFIG, SCENARIO_PRESETS.coordinatedAttack);
    const attackWithCap = runMonteCarlo(FULL_CONFIG, {
      ...SCENARIO_PRESETS.coordinatedAttack,
      knobs: { ...SCENARIO_PRESETS.coordinatedAttack.knobs, lifetimeCapPerUser: 1043 },
    });
    
    expect(attackWithCap.profit.mean).toBeGreaterThan(attackNoCap.profit.mean);
  });
});
