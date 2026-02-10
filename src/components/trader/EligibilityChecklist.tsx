import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CheckCircle2, AlertTriangle, XCircle, Info, Clock } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { PayoutEligibility } from '@/lib/types';

type RowStatus = 'met' | 'in_progress' | 'blocked' | 'info';

interface ChecklistRow {
  key: string;
  label: string;
  status: RowStatus;
  detail: string;
  progress?: string;
}

function deriveRows(e: PayoutEligibility): ChecklistRow[] {
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
    rows.push({
      key: 'profit_buffer',
      label: 'Profit Buffer',
      status: isMet ? 'met' : 'in_progress',
      detail: isMet
        ? 'Profit buffer requirement met.'
        : `$${(e.profit_buffer_remaining ?? 0).toFixed(0)} more profit needed above the buffer threshold.`,
      progress: `$${(e.realized_profit ?? 0).toFixed(0)} / $${(e.profit_buffer_required + (e.realized_profit ?? 0) - (e.profit_buffer_remaining ?? 0)).toFixed(0)}`,
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

const STATUS_CONFIG: Record<RowStatus, { icon: typeof CheckCircle2; className: string }> = {
  met: { icon: CheckCircle2, className: 'text-emerald-500' },
  in_progress: { icon: AlertTriangle, className: 'text-amber-500' },
  blocked: { icon: XCircle, className: 'text-destructive' },
  info: { icon: Clock, className: 'text-muted-foreground' },
};

function ChecklistRowComponent({ row }: { row: ChecklistRow }) {
  const config = STATUS_CONFIG[row.status];
  const Icon = config.icon;

  return (
    <div className="flex items-start gap-3 py-3 border-b border-border last:border-b-0">
      <Icon className={cn('h-4 w-4 mt-0.5 shrink-0', config.className)} />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-sm font-medium">{row.label}</span>
          {row.progress && (
            <span className="text-xs text-muted-foreground shrink-0">{row.progress}</span>
          )}
        </div>
        <p className="text-xs text-muted-foreground mt-0.5">{row.detail}</p>
      </div>
    </div>
  );
}

interface EligibilityChecklistProps {
  eligibility: PayoutEligibility;
}

export function EligibilityChecklist({ eligibility }: EligibilityChecklistProps) {
  const rows = deriveRows(eligibility);

  if (rows.length === 0) return null;

  const allMet = rows.every((r) => r.status === 'met');

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          {allMet ? (
            <CheckCircle2 className="h-4 w-4 text-emerald-500" />
          ) : (
            <Info className="h-4 w-4 text-muted-foreground" />
          )}
          {allMet ? 'All Requirements Met' : 'Payout Requirements'}
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        {rows.map((row) => (
          <ChecklistRowComponent key={row.key} row={row} />
        ))}
      </CardContent>
    </Card>
  );
}
