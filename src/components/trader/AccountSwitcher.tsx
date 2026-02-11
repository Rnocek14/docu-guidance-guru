import { useMemo } from 'react';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useIsMobile } from '@/hooks/use-mobile';
import { cn } from '@/lib/utils';
import type { Account, Cohort, AccountStatus } from '@/lib/types';

interface AccountSwitcherProps {
  accounts: (Account & { cohort: Cohort })[];
  selectedAccountId: string | null;
  onSelect: (accountId: string) => void;
}

const STATUS_PRIORITY: Record<string, number> = {
  active: 0,
  passed: 1,
  payout_requested: 2,
  payout_under_review: 3,
  payout_approved: 4,
  under_review: 5,
  breached_detected: 6,
  failed_confirmed: 7,
  closed: 8,
};

const PHASE_LABELS: Record<string, string> = {
  evaluation: 'Eval',
  verification: 'Veri',
  performance: 'PA',
};

const STATUS_DOT: Record<string, string> = {
  active: 'bg-success',
  passed: 'bg-primary',
  payout_requested: 'bg-primary',
  payout_under_review: 'bg-warning',
  payout_approved: 'bg-primary',
  under_review: 'bg-warning',
  breached_detected: 'bg-destructive',
  failed_confirmed: 'bg-destructive',
  closed: 'bg-muted-foreground',
};

const PHASE_BADGE_CLASSES: Record<string, string> = {
  evaluation: 'bg-primary/15 text-primary border-primary/30',
  verification: 'bg-chart-5/15 text-chart-5 border-chart-5/30',
  performance: 'bg-success/15 text-success border-success/30',
};

function formatPnl(pnl: number): string {
  const abs = Math.abs(pnl);
  const formatted = abs >= 1000 ? `${(abs / 1000).toFixed(1)}k` : abs.toFixed(0);
  return `${pnl >= 0 ? '+' : '-'}$${formatted}`;
}

export function sortAccounts(accounts: (Account & { cohort: Cohort })[]) {
  return [...accounts].sort(
    (a, b) => (STATUS_PRIORITY[a.status] ?? 99) - (STATUS_PRIORITY[b.status] ?? 99),
  );
}

function AccountPill({
  account,
  isSelected,
  onClick,
}: {
  account: Account & { cohort: Cohort };
  isSelected: boolean;
  onClick: () => void;
}) {
  const phase = account.cohort?.cohort_phase || 'evaluation';
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors whitespace-nowrap',
        isSelected
          ? 'border-primary bg-primary/10 shadow-sm'
          : 'border-border hover:border-primary/50 hover:bg-accent',
      )}
    >
      <span className={cn('h-2 w-2 rounded-full shrink-0', STATUS_DOT[account.status] || 'bg-muted-foreground')} />
      <span className="font-mono text-xs">#{account.account_number}</span>
      <Badge variant="outline" className={cn('text-[10px] px-1 py-0 border', PHASE_BADGE_CLASSES[phase])}>
        {PHASE_LABELS[phase] || phase}
      </Badge>
      <span
        className={cn(
          'text-xs font-medium',
          account.total_pnl >= 0 ? 'text-success' : 'text-destructive',
        )}
      >
        {formatPnl(account.total_pnl)}
      </span>
    </button>
  );
}

export function AccountSwitcher({ accounts, selectedAccountId, onSelect }: AccountSwitcherProps) {
  const isMobile = useIsMobile();
  const sorted = useMemo(() => sortAccounts(accounts), [accounts]);

  if (!sorted.length) return null;

  // Mobile: dropdown
  if (isMobile) {
    return (
      <Select value={selectedAccountId || sorted[0]?.id} onValueChange={onSelect}>
        <SelectTrigger className="w-full">
          <SelectValue placeholder="Select account" />
        </SelectTrigger>
        <SelectContent>
          {sorted.map((a) => {
            const phase = a.cohort?.cohort_phase || 'evaluation';
            return (
              <SelectItem key={a.id} value={a.id}>
                <span className="flex items-center gap-2">
                  <span className={cn('h-2 w-2 rounded-full inline-block', STATUS_DOT[a.status])} />
                  <span className="font-mono text-xs">#{a.account_number}</span>
                  <span className="text-[10px] text-muted-foreground">
                    {PHASE_LABELS[phase]}
                  </span>
                  <span className={cn('text-xs', a.total_pnl >= 0 ? 'text-success' : 'text-destructive')}>
                    {formatPnl(a.total_pnl)}
                  </span>
                </span>
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
    );
  }

  // Desktop: horizontal scrollable pills
  return (
    <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-thin">
      {sorted.map((a) => (
        <AccountPill
          key={a.id}
          account={a}
          isSelected={a.id === (selectedAccountId || sorted[0]?.id)}
          onClick={() => onSelect(a.id)}
        />
      ))}
    </div>
  );
}
