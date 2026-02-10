import type { PayoutEligibility } from '@/lib/types';

export type RowStatus = 'met' | 'in_progress' | 'blocked' | 'info';

export interface ChecklistRow {
  key: string;
  label: string;
  status: RowStatus;
  detail: string;
  /** Qualitative progress label — never exact numbers in trader view */
  progress?: string;
}

/** Status priority for sorting — lower = more urgent.
 *  `satisfies` ensures compile error if a new RowStatus is added without a priority. */
const STATUS_PRIORITY = {
  blocked: 0,
  in_progress: 1,
  info: 2,
  met: 3,
} as const satisfies Record<RowStatus, number>;

// ── Banding helpers (B2 hardening) ──────────────────────────

/** Convert a 0-100 progress percentage into a qualitative band label. */
function bandProgress(pct: number): string {
  if (pct >= 100) return 'Complete';
  if (pct >= 75) return 'Almost there';
  if (pct >= 40) return 'On track';
  return 'Getting started';
}

/** Band lifetime cap usage into qualitative tiers. */
function bandCapUsage(pct: number): string {
  if (pct >= 90) return 'Nearing limit';
  if (pct >= 60) return 'Well used';
  if (pct >= 25) return 'Early stage';
  return 'Plenty remaining';
}

/**
 * Derives eligibility checklist rows from payout eligibility data.
 * Deterministic ordering: phase → timing → requirements → review → cap.
 * 
 * B2 HARDENING: All exact dollar amounts, percentages, and day counts
 * are replaced with qualitative bands. Exact values remain admin-only.
 */
export function deriveEligibilityRows(e: PayoutEligibility): ChecklistRow[] {
  const rows: ChecklistRow[] = [];

  // 1. Account phase
  const isPerformance = e.reason_code !== 'NOT_PERFORMANCE_PHASE' && e.reason_code !== 'BAD_STATUS';
  rows.push({
    key: 'phase',
    label: 'Performance Phase',
    status: isPerformance ? 'met' : 'blocked',
    detail: isPerformance
      ? 'Account is in the performance phase.'
      : 'Payouts are available once your account reaches the performance phase.',
  });

  // 2. Cooling / eligibility delay
  if (e.payout_window_opened !== undefined) {
    const isOpen = e.payout_window_opened === true;
    rows.push({
      key: 'cooling',
      label: 'Eligibility Window',
      status: isOpen ? 'met' : 'info',
      detail: isOpen
        ? 'Your payout window is open.'
        : 'A waiting period applies before your first payout. No action required.',
      progress: !isOpen ? 'Waiting' : undefined,
    });
  }

  // 3. Cooldown between payouts
  if (e.has_prior_payout && e.reason_code === 'COOLDOWN') {
    rows.push({
      key: 'cooldown',
      label: 'Payout Cooldown',
      status: 'info',
      detail: 'A cooldown applies between payout requests. Check back soon.',
    });
  } else if (e.has_prior_payout && e.reason_code !== 'COOLDOWN') {
    rows.push({
      key: 'cooldown',
      label: 'Payout Cooldown',
      status: 'met',
      detail: 'Cooldown period has passed.',
    });
  }

  // 4. Winning days — banded, no exact counts
  if ((e.required_winning_days ?? 0) > 0) {
    const total = e.required_winning_days ?? 1;
    const achieved = (e.winning_days_since_payout ?? 0);
    const isMet = (e.winning_days_remaining ?? 0) <= 0;
    const pct = Math.min(100, (achieved / total) * 100);
    rows.push({
      key: 'winning_days',
      label: 'Winning Trading Days',
      status: isMet ? 'met' : 'in_progress',
      detail: isMet
        ? 'Minimum winning days requirement met.'
        : 'Additional winning trading days needed before next payout.',
      progress: isMet ? undefined : bandProgress(pct),
    });
  }

  // 5. Profit buffer — banded, no exact dollars
  if (e.profit_buffer_required != null && e.profit_buffer_required > 0) {
    const isMet = e.profit_buffer_met === true;
    const remaining = e.profit_buffer_remaining ?? 0;
    const required = e.profit_buffer_required;
    const achieved = Math.max(0, required - remaining);
    const pct = required > 0 ? Math.min(100, (achieved / required) * 100) : 100;
    rows.push({
      key: 'profit_buffer',
      label: 'Profit Buffer',
      status: isMet ? 'met' : 'in_progress',
      detail: isMet
        ? 'Profit buffer requirement met.'
        : 'Additional profit needed above the buffer threshold.',
      progress: isMet ? undefined : bandProgress(pct),
    });
  }

  // 6. Pending reviews
  if (e.reason_code === 'PENDING_VIOLATIONS') {
    rows.push({
      key: 'review',
      label: 'Account Review',
      status: 'in_progress',
      detail: 'Pending reviews must be resolved before payout eligibility can be confirmed.',
    });
  }

  // 7. Lifetime cap — banded, no exact dollars/percentages
  if (e.lifetime_cap_amount != null) {
    const isExhausted = e.reason_code === 'LIFETIME_CAP';
    const paidPct = (e.lifetime_paid_total ?? 0) / e.lifetime_cap_amount * 100;
    rows.push({
      key: 'lifetime_cap',
      label: 'Lifetime Earnings',
      status: isExhausted ? 'blocked' : 'met',
      detail: isExhausted
        ? 'Lifetime earnings limit reached. Start a new evaluation to continue earning.'
        : 'Lifetime earnings capacity available.',
      progress: !isExhausted ? bandCapUsage(paidPct) : undefined,
    });
  }

  return rows;
}

/** Returns the top blocker row (most urgent non-met row), or null if all met.
 *  Single-pass scan — deterministic by severity priority then original row order. */
export function getTopBlocker(rows: ChecklistRow[]): ChecklistRow | null {
  let best: { row: ChecklistRow; idx: number } | null = null;

  rows.forEach((row, idx) => {
    if (row.status === 'met') return;
    if (!best) {
      best = { row, idx };
      return;
    }
    const p = STATUS_PRIORITY[row.status] - STATUS_PRIORITY[best.row.status];
    if (p < 0 || (p === 0 && idx < best.idx)) {
      best = { row, idx };
    }
  });

  return best?.row ?? null;
}

export type ReadinessState = 'eligible' | 'in_progress' | 'blocked' | 'waiting';

/** Derives an overall readiness state from checklist rows.
 *  Active requirements (in_progress) take priority over passive waits (info). */
export function getReadinessState(rows: ChecklistRow[]): ReadinessState {
  if (rows.length > 0 && rows.every((r) => r.status === 'met')) return 'eligible';
  if (rows.some((r) => r.status === 'blocked')) return 'blocked';
  if (rows.some((r) => r.status === 'in_progress')) return 'in_progress';
  if (rows.some((r) => r.status === 'info')) return 'waiting';
  return 'in_progress';
}
