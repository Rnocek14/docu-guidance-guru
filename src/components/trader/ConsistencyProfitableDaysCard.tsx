import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CalendarCheck, CheckCircle2 } from 'lucide-react';

interface ConsistencyProfitableDaysCardProps {
  profitableDays: number;
  minRequired: number;
  isMet: boolean;
}

function bandProgress(achieved: number, required: number): string {
  if (required <= 0 || achieved >= required) return 'Complete';
  const pct = (achieved / required) * 100;
  if (pct >= 75) return 'Almost there';
  if (pct >= 40) return 'On track';
  return 'Getting started';
}

export function ConsistencyProfitableDaysCard({
  profitableDays,
  minRequired,
  isMet,
}: ConsistencyProfitableDaysCardProps) {
  if (isMet) {
    return (
      <Card className="border-success/30 bg-success/5">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-success" />
            Profitable Days Requirement Met
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            You've met the minimum profitable trading days requirement,
            demonstrating consistent performance.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-warning/30 bg-warning/5">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <CalendarCheck className="h-4 w-4 text-warning" />
          Profitable Days Required
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          <p className="text-sm font-medium">{bandProgress(profitableDays, minRequired)}</p>
          <p className="text-xs text-muted-foreground">
            Additional profitable trading days are needed to demonstrate
            consistent performance before passing.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
