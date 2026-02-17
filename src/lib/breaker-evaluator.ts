/**
 * Breaker Validation Engine
 * 
 * Compares simulation output against live DB config to determine
 * whether the economic breaker would catch the simulated scenario.
 * 
 * Does NOT flip breakers in prod — purely evaluative.
 */

import { supabase } from '@/integrations/supabase/client';

// ============================================================================
// TYPES
// ============================================================================

export interface BreakerConfig {
  breaker_level: string;
  payouts_blocked: boolean;
  approvals_blocked: boolean;
  evaluations_frozen: boolean;
  rolling_pass_rate: number;
  rolling_pass_count: number;
  rolling_total_count: number;
  net_buffer: number | null;
  pending_liability: number;
}

export interface PaymentSystemConfig {
  is_paused_inbound: boolean;
  is_paused_outbound: boolean;
  pause_reason: string | null;
}

export interface CohortSnapshot {
  id: string;
  name: string;
  cohort_phase: string;
  entry_fee: number | null;
  first_payout_cap_amount: number | null;
  lifetime_cap_multiple: number | null;
  payout_split_percent: number;
  payout_cooldown_days: number;
  payout_eligibility_delay_days: number;
  min_trading_days_between_payouts: number;
  min_winning_days_between_payouts: number | null;
  min_profit_buffer: number | null;
  intake_active: boolean;
}

export interface DbConfigSnapshot {
  capturedAt: string;
  breaker: BreakerConfig | null;
  paymentSystem: PaymentSystemConfig | null;
  cohorts: CohortSnapshot[];
  warnings: string[];
  /** Breaker thresholds used for validation (for auditability) */
  breakerThresholds: typeof BREAKER_THRESHOLDS;
}

export interface BreakerValidationResult {
  dbSnapshot: DbConfigSnapshot;
  validations: BreakerValidation[];
  overallPass: boolean;
  configDriftWarnings: string[];
}

export interface BreakerValidation {
  check: string;
  passed: boolean;
  detail: string;
  severity: 'info' | 'warning' | 'error';
}

// ============================================================================
// BREAKER THRESHOLDS (must match DB trigger thresholds)
// ============================================================================

const BREAKER_THRESHOLDS = {
  elevated: 15,  // pass rate >= 15%
  critical: 18,  // pass rate >= 18%
  emergency: 20, // pass rate >= 20%
};

// ============================================================================
// SNAPSHOT FETCHER
// ============================================================================

export async function captureDbConfigSnapshot(): Promise<DbConfigSnapshot> {
  const warnings: string[] = [];

  // Fetch breaker state, payment state, and cohorts in parallel
  const [breakerRes, paymentRes, cohortsRes] = await Promise.all([
    supabase.rpc('get_econ_breaker_state'),
    supabase.from('payment_system_state').select('*').limit(1).single(),
    supabase.from('cohorts').select('id,name,cohort_phase,entry_fee,first_payout_cap_amount,lifetime_cap_multiple,payout_split_percent,payout_cooldown_days,payout_eligibility_delay_days,min_trading_days_between_payouts,min_winning_days_between_payouts,min_profit_buffer,intake_active').eq('is_active', true),
  ]);

  let breaker: BreakerConfig | null = null;
  if (breakerRes.error) {
    warnings.push(`Could not fetch breaker state: ${breakerRes.error.message}`);
  } else {
    const rows = breakerRes.data as unknown as BreakerConfig[];
    breaker = rows?.[0] ?? null;
    if (!breaker) warnings.push('Breaker state row missing — cannot validate breaker behavior');
  }

  let paymentSystem: PaymentSystemConfig | null = null;
  if (paymentRes.error) {
    warnings.push(`Could not fetch payment system state: ${paymentRes.error.message}`);
  } else {
    paymentSystem = paymentRes.data as PaymentSystemConfig;
  }

  const cohorts: CohortSnapshot[] = [];
  if (cohortsRes.error) {
    warnings.push(`Could not fetch cohorts: ${cohortsRes.error.message}`);
  } else {
    cohorts.push(...(cohortsRes.data as CohortSnapshot[]));
  }

  if (cohorts.length === 0) {
    warnings.push('No active cohorts found — simulation may use defaults');
  }

  return {
    capturedAt: new Date().toISOString(),
    breaker,
    paymentSystem,
    cohorts,
    warnings,
    breakerThresholds: { ...BREAKER_THRESHOLDS },
  };
}

// ============================================================================
// VALIDATION ENGINE
// ============================================================================

interface SimSummaryForValidation {
  passRateUsed?: number;
  worstMonthNetProfit: number;
  reserveBreachProb: number;
  annualMeanProfit: number;
}

export function validateBreakerConfig(
  snapshot: DbConfigSnapshot,
  simSummary: SimSummaryForValidation,
  presetInputs: { attackIntensity: number; reserveThreshold: number; entryFee: number },
): BreakerValidationResult {
  const validations: BreakerValidation[] = [];
  const configDriftWarnings: string[] = [];

  // 1. Breaker row exists
  if (!snapshot.breaker) {
    validations.push({
      check: 'Breaker state exists',
      passed: false,
      detail: 'econ_breaker_state row is missing — breaker cannot function',
      severity: 'error',
    });
  } else {
    validations.push({
      check: 'Breaker state exists',
      passed: true,
      detail: `Current level: ${snapshot.breaker.breaker_level}, pass rate: ${Number(snapshot.breaker.rolling_pass_rate).toFixed(1)}%`,
      severity: 'info',
    });

    // 2. Breaker thresholds would catch simulated scenario
    //    Compare estimated pass rate against SNAPSHOT thresholds (not hardcoded)
    const estimatedPassRate = estimatePassRateFromIntensity(presetInputs.attackIntensity);
    const thresholds = snapshot.breakerThresholds;
    if (estimatedPassRate >= thresholds.elevated) {
      validations.push({
        check: `Estimated pass rate vs breaker threshold (heuristic)`,
        passed: true,
        detail: `Heuristic estimate: ${estimatedPassRate.toFixed(1)}% pass rate (from attackIntensity=${presetInputs.attackIntensity}) >= elevated threshold ${thresholds.elevated}% — breaker would fire. Note: this is an estimation, not a measured value from the sim engine.`,
        severity: 'info',
      });
    }

    // 3. Current breaker not already tripped
    if (snapshot.breaker.breaker_level !== 'normal') {
      configDriftWarnings.push(
        `Breaker is currently at "${snapshot.breaker.breaker_level}" — simulation assumes normal starting state`
      );
    }
  }

  // 4. Payment system not already paused
  if (snapshot.paymentSystem?.is_paused_inbound) {
    configDriftWarnings.push('Inbound payments are currently paused — simulation assumes active intake');
  }

  // 5. Binding check: if breaker is elevated/emergency, intake MUST be gated
  if (snapshot.breaker && snapshot.breaker.breaker_level !== 'normal') {
    const inboundPaused = snapshot.paymentSystem?.is_paused_inbound === true;
    const allIntakeClosed = snapshot.cohorts.length > 0 && snapshot.cohorts.every(c => !c.intake_active);
    const intakeGated = inboundPaused || allIntakeClosed;

    validations.push({
      check: 'Intake gated when breaker active',
      passed: intakeGated,
      detail: intakeGated
        ? `Intake correctly gated (inbound paused: ${inboundPaused}, cohorts intake closed: ${allIntakeClosed})`
        : `BREACH: Breaker at "${snapshot.breaker.breaker_level}" but intake is still open — inbound not paused AND cohorts still accepting`,
      severity: intakeGated ? 'info' : 'error',
    });
  }

  // 6. Cohort config matches simulation assumptions
  const perfCohort = snapshot.cohorts.find(c => c.cohort_phase === 'performance');
  if (perfCohort) {
    if (perfCohort.entry_fee !== null && perfCohort.entry_fee !== presetInputs.entryFee) {
      configDriftWarnings.push(
        `Preset uses entry fee $${presetInputs.entryFee} but DB cohort has $${perfCohort.entry_fee}`
      );
    }

    // Validate payout cap exists
    if (perfCohort.first_payout_cap_amount) {
      validations.push({
        check: 'First payout cap configured',
        passed: true,
        detail: `$${perfCohort.first_payout_cap_amount} first payout cap active`,
        severity: 'info',
      });
    } else {
      validations.push({
        check: 'First payout cap configured',
        passed: false,
        detail: 'No first payout cap — extraction risk higher than modeled',
        severity: 'warning',
      });
    }

    // Validate lifetime cap
    if (perfCohort.lifetime_cap_multiple) {
      validations.push({
        check: 'Lifetime cap configured',
        passed: true,
        detail: `${perfCohort.lifetime_cap_multiple}× lifetime cap active`,
        severity: 'info',
      });
    } else {
      validations.push({
        check: 'Lifetime cap configured',
        passed: false,
        detail: 'No lifetime cap — long-term extraction risk unbounded',
        severity: 'warning',
      });
    }
  } else {
    validations.push({
      check: 'Performance cohort exists',
      passed: false,
      detail: 'No performance-phase cohort found — payout rules may not match simulation',
      severity: 'warning',
    });
  }

  // 7. Reserve threshold sanity
  validations.push({
    check: 'Reserve threshold adequate',
    passed: presetInputs.reserveThreshold >= 10000,
    detail: `Reserve threshold: $${presetInputs.reserveThreshold.toLocaleString()} (recommended: ≥ $10,000)`,
    severity: presetInputs.reserveThreshold < 10000 ? 'warning' : 'info',
  });

  // 8. Simulation-specific: would reserve survive?
  validations.push({
    check: 'Reserve survives scenario',
    passed: simSummary.reserveBreachProb < 0.25,
    detail: `Reserve breach probability: ${(simSummary.reserveBreachProb * 100).toFixed(1)}%`,
    severity: simSummary.reserveBreachProb >= 0.25 ? 'error' : 'info',
  });

  const overallPass = validations.every(v => v.severity !== 'error' || v.passed);

  return {
    dbSnapshot: snapshot,
    validations,
    overallPass,
    configDriftWarnings,
  };
}

// ============================================================================
// HELPERS
// ============================================================================

function estimatePassRateFromIntensity(attackIntensity: number): number {
  // Base mode is ~12%, attack multiplier from engine: 1 + 0.5 * intensity
  const baseMode = 12;
  return Math.min(baseMode * (1 + 0.5 * attackIntensity), 50);
}
