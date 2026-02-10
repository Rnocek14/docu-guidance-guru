import { useMemo } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Compass, CheckCircle2, Circle, ArrowRight } from 'lucide-react';
import type { Account, Cohort } from '@/lib/types';

interface WhatsNextCardProps {
  account: Account & { cohort: Cohort };
}

export function WhatsNextCard({ account }: WhatsNextCardProps) {
  const analysis = useMemo(() => {
    const profitTarget = account.cohort?.profit_target_percent ?? 10;
    const minTradingDays = account.cohort?.min_trading_days ?? 5;

    const currentReturn = (account.total_pnl / account.starting_balance) * 100;
    const remainingPercent = Math.max(0, profitTarget - currentReturn);
    const remainingDollars = Math.max(0, (remainingPercent / 100) * account.starting_balance);

    const daysCompleted = account.trading_days_count;
    const daysRemaining = Math.max(0, minTradingDays - daysCompleted);

    const targetMet = currentReturn >= profitTarget;
    const daysMet = daysCompleted >= minTradingDays;

    // Estimate days to target based on average daily P&L from existing trades
    const avgDailyPnl = daysCompleted > 0 ? account.total_pnl / daysCompleted : 0;
    const estimatedDaysToTarget = avgDailyPnl > 0 && !targetMet
      ? Math.ceil(remainingDollars / avgDailyPnl)
      : null;

    return {
      currentReturn,
      profitTarget,
      remainingPercent,
      remainingDollars,
      daysCompleted,
      minTradingDays,
      daysRemaining,
      targetMet,
      daysMet,
      estimatedDaysToTarget,
      avgDailyPnl,
    };
  }, [account]);

  const milestones = [
    {
      label: `Minimum trading days (${analysis.minTradingDays})`,
      done: analysis.daysMet,
      detail: analysis.daysMet
        ? `Completed ${analysis.daysCompleted} days`
        : `${analysis.daysRemaining} more day${analysis.daysRemaining !== 1 ? 's' : ''} needed`,
    },
    {
      label: `Profit target (${analysis.profitTarget}%)`,
      done: analysis.targetMet,
      detail: analysis.targetMet
        ? `Target reached at ${analysis.currentReturn.toFixed(2)}%`
        : `${analysis.remainingPercent.toFixed(2)}% remaining ($${analysis.remainingDollars.toLocaleString(undefined, { maximumFractionDigits: 0 })})`,
    },
    {
      label: 'Staff review of results',
      done: false,
      detail: 'All transitions are human-reviewed before proceeding',
    },
  ];

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-lg">
          <Compass className="h-5 w-5 text-primary" />
          What Happens Next
        </CardTitle>
        <CardDescription>Your path through this evaluation phase</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          {milestones.map((m, i) => (
            <div key={i} className="flex items-start gap-3">
              <div className="mt-0.5">
                {m.done ? (
                  <CheckCircle2 className="h-5 w-5 text-success" />
                ) : (
                  <Circle className="h-5 w-5 text-muted-foreground/40" />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className={`text-sm font-medium ${m.done ? 'text-foreground' : 'text-muted-foreground'}`}>
                  {m.label}
                </div>
                <div className="text-xs text-muted-foreground">{m.detail}</div>
              </div>
            </div>
          ))}
        </div>

        {/* Projection */}
        {analysis.estimatedDaysToTarget && !analysis.targetMet && (
          <div className="mt-4 rounded-lg border border-border bg-muted/30 p-3">
            <div className="flex items-center gap-2 text-sm">
              <ArrowRight className="h-4 w-4 text-primary shrink-0" />
              <span className="text-muted-foreground">
                At your current pace (~${Math.round(analysis.avgDailyPnl).toLocaleString()}/day), 
                you may reach the target in approximately{' '}
                <span className="font-semibold text-foreground">
                  {analysis.estimatedDaysToTarget} trading day{analysis.estimatedDaysToTarget !== 1 ? 's' : ''}
                </span>
              </span>
            </div>
            <p className="text-[10px] text-muted-foreground/60 mt-1.5">
              This is a projection based on past performance and is not a guarantee of future results.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
