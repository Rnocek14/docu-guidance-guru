import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Star, CheckCircle2 } from 'lucide-react';

interface ConsistencyBestDayCardProps {
  bestDayPnl: number;
  bestDayPctOfTarget: number;
  maxCapPercent: number;
  isMet: boolean;
}

export function ConsistencyBestDayCard({
  bestDayPctOfTarget,
  maxCapPercent,
  isMet,
}: ConsistencyBestDayCardProps) {
  // Determine status band
  const ratio = bestDayPctOfTarget / maxCapPercent;
  const status: 'good' | 'watch' | 'risky' = ratio <= 0.8 ? 'good' : ratio <= 1.0 ? 'watch' : 'risky';

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
            Your profits are well-distributed across trading days.
            No single day dominates your performance.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-warning/30 bg-warning/5">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Star className="h-4 w-4 text-warning" />
            Best Day Distribution
          </CardTitle>
          <Badge
            variant={status === 'watch' ? 'outline' : 'destructive'}
            className="text-xs"
          >
            {status === 'watch' ? 'Watch' : 'Risky'}
          </Badge>
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">
            Your profits are concentrated in too few days. Reviewers prefer
            profits distributed across multiple trading days.
          </p>
          <p className="text-xs text-muted-foreground/70">
            Continue trading to spread your gains more evenly. This rule ensures
            consistency, not just a single lucky day.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
