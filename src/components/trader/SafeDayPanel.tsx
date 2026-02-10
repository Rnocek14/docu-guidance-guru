import { useMemo } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ShieldCheck, CheckCircle2, XCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import type { Account, Cohort } from '@/lib/types';

interface SafeDayPanelProps {
  account: Account & { cohort: Cohort };
}

type RiskBand = 'low' | 'medium' | 'high';

const BAND_CONFIG: Record<RiskBand, { label: string; badgeVariant: 'default' | 'outline' | 'destructive'; description: string }> = {
  low: {
    label: 'Low Risk',
    badgeVariant: 'default',
    description: 'You have comfortable headroom. Normal trading activity is unlikely to trigger a breach.',
  },
  medium: {
    label: 'Medium Risk',
    badgeVariant: 'outline',
    description: 'Headroom is tightening. Consider smaller position sizes to protect your progress.',
  },
  high: {
    label: 'High Risk',
    badgeVariant: 'destructive',
    description: 'Very limited headroom remaining. Large swings could trigger a breach — trade cautiously.',
  },
};

export function SafeDayPanel({ account }: SafeDayPanelProps) {
  const analysis = useMemo(() => {
    const profitTarget = account.cohort?.profit_target_percent ?? 10;
    const minTradingDays = account.cohort?.min_trading_days ?? 5;
    const maxDailyLossPct = account.cohort?.max_daily_loss_percent ?? 5;

    const currentReturn = (account.total_pnl / account.starting_balance) * 100;
    const targetMet = currentReturn >= profitTarget;
    const daysMet = account.trading_days_count >= minTradingDays;

    const dailyLossLimit = account.starting_balance * (maxDailyLossPct / 100);

    const maxDrawdownPct = account.cohort?.max_total_drawdown_percent ?? 10;
    const drawdownFloor = account.highest_balance * (1 - maxDrawdownPct / 100);
    const drawdownHeadroom = Math.max(0, account.current_balance - drawdownFloor);

    const safeDaySize = Math.min(dailyLossLimit, drawdownHeadroom);

    // Compute risk band based on headroom ratio (safeDaySize / dailyLossLimit)
    const headroomRatio = dailyLossLimit > 0 ? safeDaySize / dailyLossLimit : 0;
    let riskBand: RiskBand;
    if (headroomRatio >= 0.6) {
      riskBand = 'low';
    } else if (headroomRatio >= 0.3) {
      riskBand = 'medium';
    } else {
      riskBand = 'high';
    }

    return {
      targetMet,
      daysMet,
      riskBand,
      allMet: targetMet && daysMet,
    };
  }, [account]);

  const bandConfig = BAND_CONFIG[analysis.riskBand];

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
          <div className="flex items-center justify-between">
            <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Session risk level
            </div>
            <Badge variant={bandConfig.badgeVariant} className="text-xs">
              {bandConfig.label}
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            {bandConfig.description}
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
