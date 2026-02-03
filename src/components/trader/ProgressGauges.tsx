import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Badge } from '@/components/ui/badge';
import { Target, TrendingDown, AlertTriangle, Calendar } from 'lucide-react';
import { cn } from '@/lib/utils';

interface RuleSnapshot {
  max_daily_loss_percent: number;
  max_total_drawdown_percent: number;
  profit_target_percent: number;
  min_trading_days: number;
}

interface ProgressGaugesProps {
  currentBalance: number;
  startingBalance: number;
  highestBalance: number;
  dailyPnl: number;
  totalPnl: number;
  tradingDaysCount: number;
  ruleSnapshot: RuleSnapshot | null;
}

export function ProgressGauges({
  currentBalance,
  startingBalance,
  highestBalance,
  dailyPnl,
  totalPnl,
  tradingDaysCount,
  ruleSnapshot,
}: ProgressGaugesProps) {
  if (!ruleSnapshot) {
    return null;
  }

  // Calculate metrics
  const profitPercent = (totalPnl / startingBalance) * 100;
  const profitProgress = Math.min(100, Math.max(0, (profitPercent / ruleSnapshot.profit_target_percent) * 100));
  
  const drawdownPercent = ((highestBalance - currentBalance) / highestBalance) * 100;
  const drawdownProgress = Math.min(100, (drawdownPercent / ruleSnapshot.max_total_drawdown_percent) * 100);
  
  const dailyLossPercent = Math.abs(Math.min(0, (dailyPnl / startingBalance) * 100));
  const dailyLossProgress = Math.min(100, (dailyLossPercent / ruleSnapshot.max_daily_loss_percent) * 100);
  
  const tradingDaysProgress = Math.min(100, (tradingDaysCount / ruleSnapshot.min_trading_days) * 100);

  const getProgressColor = (value: number, isRisk: boolean = false) => {
    if (isRisk) {
      if (value >= 100) return 'bg-destructive';
      if (value >= 80) return 'bg-warning';
      return 'bg-success';
    }
    if (value >= 100) return 'bg-success';
    if (value >= 50) return 'bg-primary';
    return 'bg-muted-foreground';
  };

  const gauges = [
    {
      title: 'Profit Target',
      icon: Target,
      current: profitPercent.toFixed(2),
      target: ruleSnapshot.profit_target_percent,
      progress: profitProgress,
      unit: '%',
      isRisk: false,
      description: profitProgress >= 100 ? '✓ Target reached!' : `${(ruleSnapshot.profit_target_percent - profitPercent).toFixed(2)}% to go`,
    },
    {
      title: 'Total Drawdown',
      icon: TrendingDown,
      current: drawdownPercent.toFixed(2),
      target: ruleSnapshot.max_total_drawdown_percent,
      progress: drawdownProgress,
      unit: '%',
      isRisk: true,
      description: drawdownProgress >= 80 ? '⚠️ Approaching limit!' : `${(ruleSnapshot.max_total_drawdown_percent - drawdownPercent).toFixed(2)}% remaining`,
    },
    {
      title: 'Daily Loss',
      icon: AlertTriangle,
      current: dailyLossPercent.toFixed(2),
      target: ruleSnapshot.max_daily_loss_percent,
      progress: dailyLossProgress,
      unit: '%',
      isRisk: true,
      description: dailyLossProgress >= 80 ? '⚠️ Approaching daily limit!' : `${(ruleSnapshot.max_daily_loss_percent - dailyLossPercent).toFixed(2)}% remaining today`,
    },
    {
      title: 'Trading Days',
      icon: Calendar,
      current: tradingDaysCount.toString(),
      target: ruleSnapshot.min_trading_days,
      progress: tradingDaysProgress,
      unit: ' days',
      isRisk: false,
      description: tradingDaysProgress >= 100 ? '✓ Requirement met!' : `${ruleSnapshot.min_trading_days - tradingDaysCount} more days needed`,
    },
  ];

  return (
    <div className="grid gap-4 md:grid-cols-2">
      {gauges.map((gauge) => (
        <Card key={gauge.title}>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <gauge.icon className="h-4 w-4" />
                {gauge.title}
              </CardTitle>
              {gauge.isRisk && gauge.progress >= 80 && (
                <Badge variant="destructive" className="text-xs">
                  Warning
                </Badge>
              )}
              {!gauge.isRisk && gauge.progress >= 100 && (
                <Badge variant="secondary" className="text-xs bg-success text-success-foreground">
                  Complete
                </Badge>
              )}
            </div>
            <CardDescription>
              Limit: {gauge.target}{gauge.unit}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="relative">
              <Progress
                value={gauge.progress}
                className={cn('h-3', gauge.isRisk && gauge.progress >= 80 && '[&>div]:bg-warning', gauge.progress >= 100 && gauge.isRisk && '[&>div]:bg-destructive')}
              />
              {/* Warning threshold line at 80% for risk gauges */}
              {gauge.isRisk && (
                <div
                  className="absolute top-0 h-3 w-0.5 bg-warning/70"
                  style={{ left: '80%' }}
                />
              )}
            </div>
            <div className="flex justify-between items-center">
              <span className={cn(
                'text-2xl font-bold',
                gauge.isRisk && gauge.progress >= 80 && 'text-warning',
                gauge.isRisk && gauge.progress >= 100 && 'text-destructive',
                !gauge.isRisk && gauge.progress >= 100 && 'text-success'
              )}>
                {gauge.current}{gauge.unit}
              </span>
              <span className="text-sm text-muted-foreground">
                {gauge.description}
              </span>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
