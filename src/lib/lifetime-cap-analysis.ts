/**
 * Lifetime Payout Cap Sensitivity Analysis
 * 
 * Sweeps lifetime cap multiples (of entry fee) to find optimal cap that:
 * - Bounds long-tail exposure per account
 * - Preserves trader LTV incentive
 * - Reduces fraud surface from "account farming"
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
  MonteCarloConfig,
  MonteCarloAssumptions,
  MonteCarloResult,
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
  
  // Per account size results
  byAccountSize: {
    accountSize: number;
    absoluteCap: number | null;
    baseline: {
      meanProfit: number;
      p5Profit: number;
      p95Profit: number;
      lossProb: number;
      maxDrawdown: number;
      effectiveMargin: number;
    };
    attack: {
      meanProfit: number;
      p5Profit: number;
      lossProb: number;
      maxDrawdown: number;
    };
  }[];
  
  // Aggregated metrics (weighted by account mix)
  aggregated: {
    meanProfit: number;
    p5Profit: number;
    lossProb: number;
    maxDrawdown: number;
  };
  
  // Risk analysis
  riskProfile: {
    maxExposurePerAccount: number;
    breakevenPayouts: number;  // how many payouts to hit cap
    fraudSurfaceScore: number; // 0-100, higher = more risk
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
      ltv: number;
      fraudSurfaceReduction: number;
      marginPreserved: number;
    };
  };
  // Comparison table for easy decision-making
  comparisonTable: {
    multiple: string;
    cap: string;
    avgMargin: string;
    maxExposure: string;
    fraudRisk: string;
    recommendation: string;
  }[];
}

// ============================================================================
// CONSTANTS
// ============================================================================

// Locked-in pricing from user decisions
export const LOCKED_PRICING: PricingConfig = {
  entryFee: 149,
  resetFee: 99,
  firstPayoutCap: 300,
  payoutSplitPercent: 80,
  maxPayoutPercent: 80,
  accountSizes: [50000, 100000],
};

// Cap multiples to test (of entry fee)
// null = unlimited (no lifetime cap)
const CAP_MULTIPLES: (number | null)[] = [null, 15, 10, 7, 5, 3];

// Monte Carlo config for analysis
const ANALYSIS_CONFIG: MonteCarloConfig = {
  iterations: 500,  // Lower for faster analysis; increase for production
  monthsPerIteration: 24,  // 2 years to see lifetime effects
  seed: 42,
};

// ============================================================================
// ASSUMPTIONS BUILDER
// ============================================================================

function buildAssumptionsForPricing(
  pricing: PricingConfig,
  accountSize: number,
  lifetimeCapMultiple: number | null
): MonteCarloAssumptions {
  // Base assumptions with real pricing
  return {
    // Acquisition - scaled to account size
    accountsPerMonth: accountSize === 50000 ? 600 : 400,  // More $50k accounts
    pricePerAccount: pricing.entryFee,

    // Trading funnel (rates as decimals)
    passRate: { min: 0.08, mode: 0.12, max: 0.18 },
    payoutRequestRate: { min: 0.55, mode: 0.65, max: 0.75 },
    avgDaysToFirstPayout: 18,

    // Payout behavior - scaled to account size
    avgPayoutAmount: { 
      mean: accountSize === 50000 ? 350 : 550,  // Larger accounts = larger payouts
      stdDev: accountSize === 50000 ? 120 : 180,
    },
    payoutsPerPaidAccountPerMonth: { min: 0.8, mode: 1.2, max: 1.8 },

    // Abuse & friction
    fraudAttemptRate: { min: 0.04, mode: 0.07, max: 0.12 },
    fraudSuccessRate: { min: 0.004, mode: 0.008, max: 0.015 },
    chargebackRate: { min: 0.015, mode: 0.025, max: 0.04 },
    resetRate: 0.18,

    // Costs
    variableCostPerAccount: 8,
    fixedMonthlyCosts: 18000,

    // Knobs with locked-in values
    knobs: {
      firstPayoutCap: pricing.firstPayoutCap,
      payoutSplitPercent: pricing.payoutSplitPercent / 100,
      maxPayoutPercent: pricing.maxPayoutPercent / 100,
      resetPrice: pricing.resetFee,
      lifetimeCapPerUser: lifetimeCapMultiple !== null 
        ? pricing.entryFee * lifetimeCapMultiple 
        : null,
      attackIntensity: 0,
    },
  };
}

function buildAttackAssumptions(base: MonteCarloAssumptions): MonteCarloAssumptions {
  return {
    ...base,
    knobs: {
      ...base.knobs,
      attackIntensity: 2,  // Coordinated attack scenario
    },
  };
}

// ============================================================================
// ANALYSIS FUNCTIONS
// ============================================================================

export function analyzeLifetimeCaps(
  pricing: PricingConfig = LOCKED_PRICING
): LifetimeCapSummary {
  const results: LifetimeCapResult[] = [];

  for (const multiple of CAP_MULTIPLES) {
    const capDollars = multiple !== null ? pricing.entryFee * multiple : null;
    
    const byAccountSize = pricing.accountSizes.map(accountSize => {
      const baseAssumptions = buildAssumptionsForPricing(pricing, accountSize, multiple);
      const attackAssumptions = buildAttackAssumptions(baseAssumptions);
      
      const baselineResult = runMonteCarlo(ANALYSIS_CONFIG, baseAssumptions);
      const attackResult = runMonteCarlo(ANALYSIS_CONFIG, attackAssumptions);
      
      return {
        accountSize,
        absoluteCap: capDollars,
        baseline: {
          meanProfit: Math.round(baselineResult.profit.mean),
          p5Profit: Math.round(baselineResult.profit.p5),
          p95Profit: Math.round(baselineResult.profit.p95),
          lossProb: baselineResult.risk.probabilityOfLoss,
          maxDrawdown: Math.round(baselineResult.risk.maxDrawdown),
          effectiveMargin: baselineResult.diagnostics.effectiveMargin,
        },
        attack: {
          meanProfit: Math.round(attackResult.profit.mean),
          p5Profit: Math.round(attackResult.profit.p5),
          lossProb: attackResult.risk.probabilityOfLoss,
          maxDrawdown: Math.round(attackResult.risk.maxDrawdown),
        },
      };
    });

    // Aggregate across account sizes (weighted 60/40 for $50k/$100k)
    const weights = [0.6, 0.4];
    const aggregated = {
      meanProfit: Math.round(
        byAccountSize.reduce((sum, r, i) => sum + r.baseline.meanProfit * weights[i], 0)
      ),
      p5Profit: Math.round(
        byAccountSize.reduce((sum, r, i) => sum + r.baseline.p5Profit * weights[i], 0)
      ),
      lossProb: byAccountSize.reduce((sum, r, i) => sum + r.baseline.lossProb * weights[i], 0),
      maxDrawdown: Math.round(
        byAccountSize.reduce((sum, r, i) => sum + r.baseline.maxDrawdown * weights[i], 0)
      ),
    };

    // Calculate risk profile
    const maxExposure = capDollars ?? Infinity;
    const avgPayout = (350 + 550) / 2;  // Weighted average
    const breakevenPayouts = capDollars ? Math.ceil(capDollars / avgPayout) : Infinity;
    
    // Fraud surface score: higher cap = more incentive for attack
    // Score 0-100: unlimited = 100, 3x = 20
    const fraudSurfaceScore = multiple === null 
      ? 100 
      : Math.min(100, Math.max(0, 10 + (multiple - 3) * 10));

    results.push({
      capMultiple: multiple,
      capLabel: multiple === null ? 'Unlimited' : `${multiple}× entry`,
      capDollars,
      byAccountSize,
      aggregated,
      riskProfile: {
        maxExposurePerAccount: maxExposure,
        breakevenPayouts,
        fraudSurfaceScore,
      },
    });
  }

  // Find optimal cap
  const recommendation = findOptimalLifetimeCap(results, pricing);
  
  // Build comparison table
  const comparisonTable = results.map(r => ({
    multiple: r.capLabel,
    cap: r.capDollars ? `$${r.capDollars}` : '∞',
    avgMargin: `${(r.byAccountSize[0].baseline.effectiveMargin * 100).toFixed(1)}%`,
    maxExposure: r.capDollars ? `$${r.capDollars}` : 'Unbounded',
    fraudRisk: r.riskProfile.fraudSurfaceScore <= 30 ? 'Low' 
             : r.riskProfile.fraudSurfaceScore <= 60 ? 'Medium' 
             : 'High',
    recommendation: r.capMultiple === recommendation.optimalMultiple ? '✓ OPTIMAL' : '',
  }));

  return {
    config: ANALYSIS_CONFIG,
    pricing,
    results,
    recommendation,
    comparisonTable,
  };
}

function findOptimalLifetimeCap(
  results: LifetimeCapResult[],
  pricing: PricingConfig
): LifetimeCapSummary['recommendation'] {
  // Find unlimited baseline for comparison
  const unlimited = results.find(r => r.capMultiple === null)!;
  
  // Score each cap:
  // - Preserve at least 90% of margin
  // - Minimize fraud surface
  // - Keep reasonable LTV (breakevenPayouts >= 3)
  
  let bestMultiple: number | null = null;
  let bestScore = -Infinity;
  let bestMetrics = { ltv: 0, fraudSurfaceReduction: 0, marginPreserved: 100 };
  
  for (const result of results) {
    if (result.capMultiple === null) continue;
    
    const marginPreserved = (result.aggregated.meanProfit / unlimited.aggregated.meanProfit) * 100;
    
    // Must preserve at least 85% of margin
    if (marginPreserved < 85) continue;
    
    // Must allow at least 3 payouts to cap (trader-friendly)
    if (result.riskProfile.breakevenPayouts < 3) continue;
    
    const fraudReduction = unlimited.riskProfile.fraudSurfaceScore - result.riskProfile.fraudSurfaceScore;
    const ltv = result.capDollars ?? 0;
    
    // Score: balance fraud reduction, margin preservation, and LTV
    const score = 
      (fraudReduction * 1.5) +                    // Weight fraud reduction heavily
      ((marginPreserved - 85) * 2) +              // Bonus for margin preservation
      (result.riskProfile.breakevenPayouts * 5);  // Reward reasonable payout count
    
    if (score > bestScore) {
      bestScore = score;
      bestMultiple = result.capMultiple;
      bestMetrics = {
        ltv,
        fraudSurfaceReduction: fraudReduction,
        marginPreserved,
      };
    }
  }
  
  const optimalCapDollars = bestMultiple !== null ? pricing.entryFee * bestMultiple : null;
  
  const reasoning = bestMultiple
    ? `${bestMultiple}× entry ($${optimalCapDollars}) caps lifetime exposure while preserving ${bestMetrics.marginPreserved.toFixed(1)}% margin and reducing fraud surface by ${bestMetrics.fraudSurfaceReduction} points.`
    : 'Unlimited cap provides best economics (fraud risk already contained by first payout cap).';
  
  return {
    optimalMultiple: bestMultiple,
    optimalCapDollars,
    reasoning,
    metrics: bestMetrics,
  };
}

// ============================================================================
// REPORT FORMATTER
// ============================================================================

export function formatLifetimeCapReport(summary: LifetimeCapSummary): string {
  const lines: string[] = [
    '═══════════════════════════════════════════════════════════════════════════════',
    '                    LIFETIME PAYOUT CAP SENSITIVITY ANALYSIS',
    '═══════════════════════════════════════════════════════════════════════════════',
    '',
    'LOCKED-IN PRICING:',
    `  Entry Fee: $${summary.pricing.entryFee}`,
    `  Reset Fee: $${summary.pricing.resetFee}`,
    `  First Payout Cap: $${summary.pricing.firstPayoutCap}`,
    `  Payout Split: ${summary.pricing.payoutSplitPercent}%`,
    `  Account Sizes: ${summary.pricing.accountSizes.map(s => `$${s / 1000}k`).join(' / ')}`,
    '',
    `Config: ${summary.config.iterations} iterations × ${summary.config.monthsPerIteration} months`,
    '',
    '┌────────────────┬──────────┬───────────────┬─────────────┬────────────┐',
    '│ Lifetime Cap   │ Cap ($)  │ Avg Margin    │ Max Exposure│ Fraud Risk │',
    '├────────────────┼──────────┼───────────────┼─────────────┼────────────┤',
  ];
  
  for (const row of summary.comparisonTable) {
    const multiple = row.multiple.padEnd(14);
    const cap = row.cap.padStart(8);
    const margin = row.avgMargin.padStart(11);
    const exposure = row.maxExposure.padStart(11);
    const risk = row.fraudRisk.padStart(10);
    
    lines.push(`│ ${multiple} │ ${cap} │ ${margin}   │ ${exposure} │ ${risk} │${row.recommendation ? ' ← OPTIMAL' : ''}`);
  }
  
  lines.push('└────────────────┴──────────┴───────────────┴─────────────┴────────────┘');
  lines.push('');
  lines.push('DETAILED RESULTS BY ACCOUNT SIZE');
  lines.push('─────────────────────────────────');
  
  for (const result of summary.results) {
    lines.push('');
    lines.push(`📊 ${result.capLabel} (${result.capDollars ? `$${result.capDollars}` : 'Unlimited'})`);
    lines.push('');
    
    for (const size of result.byAccountSize) {
      const sizeLabel = `$${size.accountSize / 1000}k account`;
      lines.push(`  ${sizeLabel}:`);
      lines.push(`    Baseline: Mean $${(size.baseline.meanProfit / 1000).toFixed(1)}k | P5 $${(size.baseline.p5Profit / 1000).toFixed(1)}k | Loss ${(size.baseline.lossProb * 100).toFixed(1)}% | Margin ${(size.baseline.effectiveMargin * 100).toFixed(1)}%`);
      lines.push(`    Attack:   Mean $${(size.attack.meanProfit / 1000).toFixed(1)}k | P5 $${(size.attack.p5Profit / 1000).toFixed(1)}k | Loss ${(size.attack.lossProb * 100).toFixed(1)}% | Drawdown $${(size.attack.maxDrawdown / 1000).toFixed(0)}k`);
    }
    
    lines.push(`  Risk Profile: Max Exposure ${result.capDollars ? `$${result.capDollars}` : '∞'} | ~${result.riskProfile.breakevenPayouts === Infinity ? '∞' : result.riskProfile.breakevenPayouts} payouts to cap | Fraud Score: ${result.riskProfile.fraudSurfaceScore}/100`);
  }
  
  lines.push('');
  lines.push('═══════════════════════════════════════════════════════════════════════════════');
  lines.push('                              RECOMMENDATION');
  lines.push('═══════════════════════════════════════════════════════════════════════════════');
  lines.push('');
  lines.push(`Optimal Cap: ${summary.recommendation.optimalMultiple ? `${summary.recommendation.optimalMultiple}× entry ($${summary.recommendation.optimalCapDollars})` : 'Unlimited'}`);
  lines.push('');
  lines.push(`Reasoning: ${summary.recommendation.reasoning}`);
  lines.push('');
  lines.push('Key Metrics vs Unlimited:');
  lines.push(`  • Margin Preserved: ${summary.recommendation.metrics.marginPreserved.toFixed(1)}%`);
  lines.push(`  • Fraud Surface Reduction: ${summary.recommendation.metrics.fraudSurfaceReduction} points`);
  lines.push(`  • Lifetime Value Cap: $${summary.recommendation.metrics.ltv}`);
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
      firstPayoutCap: 500,  // Higher cap for trusted tier
      lifetimeCapMultiple: optimalLifetimeMultiple + 2,  // More generous
      lifetimeCapDollars: 199 * (optimalLifetimeMultiple + 2),
      payoutSplit: 82,  // Slightly better split
      targetMargin: '20-30%',
      targetAudience: 'Experienced traders, higher LTV, moderate risk',
    },
    {
      name: 'Elite',
      accountSize: 200000,
      entryFee: 349,
      resetFee: 199,
      firstPayoutCap: 750,  // Highest cap
      lifetimeCapMultiple: optimalLifetimeMultiple + 5,  // Most generous
      lifetimeCapDollars: 349 * (optimalLifetimeMultiple + 5),
      payoutSplit: 85,  // Best split
      targetMargin: '15-25%',
      targetAudience: 'Professional traders, VIP treatment, invitation-only later',
    },
  ];
}

export function formatTierLadder(tiers: TierDesign[]): string {
  const lines: string[] = [
    '═══════════════════════════════════════════════════════════════════════════════',
    '                          RECOMMENDED TIER LADDER',
    '═══════════════════════════════════════════════════════════════════════════════',
    '',
  ];
  
  for (const tier of tiers) {
    lines.push(`┌─────────────────────────────────────────────────────────────────────────────┐`);
    lines.push(`│ ${tier.name.toUpperCase()} TIER                                                                    │`);
    lines.push(`├─────────────────────────────────────────────────────────────────────────────┤`);
    lines.push(`│ Account Size:     $${(tier.accountSize / 1000)}k                                                      │`);
    lines.push(`│ Entry Fee:        $${tier.entryFee}                                                        │`);
    lines.push(`│ Reset Fee:        $${tier.resetFee}                                                        │`);
    lines.push(`│ First Payout Cap: $${tier.firstPayoutCap}                                                       │`);
    lines.push(`│ Lifetime Cap:     ${tier.lifetimeCapMultiple}× entry ($${tier.lifetimeCapDollars})                                        │`);
    lines.push(`│ Payout Split:     ${tier.payoutSplit}%                                                        │`);
    lines.push(`│ Target Margin:    ${tier.targetMargin}                                                     │`);
    lines.push(`│ Audience:         ${tier.targetAudience.substring(0, 55)}... │`);
    lines.push(`└─────────────────────────────────────────────────────────────────────────────┘`);
    lines.push('');
  }
  
  return lines.join('\n');
}
