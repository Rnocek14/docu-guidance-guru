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

  describe('Baseline Scenario', () => {
    it('produces positive mean profit', () => {
      const result = runMonteCarlo(FULL_CONFIG, DEFAULT_ASSUMPTIONS);
      
      expect(result.profit.mean).toBeGreaterThan(0);
      console.log(`Mean monthly profit: $${result.profit.mean.toFixed(2)}`);
    });

    it('has reasonable profit distribution', () => {
      const result = runMonteCarlo(FULL_CONFIG, DEFAULT_ASSUMPTIONS);
      
      // P5 < P50 < P95
      expect(result.profit.p5).toBeLessThan(result.profit.p50);
      expect(result.profit.p50).toBeLessThan(result.profit.p95);
      
      // P50 should be close to mean for symmetric-ish distribution
      expect(Math.abs(result.profit.p50 - result.profit.mean)).toBeLessThan(result.profit.stdDev);
    });

    it('has low probability of loss', () => {
      const result = runMonteCarlo(FULL_CONFIG, DEFAULT_ASSUMPTIONS);
      
      // Should lose money < 20% of months under baseline
      expect(result.risk.probabilityOfLoss).toBeLessThan(0.20);
      console.log(`Probability of loss month: ${(result.risk.probabilityOfLoss * 100).toFixed(1)}%`);
    });

    it('has positive margin', () => {
      const result = runMonteCarlo(FULL_CONFIG, DEFAULT_ASSUMPTIONS);
      
      expect(result.diagnostics.effectiveMargin).toBeGreaterThan(0);
      expect(result.diagnostics.effectiveMargin).toBeLessThan(1);
      console.log(`Effective margin: ${(result.diagnostics.effectiveMargin * 100).toFixed(1)}%`);
    });
  });

  describe('Attack Scenario', () => {
    it('still produces positive mean profit under coordinated attack', () => {
      const result = runMonteCarlo(FULL_CONFIG, SCENARIO_PRESETS.coordinatedAttack);
      
      expect(result.profit.mean).toBeGreaterThan(0);
      console.log(`Attack scenario mean profit: $${result.profit.mean.toFixed(2)}`);
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
  });

  describe('First Payout Cap Knob', () => {
    it('reduces payout exposure', () => {
      const noCap = runMonteCarlo(FULL_CONFIG, DEFAULT_ASSUMPTIONS);
      const withCap = runMonteCarlo(FULL_CONFIG, SCENARIO_PRESETS.withFirstPayoutCap);
      
      expect(withCap.diagnostics.avgMonthlyPayouts).toBeLessThan(noCap.diagnostics.avgMonthlyPayouts);
    });

    it('improves mean profit', () => {
      const noCap = runMonteCarlo(FULL_CONFIG, DEFAULT_ASSUMPTIONS);
      const withCap = runMonteCarlo(FULL_CONFIG, SCENARIO_PRESETS.withFirstPayoutCap);
      
      expect(withCap.profit.mean).toBeGreaterThan(noCap.profit.mean);
    });

    it('reduces probability of loss', () => {
      const noCap = runMonteCarlo(FULL_CONFIG, DEFAULT_ASSUMPTIONS);
      const withCap = runMonteCarlo(FULL_CONFIG, SCENARIO_PRESETS.withFirstPayoutCap);
      
      expect(withCap.risk.probabilityOfLoss).toBeLessThanOrEqual(noCap.risk.probabilityOfLoss);
    });
  });

  describe('Scenario Comparison', () => {
    it('compares multiple scenarios with deltas', () => {
      const scenarios = {
        baseline: DEFAULT_ASSUMPTIONS,
        withCap: SCENARIO_PRESETS.withFirstPayoutCap,
        attack: SCENARIO_PRESETS.coordinatedAttack,
      };
      
      const comparisons = compareScenarios(QUICK_CONFIG, scenarios);
      
      expect(comparisons).toHaveLength(3);
      
      // Baseline has no delta
      expect(comparisons[0].deltaFromBaseline).toBeUndefined();
      
      // Others have deltas
      expect(comparisons[1].deltaFromBaseline).toBeDefined();
      expect(comparisons[2].deltaFromBaseline).toBeDefined();
      
      // With cap should improve profit vs baseline
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
      
      // Lower cap = higher profit (generally)
      // Note: null becomes 0 in the array but simulation treats null as no cap
    });

    it('shows profit sensitivity to accounts per month', () => {
      const sensitivity = runSensitivityAnalysis(
        { ...QUICK_CONFIG, iterations: 50 },
        DEFAULT_ASSUMPTIONS,
        'accountsPerMonth',
        [250, 500, 750, 1000]
      );
      
      expect(sensitivity.parameter).toBe('accountsPerMonth');
      expect(sensitivity.profits).toHaveLength(4);
      
      // More accounts = more profit (before fixed costs dominate)
      expect(sensitivity.profits[3]).toBeGreaterThan(sensitivity.profits[0]);
    });
  });

  describe('Output Sanity Checks', () => {
    it('revenue matches expected calculation', () => {
      const result = runMonteCarlo(QUICK_CONFIG, DEFAULT_ASSUMPTIONS);
      
      const expectedRevenue = DEFAULT_ASSUMPTIONS.accountsPerMonth * DEFAULT_ASSUMPTIONS.pricePerAccount;
      expect(result.diagnostics.avgMonthlyRevenue).toBe(expectedRevenue);
    });

    it('payout-to-revenue ratio is reasonable', () => {
      const result = runMonteCarlo(FULL_CONFIG, DEFAULT_ASSUMPTIONS);
      
      // Should be between 10% and 50% typically
      expect(result.diagnostics.payoutToRevenueRatio).toBeGreaterThan(0.10);
      expect(result.diagnostics.payoutToRevenueRatio).toBeLessThan(0.50);
    });

    it('includes raw samples when available', () => {
      const result = runMonteCarlo(QUICK_CONFIG, DEFAULT_ASSUMPTIONS);
      
      expect(result.rawSamples).toBeDefined();
      expect(result.rawSamples!.length).toBe(QUICK_CONFIG.iterations);
      expect(result.rawSamples![0].length).toBe(QUICK_CONFIG.monthsPerIteration);
    });
  });
});

describe('Invariants (Regression Guards)', () => {
  it('baseline must remain profitable at P5', () => {
    const result = runMonteCarlo(FULL_CONFIG, DEFAULT_ASSUMPTIONS);
    
    // Critical invariant: even at 5th percentile, should not be catastrophic
    // Allow small losses, but not more than $10k/month
    expect(result.profit.p5).toBeGreaterThan(-10000);
  });

  it('attack scenario must not exceed 50% loss probability', () => {
    const result = runMonteCarlo(FULL_CONFIG, SCENARIO_PRESETS.coordinatedAttack);
    
    expect(result.risk.probabilityOfLoss).toBeLessThan(0.50);
  });

  it('conservative knobs must reduce loss probability', () => {
    const baseline = runMonteCarlo(FULL_CONFIG, DEFAULT_ASSUMPTIONS);
    const conservative = runMonteCarlo(FULL_CONFIG, SCENARIO_PRESETS.conservativeKnobs);
    
    expect(conservative.risk.probabilityOfLoss).toBeLessThanOrEqual(baseline.risk.probabilityOfLoss);
  });
});
