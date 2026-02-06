import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { CalendarDays, CheckCircle2 } from 'lucide-react';

interface PayoutWinningDaysCardProps {
  tradingDaysSincePayout: number;
  requiredTradingDays: number;
  winningDaysRemaining: number;
  progressPct: number;
  isMet: boolean;
}

export function PayoutWinningDaysCard({
  tradingDaysSincePayout,
  requiredTradingDays,
  winningDaysRemaining,
  progressPct,
  isMet,
}: PayoutWinningDaysCardProps) {
  if (isMet) {
    return (
      <Card className="border-success/30 bg-success/5">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-success" />
            Trading Days Requirement Met
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            You've completed {tradingDaysSincePayout} trading day{tradingDaysSincePayout !== 1 ? 's' : ''} since
            your last payout, meeting the {requiredTradingDays}-day requirement.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-warning/30 bg-warning/5">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <CalendarDays className="h-4 w-4 text-warning" />
          Trading Days Required
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          <Progress value={progressPct} className="h-2" />
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">
              {tradingDaysSincePayout} / {requiredTradingDays} days
            </span>
            <span className="font-medium">
              {winningDaysRemaining} remaining
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            You need at least {requiredTradingDays} trading day{requiredTradingDays !== 1 ? 's' : ''} since
            your last payout before requesting another.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
