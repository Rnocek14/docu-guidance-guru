/**
 * Stable Configuration Sweep: Find the safe architecture
 * 
 * Sweeps pass rate modes (9–14%) across compensating controls:
 * - Split reductions (80% → 75%, 70%)
 * - Velocity gates (profit gate, winning days gate)  
 * - Verification periods (1mo, 2mo)
 * - Combined stacks
 * 
 * Goal: Find configs where 14% pass rate mode stays margin-positive.
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
  iterations: 500,
  monthsPerIteration: 12,
  seed: 42,
};

// ============================================================================
// HELPER: Build assumption overrides
// ============================================================================

function withPassRate(mode: number, base: MonteCarloAssumptions = DEFAULT_ASSUMPTIONS): MonteCarloAssumptions {
  const spread = 0.06; // ±3pp from mode
  return {
    ...base,
    passRate: { min: Math.max(0.04, mode - spread / 2), mode, max: mode + spread / 2 },
  };
}

function withDevLayerEffects(base: MonteCarloAssumptions): MonteCarloAssumptions {
  // Dev layer reduces chargebacks ~20%, fraud attempts ~15%
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

// ============================================================================
// CONFIGURATION MATRIX
// ============================================================================

interface ConfigVariant {
  name: string;
  build: (passRateMode: number) => MonteCarloAssumptions;
}

const VARIANTS: ConfigVariant[] = [
  {
    name: 'Baseline (80% split, no gates)',
    build: (pr) => withPassRate(pr),
  },
  {
    name: 'Dev Layer effects only (80% split)',
    build: (pr) => withDevLayerEffects(withPassRate(pr)),
  },
  {
    name: '75% split',
    build: (pr) => {
      const a = withDevLayerEffects(withPassRate(pr));
      return { ...a, knobs: { ...a.knobs, payoutSplitPercent: 0.75 } };
    },
  },
  {
    name: '70% split',
    build: (pr) => {
      const a = withDevLayerEffects(withPassRate(pr));
      return { ...a, knobs: { ...a.knobs, payoutSplitPercent: 0.70 } };
    },
  },
  {
    name: '80% split + profit gate $300',
    build: (pr) => {
      const a = withDevLayerEffects(withPassRate(pr));
      return { ...a, knobs: { ...a.knobs, minProfitSinceLastPayout: 300 } };
    },
  },
  {
    name: '80% split + 1mo verification',
    build: (pr) => {
      const a = withDevLayerEffects(withPassRate(pr));
      return { ...a, knobs: { ...a.knobs, verificationMonths: 1, verificationFailRate: 0.10 } };
    },
  },
  {
    name: '75% split + profit gate $300',
    build: (pr) => {
      const a = withDevLayerEffects(withPassRate(pr));
      return { ...a, knobs: { ...a.knobs, payoutSplitPercent: 0.75, minProfitSinceLastPayout: 300 } };
    },
  },
  {
    name: '75% split + 1mo verification + profit gate',
    build: (pr) => {
      const a = withDevLayerEffects(withPassRate(pr));
      return {
        ...a,
        knobs: {
          ...a.knobs,
          payoutSplitPercent: 0.75,
          verificationMonths: 1,
          verificationFailRate: 0.10,
          minProfitSinceLastPayout: 300,
        },
      };
    },
  },
  {
    name: 'Full stack: 75% + verify + profit gate + 15 winning days',
    build: (pr) => {
      const a = withDevLayerEffects(withPassRate(pr));
      return {
        ...a,
        knobs: {
          ...a.knobs,
          payoutSplitPercent: 0.75,
          verificationMonths: 1,
          verificationFailRate: 0.10,
          minProfitSinceLastPayout: 300,
          minWinningDaysPerPayout: 15,
        },
      };
    },
  },
];

const PASS_RATES = [0.09, 0.10, 0.11, 0.12, 0.13, 0.14];

// ============================================================================
// THE SWEEP
// ============================================================================

describe('Stable Configuration Sweep', () => {
  it('finds safe architecture across pass rates and controls', { timeout: 120_000 }, () => {
    console.log('\n═══════════════════════════════════════════════════════════════════════');
    console.log('    STABLE CONFIGURATION SWEEP');
    console.log('    500 iterations × 12 months | seed: 42');
    console.log('    Pass rate modes: 9% → 14% | 9 config variants');
    console.log('═══════════════════════════════════════════════════════════════════════');

    // Results matrix: variant → pass rate → result
    const matrix: { variant: string; passRate: number; margin: number; profit: number; lossProb: number; payoutRatio: number }[] = [];

    for (const variant of VARIANTS) {
      for (const pr of PASS_RATES) {
        const assumptions = variant.build(pr);
        const result = runMonteCarlo(CONFIG, assumptions);
        matrix.push({
          variant: variant.name,
          passRate: pr,
          margin: result.diagnostics.effectiveMargin,
          profit: result.profit.mean,
          lossProb: result.risk.probabilityOfLoss,
          payoutRatio: result.diagnostics.payoutToRevenueRatio,
        });
      }
    }

    // Print as table
    console.log('\n┌─────────────────────────────────────────────────┬────────┬──────────┬──────────┬──────────┬──────────┐');
    console.log('│ Configuration                                   │ Pass%  │  Margin  │  Profit  │ Loss Pr  │ Pay/Rev  │');
    console.log('├─────────────────────────────────────────────────┼────────┼──────────┼──────────┼──────────┼──────────┤');

    let currentVariant = '';
    for (const row of matrix) {
      if (row.variant !== currentVariant) {
        if (currentVariant) {
          console.log('├─────────────────────────────────────────────────┼────────┼──────────┼──────────┼──────────┼──────────┤');
        }
        currentVariant = row.variant;
      }

      const safe = row.margin > 0.05 ? '✅' : row.margin > 0 ? '⚠️' : '🚨';
      const name = row.variant === currentVariant && matrix.indexOf(row) !== matrix.findIndex(r => r.variant === row.variant)
        ? '  ↳'
        : row.variant.substring(0, 47).padEnd(47);

      console.log(
        `│ ${safe} ${name} │ ${(row.passRate * 100).toFixed(0).padStart(4)}%  │ ${(row.margin * 100).toFixed(1).padStart(6)}%  │ ${('$' + Math.round(row.profit).toLocaleString()).padStart(8)} │ ${(row.lossProb * 100).toFixed(1).padStart(6)}%  │ ${(row.payoutRatio * 100).toFixed(1).padStart(6)}%  │`
      );
    }
    console.log('└─────────────────────────────────────────────────┴────────┴──────────┴──────────┴──────────┴──────────┘');

    // Find the MINIMUM controls needed for 14% pass rate to stay positive
    console.log('\n═══════════════════════════════════════════════════════════════════════');
    console.log('    VERDICT: Minimum controls for 14% pass rate survivability');
    console.log('═══════════════════════════════════════════════════════════════════════');

    const at14 = matrix.filter(r => r.passRate === 0.14);
    const safeAt14 = at14.filter(r => r.margin > 0);
    const comfortAt14 = at14.filter(r => r.margin > 0.05);

    if (safeAt14.length === 0) {
      console.log('\n  🚨 NO configuration survives 14% pass rate mode.');
      console.log('  Consider: lower accountsPerMonth, higher entry fee, or tighter lifetime cap.');
    } else {
      console.log('\n  Configurations with POSITIVE margin at 14%:');
      for (const s of safeAt14) {
        const flag = s.margin > 0.05 ? '✅' : '⚠️';
        console.log(`    ${flag} ${s.variant}: ${(s.margin * 100).toFixed(1)}% margin ($${Math.round(s.profit)}/mo)`);
      }
    }

    if (comfortAt14.length > 0) {
      console.log('\n  Configurations with >5% COMFORT margin at 14%:');
      for (const s of comfortAt14) {
        console.log(`    ✅ ${s.variant}: ${(s.margin * 100).toFixed(1)}% margin ($${Math.round(s.profit)}/mo)`);
      }
    }

    // The sweep is informational — just ensure it runs
    expect(matrix.length).toBe(VARIANTS.length * PASS_RATES.length);
    expect(matrix.every(r => typeof r.margin === 'number')).toBe(true);
  });
});
