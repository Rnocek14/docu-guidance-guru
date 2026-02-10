import { useMemo } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ShieldCheck, CheckCircle2, XCircle } from 'lucide-react';
import type { Account, Cohort } from '@/lib/types';

interface SafeDayPanelProps {
  account: Account & { cohort: Cohort };
}

export function SafeDayPanel({ account }: SafeDayPanelProps) {
  const analysis = useMemo(() => {
    const profitTarget = account.cohort?.profit_target_percent ?? 10;
    const minTradingDays = account.cohort?.min_trading_days ?? 5;
    const maxDailyLossPct = account.cohort?.max_daily_loss_percent ?? 5;

    const currentReturn = (account.total_pnl / account.starting_balance) * 100;
    const targetMet = currentReturn >= profitTarget;
    const daysMet = account.trading_days_count >= minTradingDays;

    const dailyLossLimit = account.starting_balance * (maxDailyLossPct / 100);

    // Drawdown headroom: how much can balance drop before breach
    const maxDrawdownPct = account.cohort?.max_total_drawdown_percent ?? 10;
    const drawdownFloor = account.highest_balance * (1 - maxDrawdownPct / 100);
    const drawdownHeadroom = Math.max(0, account.current_balance - drawdownFloor);

    // Safe day size = min(daily loss limit, drawdown headroom)
    const safeDaySize = Math.min(dailyLossLimit, drawdownHeadroom);

    return {
      targetMet,
      daysMet,
      dailyLossLimit,
      drawdownHeadroom,
      safeDaySize,
      allMet: targetMet && daysMet,
    };
  }, [account]);

  const checks = [
    { label: 'Min trading days', met: analysis.daysMet },
    { label: 'Profit target', met: analysis.targetMet },
  ];

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-lg">
          <ShieldCheck className="h-5 w-5 text-primary" />
          If You Stop Trading Today
        </CardTitle>
        <CardDescription>Snapshot of where you stand right now</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          {checks.map((c) => (
            <div key={c.label} className="flex items-center gap-2 text-sm">
              {c.met ? (
                <CheckCircle2 className="h-4 w-4 text-success shrink-0" />
              ) : (
                <XCircle className="h-4 w-4 text-muted-foreground/40 shrink-0" />
              )}
              <span className={c.met ? 'text-foreground' : 'text-muted-foreground'}>{c.label}</span>
            </div>
          ))}
        </div>

        <div className="mt-4 rounded-lg border border-border bg-muted/30 p-3 space-y-2">
          <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Safe day guidance
          </div>
          <div className="text-sm">
            <span className="text-muted-foreground">Max loss per day to stay safe: </span>
            <span className="font-mono font-bold">${Math.round(analysis.safeDaySize).toLocaleString()}</span>
          </div>
          <p className="text-[11px] text-muted-foreground/60">
            Based on whichever is tighter: your daily loss limit (${Math.round(analysis.dailyLossLimit).toLocaleString()}) 
            or remaining drawdown headroom (${Math.round(analysis.drawdownHeadroom).toLocaleString()}).
          </p>
        </div>

        {analysis.allMet && (
          <div className="mt-3 rounded-lg border border-success/30 bg-success/5 p-3 text-sm text-success font-medium">
            All milestones met — qualifying for staff review.
          </div>
        )}
      </CardContent>
    </Card>
  );
}
