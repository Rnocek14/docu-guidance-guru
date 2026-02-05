import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Clock, CheckCircle2 } from 'lucide-react';
import { format } from 'date-fns';

interface PayoutCoolingCardProps {
  daysSincePass: number;
  coolingPeriodDays: number;
  windowOpensAt: string | null | undefined;
  isWindowOpen: boolean;
}

// Safe date parsing for YYYY-MM-DD format without timezone ambiguity
function parseLocalDate(dateStr: string | null | undefined): Date | null {
  if (!dateStr || typeof dateStr !== 'string') return null;
  
  try {
    // Match YYYY-MM-DD format
    const match = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!match) return null;
    
    const y = Number(match[1]);
    const m = Number(match[2]);
    const d = Number(match[3]);
    const date = new Date(y, m - 1, d);
    
    // Validate the date is real (not NaN or invalid)
    if (isNaN(date.getTime())) return null;
    return date;
  } catch {
    return null;
  }
}

export function PayoutCoolingCard({ 
  daysSincePass, 
  coolingPeriodDays, 
  windowOpensAt,
  isWindowOpen 
}: PayoutCoolingCardProps) {
  const daysRemaining = Math.max(0, coolingPeriodDays - daysSincePass);
  const progress = coolingPeriodDays > 0 
    ? Math.min(100, (daysSincePass / coolingPeriodDays) * 100) 
    : 100;
  
  // Safe date formatting - no timezone ambiguity
  const parsedDate = parseLocalDate(windowOpensAt);
  const formattedDate = parsedDate ? format(parsedDate, 'MMM d, yyyy') : 'soon';
  
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
