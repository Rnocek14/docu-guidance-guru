import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Lock, Scale, TrendingDown, Target, Calendar, BarChart3 } from 'lucide-react';
import { format } from 'date-fns';

interface RuleSnapshot {
  cohort_id: string;
  cohort_name: string;
  cohort_version: number;
  max_daily_loss_percent: number;
  max_total_drawdown_percent: number;
  profit_target_percent: number;
  min_trading_days: number;
  max_position_size_percent: number;
  frozen_at: string;
}

interface RuleSnapshotCardProps {
  ruleSnapshot: RuleSnapshot | null;
}

export function RuleSnapshotCard({ ruleSnapshot }: RuleSnapshotCardProps) {
  if (!ruleSnapshot) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Lock className="h-5 w-5" />
            Rule Snapshot
          </CardTitle>
          <CardDescription>No rules available</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Rule snapshot not found for this account.
          </p>
        </CardContent>
      </Card>
    );
  }

  const rules = [
    {
      icon: TrendingDown,
      label: 'Max Daily Loss',
      value: `${ruleSnapshot.max_daily_loss_percent}%`,
      description: 'Maximum loss allowed in a single day',
    },
    {
      icon: Scale,
      label: 'Max Drawdown (EOD trailing)',
      value: `${ruleSnapshot.max_total_drawdown_percent}%`,
      description: 'Trails highest EOD balance; locks at starting balance',
    },
    {
      icon: Target,
      label: 'Performance Target',
      value: `${ruleSnapshot.profit_target_percent}%`,
      description: 'Required performance target to pass the evaluation',
    },
    {
      icon: Calendar,
      label: 'Min Trading Days',
      value: ruleSnapshot.min_trading_days.toString(),
      description: 'Minimum days you must trade',
    },
    {
      icon: BarChart3,
      label: 'Max Position Size',
      value: `${ruleSnapshot.max_position_size_percent}%`,
      description: 'Maximum size per position',
    },
  ];

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="space-y-1">
            <CardTitle className="flex items-center gap-2">
              <Lock className="h-5 w-5 text-primary" />
              Rule Snapshot
            </CardTitle>
            <CardDescription>
              These rules are frozen and cannot change during your challenge
            </CardDescription>
          </div>
          <Badge variant="outline" className="shrink-0">
            {ruleSnapshot.cohort_name} v{ruleSnapshot.cohort_version}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {rules.map((rule) => (
            <div
              key={rule.label}
              className="flex items-start gap-3 p-3 rounded-lg border bg-muted/30"
            >
              <div className="rounded-md bg-primary/10 p-2">
                <rule.icon className="h-4 w-4 text-primary" />
              </div>
              <div className="space-y-0.5">
                <p className="text-sm font-medium">{rule.label}</p>
                <p className="text-2xl font-bold">{rule.value}</p>
                <p className="text-xs text-muted-foreground">{rule.description}</p>
              </div>
            </div>
          ))}
        </div>
        {ruleSnapshot.frozen_at && !isNaN(new Date(ruleSnapshot.frozen_at).getTime()) && (
          <p className="text-xs text-muted-foreground border-t pt-4">
            Frozen on {format(new Date(ruleSnapshot.frozen_at), 'PPP \'at\' p')}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
