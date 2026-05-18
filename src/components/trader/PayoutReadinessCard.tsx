import { Link } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { CheckCircle2, AlertTriangle, XCircle, Clock, ArrowRight, DollarSign } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  deriveEligibilityRows,
  getTopBlocker,
  getReadinessState,
  type ReadinessState,
} from '@/lib/payout-eligibility';
import type { PayoutEligibility } from '@/lib/types';

const STATE_CONFIG: Record<ReadinessState, {
  badge: string;
  badgeClass: string;
  icon: typeof CheckCircle2;
  iconClass: string;
  summary: string;
}> = {
  eligible: {
    badge: 'Eligible',
    badgeClass: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20',
    icon: CheckCircle2,
    iconClass: 'text-emerald-500',
    summary: 'You currently meet the requirements to request a payout.',
  },
  in_progress: {
    badge: 'In Progress',
    badgeClass: 'bg-amber-500/10 text-amber-600 border-amber-500/20',
    icon: AlertTriangle,
    iconClass: 'text-amber-500',
    summary: "You're close — here's the next requirement to complete.",
  },
  blocked: {
    badge: 'Not Eligible',
    badgeClass: 'bg-destructive/10 text-destructive border-destructive/20',
    icon: XCircle,
    iconClass: 'text-destructive',
    summary: "This account isn't currently eligible for payout requests.",
  },
  waiting: {
    badge: 'Waiting',
    badgeClass: 'bg-muted text-muted-foreground border-border',
    icon: Clock,
    iconClass: 'text-muted-foreground',
    summary: "You're in a waiting period. Eligibility will update automatically.",
  },
};

interface PayoutReadinessCardProps {
  eligibility?: PayoutEligibility | null;
  isLoading?: boolean;
  accountId?: string;
}

export function PayoutReadinessCard({ eligibility, isLoading, accountId }: PayoutReadinessCardProps) {
  if (isLoading) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <Skeleton className="h-5 w-32" />
            <Skeleton className="h-5 w-20" />
          </div>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-3/4 mt-2" />
        </CardContent>
      </Card>
    );
  }

  if (!eligibility) return null;

  const rows = deriveEligibilityRows(eligibility);
  const state = getReadinessState(rows);
  const topBlocker = getTopBlocker(rows);
  const config = STATE_CONFIG[state];
  const StateIcon = config.icon;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <DollarSign className="h-4 w-4 text-muted-foreground" />
            Payout Readiness
          </CardTitle>
          <Badge variant="outline" className={cn('text-xs', config.badgeClass)}>
            <StateIcon className={cn('h-3 w-3 mr-1', config.iconClass)} />
            {config.badge}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Next-payout dollar line (eligible / waiting only — never for blocked). */}
        {(state === 'eligible' || state === 'waiting') && typeof eligibility.max_eligible_amount === 'number' && eligibility.max_eligible_amount > 0 && (
          <div className="rounded-md border border-border/60 bg-muted/30 px-3 py-2">
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
              {state === 'eligible' ? 'Next payout' : 'Estimated next payout'}
            </p>
            <p className="text-lg font-semibold tabular-nums">
              up to ${eligibility.max_eligible_amount.toLocaleString()}
              {state === 'waiting' && (
                <span className="text-xs font-normal text-muted-foreground ml-1.5">when window opens</span>
              )}
            </p>
          </div>
        )}

        {/* Top blocker or summary */}
        {topBlocker ? (
          <div className="space-y-1">
            <p className="text-sm font-medium">{topBlocker.label}</p>
            <p className="text-xs text-muted-foreground">{topBlocker.detail}</p>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{config.summary}</p>
        )}

        {/* CTA */}
        <div className="flex items-center gap-2 pt-1">
          {state === 'eligible' && accountId ? (
            <Button asChild size="sm" className="gap-1.5">
              <Link to={`/trader/payouts/request/${accountId}`}>
                Request Payout <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            </Button>
          ) : (
            <Button asChild size="sm" variant="outline" className="gap-1.5">
              <Link to={accountId ? `/trader/payouts/request/${accountId}` : '/trader/payouts'}>
                View Requirements <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
