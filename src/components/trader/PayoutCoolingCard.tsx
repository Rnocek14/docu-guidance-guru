import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Clock, CheckCircle2 } from 'lucide-react';
import { format, parseISO, isValid } from 'date-fns';

interface PayoutCoolingCardProps {
  daysSincePass: number;
  coolingPeriodDays: number;
  windowOpensAt: string | null | undefined;
  isWindowOpen: boolean;
}

export function PayoutCoolingCard({ 
  daysSincePass, 
  coolingPeriodDays, 
  windowOpensAt,
  isWindowOpen 
}: PayoutCoolingCardProps) {
  const daysRemaining = Math.max(0, coolingPeriodDays - daysSincePass);
  const progress = Math.min(100, (daysSincePass / coolingPeriodDays) * 100);
  
  // FIX: Truly safe date parsing - handle null, undefined, invalid, and unexpected formats
  let formattedDate = 'soon';
  try {
    if (windowOpensAt && typeof windowOpensAt === 'string' && windowOpensAt.length > 0) {
      const parsed = parseISO(windowOpensAt);
      if (isValid(parsed)) {
        formattedDate = format(parsed, 'MMM d, yyyy');
      }
    }
  } catch {
    formattedDate = 'soon';
  }
  
  if (isWindowOpen) {
    return (
      <Card className="border-success/30 bg-success/5">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-success" />
            Payout Window Open
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Your payout window is now open. You can request your payout.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-warning/30 bg-warning/5">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <Clock className="h-4 w-4 text-warning" />
          Payout Window Opening Soon
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          <Progress value={progress} className="h-2" />
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">
              {daysRemaining} {daysRemaining === 1 ? 'day' : 'days'} remaining
            </span>
            <span className="font-medium">
              Opens {formattedDate}
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            You've earned payout eligibility! Your payout window opens after 
            a {coolingPeriodDays}-day consistency verification period.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
