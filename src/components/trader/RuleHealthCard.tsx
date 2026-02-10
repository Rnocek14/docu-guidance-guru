import { useMemo } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Shield, CheckCircle2, AlertTriangle, XCircle } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useQuery } from '@tanstack/react-query';
import type { Account, Cohort } from '@/lib/types';

type HealthLevel = 'stable' | 'caution' | 'at_risk';

interface RuleHealthCardProps {
  account: Account & { cohort: Cohort };
}

export function RuleHealthCard({ account }: RuleHealthCardProps) {
  const maxDailyLossPct = account.cohort?.max_daily_loss_percent ?? 5;
  const maxDrawdownPct = account.cohort?.max_total_drawdown_percent ?? 10;

  const { data: dailyStats } = useQuery({
    queryKey: ['rule-health-daily-stats', account.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('account_daily_stats')
        .select('net_pnl, trading_day, is_winning_day, winning_trades, losing_trades, gross_pnl, commissions')
        .eq('account_id', account.id)
        .order('trading_day', { ascending: true });

      if (error) throw error;
      return data;
    },
    enabled: !!account.id,
  });

  const analysis = useMemo(() => {
    // Drawdown
    const drawdownPct = account.highest_balance > 0
      ? ((account.highest_balance - account.current_balance) / account.highest_balance) * 100
      : 0;
    const drawdownUsagePct = Math.min(100, (drawdownPct / maxDrawdownPct) * 100);

    // Worst day (loss-only)
    const losingDays = dailyStats?.filter((d) => Number(d.net_pnl) < 0) ?? [];
    const worstDayPnl = losingDays.length > 0
      ? Math.min(...losingDays.map((d) => Number(d.net_pnl)))
      : null;

    const dailyLossLimit = account.starting_balance * (maxDailyLossPct / 100);
    const worstDayUsagePct = worstDayPnl !== null
      ? Math.min(100, (Math.abs(worstDayPnl) / dailyLossLimit) * 100)
      : 0;

    // Discipline metrics: profit factor + avg win/loss (daily-based)
    const winningDays = dailyStats?.filter((d) => d.is_winning_day) ?? [];
    const totalDays = dailyStats?.length ?? account.trading_days_count;

    // Daily Profit Factor (labeled honestly — trade-level PF needs per-trade data)
    const grossWins = dailyStats?.reduce((sum, d) => {
      const pnl = Number(d.net_pnl);
      return pnl > 0 ? sum + pnl : sum;
    }, 0) ?? 0;
    const grossLosses = dailyStats?.reduce((sum, d) => {
      const pnl = Number(d.net_pnl);
      return pnl < 0 ? sum + Math.abs(pnl) : sum;
    }, 0) ?? 0;

    const profitFactor = grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? Infinity : 0;

    const avgWinDay = winningDays.length > 0
      ? winningDays.reduce((s, d) => s + Number(d.net_pnl), 0) / winningDays.length
      : 0;
    const avgLossDay = losingDays.length > 0
      ? losingDays.reduce((s, d) => s + Number(d.net_pnl), 0) / losingDays.length
      : 0;

    // Volatility Score: stdev of daily P&L relative to daily loss limit
    // This doesn't blow up at mean≈0 and aligns with the risk rails traders actually have
    const dailyPnls = dailyStats?.map((d) => Number(d.net_pnl)) ?? [];
    let varianceLevel: 'low' | 'moderate' | 'high' = 'low';
    let volatilityRatio = 0;
    if (dailyPnls.length >= 3) {
      const mean = dailyPnls.reduce((s, v) => s + v, 0) / dailyPnls.length;
      const variance = dailyPnls.reduce((s, v) => s + (v - mean) ** 2, 0) / dailyPnls.length;
      const stdev = Math.sqrt(variance);
      // Normalize against daily loss limit — stable even when mean ≈ 0
      volatilityRatio = dailyLossLimit > 0 ? stdev / dailyLossLimit : 0;
      if (volatilityRatio > 0.6) varianceLevel = 'high';
      else if (volatilityRatio > 0.3) varianceLevel = 'moderate';
    }

    // Spike Day Ratio: best day as % of total positive P&L — the anti-luck metric
    const positivePnls = dailyPnls.filter((p) => p > 0);
    const totalPositivePnl = positivePnls.reduce((s, v) => s + v, 0);
    const bestDayPnl2 = positivePnls.length > 0 ? Math.max(...positivePnls) : 0;
    const spikeDayRatio = totalPositivePnl > 0 ? (bestDayPnl2 / totalPositivePnl) * 100 : 0;

    // Overall health
    let health: HealthLevel = 'stable';
    if (drawdownUsagePct > 70 || worstDayUsagePct > 70) health = 'at_risk';
    else if (drawdownUsagePct > 50 || worstDayUsagePct > 50 || profitFactor < 1) health = 'caution';

    return {
      drawdownPct,
      drawdownUsagePct,
      worstDayPnl,
      dailyLossLimit,
      worstDayUsagePct,
      hasLosingDays: worstDayPnl !== null,
      winningDayCount: winningDays.length,
      totalDays,
      profitFactor,
      avgWinDay,
      avgLossDay,
      health,
      varianceLevel,
      volatilityRatio,
      spikeDayRatio,
    };
  }, [account, dailyStats, maxDailyLossPct, maxDrawdownPct]);

  const healthConfig: Record<HealthLevel, { icon: typeof CheckCircle2; label: string; color: string; bg: string; border: string }> = {
    stable: { icon: CheckCircle2, label: 'Stable', color: 'text-success', bg: 'bg-success/10', border: 'border-success/30' },
    caution: { icon: AlertTriangle, label: 'Caution', color: 'text-warning', bg: 'bg-warning/10', border: 'border-warning/30' },
    at_risk: { icon: XCircle, label: 'At Risk', color: 'text-destructive', bg: 'bg-destructive/10', border: 'border-destructive/30' },
  };

  const config = healthConfig[analysis.health];
  const HealthIcon = config.icon;

  const barColor = (usagePct: number) =>
    usagePct > 70 ? 'bg-destructive' : usagePct > 50 ? 'bg-warning' : 'bg-success';

  const formatPF = (pf: number) => {
    if (pf === Infinity) return '∞';
    if (pf === 0) return '—';
    return pf.toFixed(2);
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2 text-lg">
              <Shield className="h-5 w-5 text-primary" />
              Rule Health
            </CardTitle>
            <CardDescription>Safety rails &amp; discipline metrics</CardDescription>
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
              <span className="text-muted-foreground">Drawdown used</span>
              <span className="font-mono font-medium">
                {analysis.drawdownPct.toFixed(2)}%
                <span className="text-muted-foreground ml-1">
                  ({analysis.drawdownUsagePct.toFixed(0)}% of {maxDrawdownPct}% limit)
                </span>
              </span>
            </div>
            <div className="h-2 rounded-full bg-muted overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${barColor(analysis.drawdownUsagePct)}`}
                style={{ width: `${Math.max(2, analysis.drawdownUsagePct)}%` }}
              />
            </div>
          </div>

          {/* Worst day */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Worst single day</span>
              {analysis.hasLosingDays ? (
                <span className="font-mono font-medium">
                  -${Math.abs(analysis.worstDayPnl!).toLocaleString()}
                  <span className="text-muted-foreground ml-1">
                    ({analysis.worstDayUsagePct.toFixed(0)}% of limit)
                  </span>
                </span>
              ) : (
                <span className="font-medium text-success">No losing days yet</span>
              )}
            </div>
            {analysis.hasLosingDays && (
              <div className="h-2 rounded-full bg-muted overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all ${barColor(analysis.worstDayUsagePct)}`}
                  style={{ width: `${Math.max(2, analysis.worstDayUsagePct)}%` }}
                />
              </div>
            )}
          </div>

          {/* Discipline metrics */}
          <div className="border-t border-border pt-3 space-y-2">
            <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Discipline</div>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <div className="text-lg font-bold font-mono">{formatPF(analysis.profitFactor)}</div>
                <div className="text-[11px] text-muted-foreground" title="Computed from daily net P&L, not per-trade">Daily Profit Factor</div>
              </div>
              <div>
                <div className="text-lg font-bold font-mono text-success">
                  +${Math.round(analysis.avgWinDay).toLocaleString()}
                </div>
                <div className="text-[11px] text-muted-foreground">Avg Win Day</div>
              </div>
              <div>
                <div className="text-lg font-bold font-mono text-destructive">
                  {analysis.hasLosingDays ? `-$${Math.abs(Math.round(analysis.avgLossDay)).toLocaleString()}` : '—'}
                </div>
                <div className="text-[11px] text-muted-foreground">Avg Loss Day</div>
              </div>
            </div>
          </div>

          {/* Volatility + Spike Day */}
          <div className="border-t border-border pt-3 space-y-3">
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground" title="Standard deviation of daily P&L relative to your daily loss limit. Lower means more consistent sessions.">
                  Volatility Score
                </span>
                <Badge
                  variant={analysis.varianceLevel === 'high' ? 'destructive' : analysis.varianceLevel === 'moderate' ? 'outline' : 'default'}
                  className="text-xs"
                >
                  {analysis.varianceLevel === 'low' ? 'Low' : analysis.varianceLevel === 'moderate' ? 'Moderate' : 'High'}
                </Badge>
              </div>
              <div className="text-[11px] text-muted-foreground">
                {analysis.varianceLevel === 'low' && 'Consistent daily results — this is what reviewers look for.'}
                {analysis.varianceLevel === 'moderate' && 'Some daily swings — tighter risk per session can help.'}
                {analysis.varianceLevel === 'high' && 'Highly variable results — consider smaller position sizes.'}
              </div>
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground" title="How concentrated your profits are in a single day. High concentration suggests luck over consistency.">
                  Profit Distribution
                </span>
                <Badge
                  variant={analysis.spikeDayRatio > 50 ? 'destructive' : analysis.spikeDayRatio > 30 ? 'outline' : 'default'}
                  className="text-xs"
                >
                  {analysis.spikeDayRatio === 0 ? '—' : analysis.spikeDayRatio <= 30 ? 'Good' : analysis.spikeDayRatio <= 50 ? 'Watch' : 'Risky'}
                </Badge>
              </div>
              {analysis.spikeDayRatio > 0 && (
                <div className="text-[11px] text-muted-foreground">
                  {analysis.spikeDayRatio <= 30 && 'Well-distributed profits — strong consistency signal.'}
                  {analysis.spikeDayRatio > 30 && analysis.spikeDayRatio <= 50 && 'Moderate concentration — diversifying winning days strengthens your case.'}
                  {analysis.spikeDayRatio > 50 && 'Most profit from one day — reviewers flag this as luck-dependent.'}
                </div>
              )}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
