import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CheckCircle2, AlertTriangle, XCircle, Info, Clock } from 'lucide-react';
import { cn } from '@/lib/utils';
import { deriveEligibilityRows, type RowStatus, type ChecklistRow } from '@/lib/payout-eligibility';
import type { PayoutEligibility } from '@/lib/types';

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
  const rows = deriveEligibilityRows(eligibility);

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
