import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CalendarDays, CheckCircle2 } from 'lucide-react';

interface PayoutWinningDaysCardProps {
  tradingDaysSincePayout: number;
  requiredTradingDays: number;
  winningDaysRemaining: number;
  progressPct: number;
  isMet: boolean;
}

function bandProgress(pct: number): string {
  if (pct >= 100) return 'Complete';
  if (pct >= 75) return 'Almost there';
  if (pct >= 40) return 'On track';
  return 'Getting started';
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
            Winning Days Requirement Met
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            You've completed enough winning trading days since your last payout to meet the requirement.
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
          Winning Trading Days Required
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          <p className="text-sm font-medium">{bandProgress(progressPct)}</p>
          <p className="text-xs text-muted-foreground">
            Additional winning trading days are needed since your last payout
            before requesting another.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
