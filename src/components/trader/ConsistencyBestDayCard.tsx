import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Star, CheckCircle2 } from 'lucide-react';

interface ConsistencyBestDayCardProps {
  bestDayPnl: number;
  bestDayPctOfTarget: number;
  maxCapPercent: number;
  isMet: boolean;
}

export function ConsistencyBestDayCard({
  bestDayPnl,
  bestDayPctOfTarget,
  maxCapPercent,
  isMet,
}: ConsistencyBestDayCardProps) {
  const progress = Math.min(100, (bestDayPctOfTarget / maxCapPercent) * 100);

  if (isMet) {
    return (
      <Card className="border-success/30 bg-success/5">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-success" />
            Best Day Rule Met
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Your best day ({bestDayPctOfTarget.toFixed(1)}% of target) is within the {maxCapPercent}% cap.
            No single day dominates your performance.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-warning/30 bg-warning/5">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <Star className="h-4 w-4 text-warning" />
          Best Day Cap Exceeded
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          <Progress value={progress} className="h-2 [&>div]:bg-warning" />
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">
              Best day: {bestDayPctOfTarget.toFixed(1)}% of target (${bestDayPnl.toLocaleString()})
            </span>
            <span className="font-medium">
              Cap: {maxCapPercent}%
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            No single trading day can exceed {maxCapPercent}% of your profit target.
            Continue trading to distribute your profits more evenly across days.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
