/**
 * Lifetime Payout Cap Sensitivity Analysis
 * 
 * Now uses REAL binding diagnostics from the Monte Carlo engine.
 * The engine actually tracks per-account lifetime paid and enforces caps.
 * 
 * Uses locked-in pricing:
 * - Entry fee: $149
 * - Reset fee: $99
 * - First payout cap: $300
 * - Payout split: 80%
 * - Account sizes: $50k / $100k
 */

import {
  runMonteCarlo,
  runLifetimeCapSweep,
  MonteCarloConfig,
  MonteCarloAssumptions,
  DEFAULT_ASSUMPTIONS,
  LifetimeCapSweepResult,
} from './monte-carlo';

// ============================================================================
// TYPES
// ============================================================================

export interface PricingConfig {
  entryFee: number;
  resetFee: number;
  firstPayoutCap: number;
  payoutSplitPercent: number;
  maxPayoutPercent: number;
  accountSizes: number[];
}

export interface LifetimeCapResult {
  capMultiple: number | null;  // null = unlimited
  capLabel: string;
  capDollars: number | null;
  
  // REAL diagnostics from Monte Carlo engine
  binding: {
    rate: number;                    // % of accounts that hit the cap
    accountsCompleted: number;       // count of accounts that reached cap
    avgLifetimePaid: number;         // avg payout total per account
    avgHeadroomAtEnd: number;        // avg remaining cap headroom
    payoutsRejected: number;         // count of payouts blocked by cap
  };
  
  // First payout cap diagnostics
  firstPayoutCap: {
    bindingRate: number;             // % of first payouts that hit cap
    avgBeforeCap: number;
    avgAfterCap: number;
  };
  
  // Profit metrics
  profit: {
    mean: number;
    p5: number;
    p95: number;
    margin: number;
  };
  
  // Risk metrics
  risk: {
    lossProb: number;
    maxDrawdown: number;
  };
  
  // Delta from unlimited baseline
  vsUnlimited: {
    profitDelta: number;
    marginDelta: number;
  };
}

export interface LifetimeCapSummary {
  config: MonteCarloConfig;
  pricing: PricingConfig;
  results: LifetimeCapResult[];
  recommendation: {
    optimalMultiple: number | null;
    optimalCapDollars: number | null;
    reasoning: string;
    metrics: {
      bindingRate: number;
      marginPreserved: number;
      profitDelta: number;
    };
  };
  warnings: string[];
}

// ============================================================================
// CONSTANTS
// ============================================================================

export const LOCKED_PRICING: PricingConfig = {
  entryFee: 149,
  resetFee: 99,
  firstPayoutCap: 300,
  payoutSplitPercent: 80,
  maxPayoutPercent: 80,
  accountSizes: [50000, 100000],
};

const CAP_MULTIPLES: (number | null)[] = [null, 15, 12, 10, 9, 8, 7, 6, 5, 4, 3];

const ANALYSIS_CONFIG: MonteCarloConfig = {
  iterations: 500,
  monthsPerIteration: 12,
  seed: 42,
};

// ============================================================================
// ANALYSIS FUNCTIONS
// ============================================================================

function buildAssumptionsForPricing(pricing: PricingConfig): MonteCarloAssumptions {
  return {
    ...DEFAULT_ASSUMPTIONS,
    pricePerAccount: pricing.entryFee,
    knobs: {
      ...DEFAULT_ASSUMPTIONS.knobs,
      firstPayoutCap: pricing.firstPayoutCap,
      payoutSplitPercent: pricing.payoutSplitPercent / 100,
      maxPayoutPercent: pricing.maxPayoutPercent / 100,
      resetPrice: pricing.resetFee,
      lifetimeCapPerUser: null, // Will be set per sweep
    },
  };
}

export function analyzeLifetimeCaps(
  pricing: PricingConfig = LOCKED_PRICING,
  config: MonteCarloConfig = ANALYSIS_CONFIG
): LifetimeCapSummary {
  const baseAssumptions = buildAssumptionsForPricing(pricing);
  
  // Run sweep with real binding diagnostics
  const sweepResults = runLifetimeCapSweep(config, baseAssumptions, CAP_MULTIPLES);
  
  // Find unlimited baseline
  const unlimited = sweepResults.find(r => r.multiple === null);
  if (!unlimited) {
    throw new Error('Unlimited baseline not found');
  }
  
  const baselineMargin = unlimited.result.diagnostics.effectiveMargin;
  const baselineProfit = unlimited.result.profit.mean;
  
  // Convert to our result format with real diagnostics
  const results: LifetimeCapResult[] = sweepResults.map(r => {
    const pd = r.result.payoutDiagnostics;
    const diag = r.result.diagnostics;
    
    return {
      capMultiple: r.multiple,
      capLabel: r.multiple === null ? 'Unlimited' : `${r.multiple}× entry`,
      capDollars: r.capDollars,
      
      binding: {
        rate: r.capBindingRate,
        accountsCompleted: r.accountsCompletedByCap,
        avgLifetimePaid: r.avgLifetimePaidPerAccount,
        avgHeadroomAtEnd: r.avgHeadroomAtEnd,
        payoutsRejected: r.payoutsRejected,
      },
      
      firstPayoutCap: {
        bindingRate: pd.firstPayoutCapBindingRate,
        avgBeforeCap: pd.avgFirstPayoutBeforeCap,
        avgAfterCap: pd.avgFirstPayoutAfterCap,
      },
      
      profit: {
        mean: r.result.profit.mean,
        p5: r.result.profit.p5,
        p95: r.result.profit.p95,
        margin: diag.effectiveMargin,
      },
      
      risk: {
        lossProb: r.result.risk.probabilityOfLoss,
        maxDrawdown: r.result.risk.maxDrawdown,
      },
      
      vsUnlimited: {
        profitDelta: r.profitDelta,
        marginDelta: r.marginDelta,
      },
    };
  });
  
  // Find optimal cap using real binding data
  const { recommendation, warnings } = findOptimalCap(results, baselineMargin, baselineProfit, pricing);
  
  return {
    config,
    pricing,
    results,
    recommendation,
    warnings,
  };
}

function findOptimalCap(
  results: LifetimeCapResult[],
  baselineMargin: number,
  baselineProfit: number,
  pricing: PricingConfig
): { recommendation: LifetimeCapSummary['recommendation']; warnings: string[] } {
  const warnings: string[] = [];
  
  let bestMultiple: number | null = null;
  let bestScore = -Infinity;
  let bestMetrics = { bindingRate: 0, marginPreserved: 100, profitDelta: 0 };
  
  for (const result of results) {
    if (result.capMultiple === null) continue;
    
    const marginPreserved = baselineMargin > 0 
      ? (result.profit.margin / baselineMargin) * 100 
      : 100;
    
    // Collect warnings for suspicious results
    if (result.binding.rate === 0 && result.capMultiple <= 10) {
      warnings.push(`${result.capMultiple}× cap ($${result.capDollars}) never binds - simulation may not reach cap levels`);
    }
    
    if (result.binding.rate > 0.50) {
      warnings.push(`${result.capMultiple}× cap binds on ${(result.binding.rate * 100).toFixed(1)}% of accounts - may be too aggressive`);
    }
    
    // Score: balance binding effectiveness with margin preservation
    // We WANT some binding (5-30%) to prove cap is working
    // But not too much (>30%) which hurts legit traders
    const bindingScore = 
      result.binding.rate >= 0.05 && result.binding.rate <= 0.30 ? 1.0 :
      result.binding.rate > 0.30 ? 0.5 :
      0.2; // Very low binding = cap not doing much
    
    const marginScore = marginPreserved >= 95 ? 1.0 : marginPreserved >= 90 ? 0.8 : 0.5;
    
    // Prefer caps that show measurable binding with minimal margin loss
    const score = bindingScore * marginScore * 100 + marginPreserved;
    
    if (score > bestScore) {
      bestScore = score;
      bestMultiple = result.capMultiple;
      bestMetrics = {
        bindingRate: result.binding.rate,
        marginPreserved,
        profitDelta: result.vsUnlimited.profitDelta,
      };
    }
  }
  
  // If no cap showed meaningful binding, warn about it
  const anyBinding = results.some(r => r.capMultiple !== null && r.binding.rate > 0);
  if (!anyBinding) {
    warnings.push('WARNING: No caps showed binding in simulation. Check if simulation runs long enough for accounts to accumulate payouts.');
  }
  
  const optimalCapDollars = bestMultiple !== null ? pricing.entryFee * bestMultiple : null;
  
  let reasoning: string;
  if (bestMultiple && bestMetrics.bindingRate > 0) {
    reasoning = `${bestMultiple}× entry ($${optimalCapDollars}) binds on ${(bestMetrics.bindingRate * 100).toFixed(1)}% of accounts while preserving ${bestMetrics.marginPreserved.toFixed(1)}% margin.`;
  } else if (bestMultiple) {
    reasoning = `${bestMultiple}× entry ($${optimalCapDollars}) selected but shows minimal binding. Consider running longer simulations or adjusting cap lower.`;
  } else {
    reasoning = 'Unlimited cap recommended - lower caps showed no significant binding benefit.';
  }
  
  return {
    recommendation: {
      optimalMultiple: bestMultiple,
      optimalCapDollars,
      reasoning,
      metrics: bestMetrics,
    },
    warnings,
  };
}

// ============================================================================
// REPORT FORMATTER
// ============================================================================

export function formatLifetimeCapReport(summary: LifetimeCapSummary): string {
  const lines: string[] = [
    '═══════════════════════════════════════════════════════════════════════════════════════════',
    '                    LIFETIME PAYOUT CAP SENSITIVITY ANALYSIS (with real binding)',
    '═══════════════════════════════════════════════════════════════════════════════════════════',
    '',
    'LOCKED-IN PRICING:',
    `  Entry Fee: $${summary.pricing.entryFee}`,
    `  Reset Fee: $${summary.pricing.resetFee}`,
    `  First Payout Cap: $${summary.pricing.firstPayoutCap}`,
    `  Payout Split: ${summary.pricing.payoutSplitPercent}%`,
    '',
    `Config: ${summary.config.iterations} iterations × ${summary.config.monthsPerIteration} months`,
    '',
    '┌────────────────┬──────────┬──────────┬──────────┬──────────┬──────────┬──────────┬──────────┐',
    '│ Lifetime Cap   │ Cap ($)  │ Binding% │ Margin   │ Profit   │ Avg Paid │ Headroom │ Rejected │',
    '├────────────────┼──────────┼──────────┼──────────┼──────────┼──────────┼──────────┼──────────┤',
  ];
  
  for (const r of summary.results) {
    const label = r.capLabel.padEnd(14);
    const cap = r.capDollars ? `$${r.capDollars}`.padStart(8) : 'N/A'.padStart(8);
    const binding = `${(r.binding.rate * 100).toFixed(1)}%`.padStart(8);
    const margin = `${(r.profit.margin * 100).toFixed(1)}%`.padStart(8);
    const profit = `$${r.profit.mean.toFixed(0)}`.padStart(8);
    const avgPaid = `$${r.binding.avgLifetimePaid.toFixed(0)}`.padStart(8);
    const headroom = r.binding.avgHeadroomAtEnd === Infinity 
      ? 'N/A'.padStart(8) 
      : `$${r.binding.avgHeadroomAtEnd.toFixed(0)}`.padStart(8);
    const rejected = r.binding.payoutsRejected.toString().padStart(8);
    
    const marker = r.capMultiple === summary.recommendation.optimalMultiple ? ' ←' : '';
    lines.push(`│ ${label} │ ${cap} │ ${binding} │ ${margin} │ ${profit} │ ${avgPaid} │ ${headroom} │ ${rejected} │${marker}`);
  }
  
  lines.push('└────────────────┴──────────┴──────────┴──────────┴──────────┴──────────┴──────────┴──────────┘');
  lines.push('');
  
  // Warnings
  if (summary.warnings.length > 0) {
    lines.push('⚠️  WARNINGS');
    lines.push('────────────');
    for (const w of summary.warnings) {
      lines.push(`  • ${w}`);
    }
    lines.push('');
  }
  
  // Recommendation
  lines.push('═══════════════════════════════════════════════════════════════════════════════════════════');
  lines.push('                              RECOMMENDATION');
  lines.push('═══════════════════════════════════════════════════════════════════════════════════════════');
  lines.push('');
  lines.push(`Optimal Cap: ${summary.recommendation.optimalMultiple ? `${summary.recommendation.optimalMultiple}× entry ($${summary.recommendation.optimalCapDollars})` : 'Unlimited'}`);
  lines.push('');
  lines.push(`Reasoning: ${summary.recommendation.reasoning}`);
  lines.push('');
  lines.push('Key Metrics:');
  lines.push(`  • Cap Binding Rate: ${(summary.recommendation.metrics.bindingRate * 100).toFixed(1)}%`);
  lines.push(`  • Margin Preserved: ${summary.recommendation.metrics.marginPreserved.toFixed(1)}%`);
  lines.push(`  • Monthly Profit Delta: $${summary.recommendation.metrics.profitDelta.toFixed(0)}`);
  lines.push('');
  
  return lines.join('\n');
}

// ============================================================================
// TIER DESIGN HELPER
// ============================================================================

export interface TierDesign {
  name: string;
  accountSize: number;
  entryFee: number;
  resetFee: number;
  firstPayoutCap: number;
  lifetimeCapMultiple: number | null;
  lifetimeCapDollars: number | null;
  payoutSplit: number;
  targetMargin: string;
  targetAudience: string;
}

export function designTierLadder(
  optimalLifetimeMultiple: number,
  pricing: PricingConfig = LOCKED_PRICING
): TierDesign[] {
  return [
    {
      name: 'Starter',
      accountSize: 50000,
      entryFee: pricing.entryFee,
      resetFee: pricing.resetFee,
      firstPayoutCap: pricing.firstPayoutCap,
      lifetimeCapMultiple: optimalLifetimeMultiple,
      lifetimeCapDollars: pricing.entryFee * optimalLifetimeMultiple,
      payoutSplit: pricing.payoutSplitPercent,
      targetMargin: '25-35%',
      targetAudience: 'New traders, volume acquisition, risk-bounded',
    },
    {
      name: 'Pro',
      accountSize: 100000,
      entryFee: 199,
      resetFee: 129,
      firstPayoutCap: 500,
      lifetimeCapMultiple: optimalLifetimeMultiple + 2,
      lifetimeCapDollars: 199 * (optimalLifetimeMultiple + 2),
      payoutSplit: 82,
      targetMargin: '30-40%',
      targetAudience: 'Experienced traders, higher engagement',
    },
    {
      name: 'Elite',
      accountSize: 200000,
      entryFee: 349,
      resetFee: 199,
      firstPayoutCap: 750,
      lifetimeCapMultiple: optimalLifetimeMultiple + 5,
      lifetimeCapDollars: 349 * (optimalLifetimeMultiple + 5),
      payoutSplit: 85,
      targetMargin: '35-45%',
      targetAudience: 'High-trust traders, premium positioning',
    },
  ];
}

export function formatTierLadder(tiers: TierDesign[]): string {
  const lines: string[] = [
    '═══════════════════════════════════════════════════════════════════════════════',
    '                         TIER LADDER DESIGN',
    '═══════════════════════════════════════════════════════════════════════════════',
    '',
  ];
  
  for (const tier of tiers) {
    lines.push(`▸ ${tier.name.toUpperCase()} TIER`);
    lines.push(`  Account Size: $${(tier.accountSize / 1000).toFixed(0)}k`);
    lines.push(`  Entry Fee: $${tier.entryFee} | Reset: $${tier.resetFee}`);
    lines.push(`  First Payout Cap: $${tier.firstPayoutCap}`);
    lines.push(`  Lifetime Cap: ${tier.lifetimeCapMultiple}× ($${tier.lifetimeCapDollars})`);
    lines.push(`  Payout Split: ${tier.payoutSplit}%`);
    lines.push(`  Target Margin: ${tier.targetMargin}`);
    lines.push(`  Target Audience: ${tier.targetAudience}`);
    lines.push('');
    lines.push('───────────────────────────────────────────────────────────────────────────────');
    lines.push('');
  }
  
  return lines.join('\n');
}
