import { useMemo } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Shield, CheckCircle2, AlertTriangle, XCircle } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useQuery } from '@tanstack/react-query';
import type { Account, Cohort } from '@/lib/types';

type HealthLevel = 'stable' | 'caution' | 'at_risk';

interface RuleHealthCardProps {
  account: Account & { cohort: Cohort };
}

export function RuleHealthCard({ account }: RuleHealthCardProps) {
  const maxDailyLoss = account.cohort?.max_daily_loss_percent ?? 5;
  const maxDrawdown = account.cohort?.max_total_drawdown_percent ?? 10;

  // Fetch daily stats for worst-day and consistency analysis
  const { data: dailyStats } = useQuery({
    queryKey: ['rule-health-daily-stats', account.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('account_daily_stats')
        .select('net_pnl, trading_day, is_winning_day')
        .eq('account_id', account.id)
        .order('trading_day', { ascending: true });

      if (error) throw error;
      return data;
    },
    enabled: !!account.id,
  });

  const analysis = useMemo(() => {
    const drawdownUsed = account.highest_balance > 0
      ? ((account.highest_balance - account.current_balance) / account.highest_balance) * 100
      : 0;
    const drawdownUsedPercent = Math.min(100, (drawdownUsed / maxDrawdown) * 100);

    // Worst day from daily stats or daily_pnl
    const worstDayPnl = dailyStats?.length
      ? Math.min(...dailyStats.map((d) => Number(d.net_pnl)))
      : Number(account.daily_pnl);

    const dailyLossLimit = account.starting_balance * (maxDailyLoss / 100);
    const worstDayUsedPercent = worstDayPnl < 0
      ? Math.min(100, (Math.abs(worstDayPnl) / dailyLossLimit) * 100)
      : 0;

    // Consistency: winning days ratio
    const winningDays = dailyStats?.filter((d) => d.is_winning_day).length ?? 0;
    const totalDays = dailyStats?.length ?? account.trading_days_count;
    const winRate = totalDays > 0 ? (winningDays / totalDays) * 100 : 0;

    const consistencyLabel = winRate >= 60 ? 'Strong' : winRate >= 45 ? 'Mixed' : 'Volatile';

    // Overall health
    let health: HealthLevel = 'stable';
    if (drawdownUsedPercent > 70 || worstDayUsedPercent > 70) health = 'at_risk';
    else if (drawdownUsedPercent > 50 || worstDayUsedPercent > 50 || consistencyLabel === 'Volatile') health = 'caution';

    return {
      drawdownUsed,
      drawdownUsedPercent,
      worstDayPnl,
      dailyLossLimit,
      worstDayUsedPercent,
      winningDays,
      totalDays,
      winRate,
      consistencyLabel,
      health,
    };
  }, [account, dailyStats, maxDailyLoss, maxDrawdown]);

  const healthConfig: Record<HealthLevel, { icon: typeof CheckCircle2; label: string; color: string; bg: string; border: string }> = {
    stable: {
      icon: CheckCircle2,
      label: 'Stable',
      color: 'text-success',
      bg: 'bg-success/10',
      border: 'border-success/30',
    },
    caution: {
      icon: AlertTriangle,
      label: 'Caution',
      color: 'text-warning',
      bg: 'bg-warning/10',
      border: 'border-warning/30',
    },
    at_risk: {
      icon: XCircle,
      label: 'At Risk',
      color: 'text-destructive',
      bg: 'bg-destructive/10',
      border: 'border-destructive/30',
    },
  };

  const config = healthConfig[analysis.health];
  const HealthIcon = config.icon;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2 text-lg">
              <Shield className="h-5 w-5 text-primary" />
              Rule Health
            </CardTitle>
            <CardDescription>Your safety rails at a glance</CardDescription>
          </div>
          <div className={`flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm font-semibold ${config.color} ${config.bg} ${config.border}`}>
            <HealthIcon className="h-3.5 w-3.5" />
            {config.label}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          {/* Drawdown usage */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Max drawdown used</span>
              <span className="font-mono font-medium">
                {analysis.drawdownUsed.toFixed(1)}% of {maxDrawdown}%
              </span>
            </div>
            <div className="h-2 rounded-full bg-muted overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${
                  analysis.drawdownUsedPercent > 70 ? 'bg-destructive' :
                  analysis.drawdownUsedPercent > 50 ? 'bg-warning' : 'bg-success'
                }`}
                style={{ width: `${analysis.drawdownUsedPercent}%` }}
              />
            </div>
          </div>

          {/* Worst day */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Worst single day</span>
              <span className="font-mono font-medium">
                {analysis.worstDayPnl < 0 ? `-$${Math.abs(analysis.worstDayPnl).toLocaleString()}` : '$0'}
                <span className="text-muted-foreground ml-1">
                  (limit: -${analysis.dailyLossLimit.toLocaleString()})
                </span>
              </span>
            </div>
            <div className="h-2 rounded-full bg-muted overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${
                  analysis.worstDayUsedPercent > 70 ? 'bg-destructive' :
                  analysis.worstDayUsedPercent > 50 ? 'bg-warning' : 'bg-success'
                }`}
                style={{ width: `${Math.max(2, analysis.worstDayUsedPercent)}%` }}
              />
            </div>
          </div>

          {/* Consistency */}
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Consistency</span>
            <div className="flex items-center gap-2">
              <span className={`font-semibold ${
                analysis.consistencyLabel === 'Strong' ? 'text-success' :
                analysis.consistencyLabel === 'Mixed' ? 'text-warning' : 'text-destructive'
              }`}>
                {analysis.consistencyLabel}
              </span>
              <span className="text-muted-foreground font-mono text-xs">
                {analysis.winningDays}/{analysis.totalDays} winning days
              </span>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
