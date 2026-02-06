import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { TrendingUp, CheckCircle2 } from 'lucide-react';

interface PayoutProfitBufferCardProps {
  profitBufferRequired: number;
  realizedProfit: number;
  profitBufferRemaining: number;
  profitBufferMet: boolean;
  profitBufferProgressPct?: number;
}

export function PayoutProfitBufferCard({
  profitBufferRequired,
  realizedProfit,
  profitBufferRemaining,
  profitBufferMet,
  profitBufferProgressPct,
}: PayoutProfitBufferCardProps) {
  const progress = profitBufferProgressPct ?? (profitBufferRequired > 0
    ? Math.min(100, (realizedProfit / profitBufferRequired) * 100)
    : 100);

  if (profitBufferMet) {
    return (
      <Card className="border-success/30 bg-success/5">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-success" />
            Profit Buffer Met
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            You've accumulated ${realizedProfit.toFixed(2)} in profit since your last payout,
            exceeding the ${profitBufferRequired.toFixed(0)} requirement.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-warning/30 bg-warning/5">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <TrendingUp className="h-4 w-4 text-warning" />
          Profit Buffer Required
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          <Progress value={progress} className="h-2" />
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">
              ${realizedProfit.toFixed(2)} / ${profitBufferRequired.toFixed(0)}
            </span>
            <span className="font-medium">
              ${profitBufferRemaining.toFixed(2)} remaining
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            You need to accumulate at least ${profitBufferRequired.toFixed(0)} in profit
            since your last payout before requesting another.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
