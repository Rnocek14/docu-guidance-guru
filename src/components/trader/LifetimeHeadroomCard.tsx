import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Wallet } from 'lucide-react';

interface LifetimeHeadroomCardProps {
  lifetimeCapAmount: number | null;
  lifetimePaidTotal: number;
  lifetimeHeadroom: number | null;
}

export function LifetimeHeadroomCard({
  lifetimeCapAmount,
  lifetimePaidTotal,
  lifetimeHeadroom,
}: LifetimeHeadroomCardProps) {
  // Don't show if no lifetime cap is configured
  if (lifetimeCapAmount === null || lifetimeHeadroom === null) {
    return null;
  }

  const paidPercentage = (lifetimePaidTotal / lifetimeCapAmount) * 100;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <Wallet className="h-4 w-4 text-muted-foreground" />
          Lifetime Payout Headroom
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <Progress value={paidPercentage} className="h-2" />
        <div className="flex justify-between text-sm">
          <span className="text-muted-foreground">
            ${lifetimePaidTotal.toLocaleString()} paid
          </span>
          <span className="font-medium">
            ${lifetimeHeadroom.toLocaleString()} remaining
          </span>
        </div>
        <p className="text-xs text-muted-foreground">
          Total available: ${lifetimeCapAmount.toLocaleString()}
        </p>
      </CardContent>
    </Card>
  );
}
