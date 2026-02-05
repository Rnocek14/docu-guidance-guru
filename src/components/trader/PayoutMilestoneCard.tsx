import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Milestone, CheckCircle2 } from 'lucide-react';

interface PayoutMilestoneCardProps {
  firstPayoutCapAmount: number | null;
  isFirstPayoutInCycle: boolean;
}

export function PayoutMilestoneCard({ firstPayoutCapAmount, isFirstPayoutInCycle }: PayoutMilestoneCardProps) {
  // Don't show if no first payout cap is configured
  if (firstPayoutCapAmount === null) {
    return null;
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <Milestone className="h-4 w-4 text-muted-foreground" />
          First Payout Milestone
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex items-baseline gap-2">
          <span className="text-2xl font-bold">${firstPayoutCapAmount.toLocaleString()}</span>
          {!isFirstPayoutInCycle && (
            <CheckCircle2 className="h-4 w-4 text-success" />
          )}
        </div>
        <p className="text-xs text-muted-foreground mt-1">
          {isFirstPayoutInCycle
            ? 'Subsequent payouts are uncapped once consistency is demonstrated.'
            : 'Milestone completed! Your payouts are no longer capped.'}
        </p>
      </CardContent>
    </Card>
  );
}
