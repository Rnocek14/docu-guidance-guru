import type { PayoutEligibility } from '@/lib/types';

export type RowStatus = 'met' | 'in_progress' | 'blocked' | 'info';

export interface ChecklistRow {
  key: string;
  label: string;
  status: RowStatus;
  detail: string;
  progress?: string;
}

/** Status priority for sorting — lower = more urgent */
const STATUS_PRIORITY: Record<RowStatus, number> = {
  blocked: 0,
  in_progress: 1,
  info: 2,
  met: 3,
};

/**
 * Derives eligibility checklist rows from payout eligibility data.
 * Deterministic ordering: phase → timing → requirements → review → cap.
 * Reused by EligibilityChecklist (full view) and PayoutReadinessCard (summary).
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
        : `Opens in ${e.days_remaining ?? '—'} day${(e.days_remaining ?? 0) !== 1 ? 's' : ''}. No action required.`,
      progress: !isOpen && e.days_since_pass != null && e.cooling_period_days
        ? `${e.days_since_pass} / ${e.cooling_period_days} days`
        : undefined,
    });
  }

  // 3. Cooldown between payouts
  if (e.has_prior_payout && e.reason_code === 'COOLDOWN') {
    rows.push({
      key: 'cooldown',
      label: 'Payout Cooldown',
      status: 'info',
      detail: `A cooldown applies between payout requests. ${e.days_remaining ? `${e.days_remaining} day${e.days_remaining !== 1 ? 's' : ''} remaining.` : 'Check back soon.'}`,
    });
  } else if (e.has_prior_payout && e.reason_code !== 'COOLDOWN') {
    rows.push({
      key: 'cooldown',
      label: 'Payout Cooldown',
      status: 'met',
      detail: 'Cooldown period has passed.',
    });
  }

  // 4. Winning days
  if ((e.required_winning_days ?? 0) > 0) {
    const isMet = (e.winning_days_remaining ?? 0) <= 0;
    rows.push({
      key: 'winning_days',
      label: 'Winning Trading Days',
      status: isMet ? 'met' : 'in_progress',
      detail: isMet
        ? 'Minimum winning days requirement met.'
        : `${e.winning_days_remaining} more winning day${(e.winning_days_remaining ?? 0) !== 1 ? 's' : ''} needed.`,
      progress: `${e.winning_days_since_payout ?? 0} / ${e.required_winning_days}`,
    });
  }

  // 5. Profit buffer
  if (e.profit_buffer_required != null && e.profit_buffer_required > 0) {
    const isMet = e.profit_buffer_met === true;
    const required = e.profit_buffer_required;
    const remaining = e.profit_buffer_remaining ?? 0;
    const achieved = Math.max(0, required - remaining);
    rows.push({
      key: 'profit_buffer',
      label: 'Profit Buffer',
      status: isMet ? 'met' : 'in_progress',
      detail: isMet
        ? 'Profit buffer requirement met.'
        : `$${remaining.toFixed(0)} more profit needed above the buffer threshold.`,
      progress: `$${achieved.toFixed(0)} / $${required.toFixed(0)}`,
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

  // 7. Lifetime cap
  if (e.lifetime_cap_amount != null) {
    const isExhausted = e.reason_code === 'LIFETIME_CAP';
    const paidPct = Math.round(((e.lifetime_paid_total ?? 0) / e.lifetime_cap_amount) * 100);
    rows.push({
      key: 'lifetime_cap',
      label: 'Lifetime Earnings',
      status: isExhausted ? 'blocked' : 'met',
      detail: isExhausted
        ? 'Lifetime earnings limit reached. Start a new evaluation to continue earning.'
        : `$${(e.lifetime_headroom ?? 0).toLocaleString()} remaining of $${e.lifetime_cap_amount.toLocaleString()} total.`,
      progress: !isExhausted ? `${paidPct}% used` : undefined,
    });
  }

  return rows;
}

/** Returns the top blocker row (most urgent non-met row), or null if all met. */
export function getTopBlocker(rows: ChecklistRow[]): ChecklistRow | null {
  const nonMet = rows.filter((r) => r.status !== 'met');
  if (nonMet.length === 0) return null;
  return nonMet.sort((a, b) => STATUS_PRIORITY[a.status] - STATUS_PRIORITY[b.status])[0];
}

export type ReadinessState = 'eligible' | 'in_progress' | 'blocked' | 'waiting';

/** Derives an overall readiness state from checklist rows. */
export function getReadinessState(rows: ChecklistRow[]): ReadinessState {
  if (rows.length > 0 && rows.every((r) => r.status === 'met')) return 'eligible';
  if (rows.some((r) => r.status === 'blocked')) return 'blocked';
  if (rows.some((r) => r.status === 'info')) return 'waiting';
  return 'in_progress';
}
