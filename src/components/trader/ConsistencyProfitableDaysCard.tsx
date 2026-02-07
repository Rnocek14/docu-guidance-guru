import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { CalendarCheck, CheckCircle2 } from 'lucide-react';

interface ConsistencyProfitableDaysCardProps {
  profitableDays: number;
  minRequired: number;
  isMet: boolean;
}

export function ConsistencyProfitableDaysCard({
  profitableDays,
  minRequired,
  isMet,
}: ConsistencyProfitableDaysCardProps) {
  const progress = minRequired > 0 ? Math.min(100, (profitableDays / minRequired) * 100) : 100;
  const remaining = Math.max(0, minRequired - profitableDays);

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
            You've had {profitableDays} profitable trading day{profitableDays !== 1 ? 's' : ''}, 
            meeting the {minRequired}-day minimum.
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
        <div className="space-y-3">
          <Progress value={progress} className="h-2" />
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">
              {profitableDays} / {minRequired} days
            </span>
            <span className="font-medium">
              {remaining} remaining
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            You need at least {minRequired} profitable trading day{minRequired !== 1 ? 's' : ''} to 
            demonstrate consistent performance before passing.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
