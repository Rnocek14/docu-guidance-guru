import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { TrendingUp, CheckCircle2 } from 'lucide-react';

interface PayoutProfitBufferCardProps {
  profitBufferRequired: number;
  realizedProfit: number;
  profitBufferRemaining: number;
  profitBufferMet: boolean;
  profitBufferProgressPct?: number;
}

function bandProgress(pct: number): string {
  if (pct >= 100) return 'Complete';
  if (pct >= 75) return 'Almost there';
  if (pct >= 40) return 'On track';
  return 'Getting started';
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
            You've accumulated sufficient profit since your last payout to meet the buffer requirement.
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
        <div className="space-y-2">
          <p className="text-sm font-medium">{bandProgress(progress)}</p>
          <p className="text-xs text-muted-foreground">
            Additional profit is needed above the buffer threshold before requesting a payout.
            Keep trading consistently to build your buffer.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
