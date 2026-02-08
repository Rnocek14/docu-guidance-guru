import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Badge } from '@/components/ui/badge';
import { Shield, TrendingUp, Award, Info } from 'lucide-react';

interface CapProgressCardProps {
  lifetimeCapAmount: number | null;
  lifetimePaidTotal: number;
  lifetimeHeadroom: number | null;
  firstPayoutCapAmount: number | null;
  isFirstPayoutInCycle: boolean;
  payoutSplitPercent: number;
}

/**
 * Brand-safe cap progress card for trader-facing UI.
 * Frames caps as achievement milestones, not restrictions.
 * Part of hardening item D (reputation armor).
 */
export function CapProgressCard({
  lifetimeCapAmount,
  lifetimePaidTotal,
  lifetimeHeadroom,
  firstPayoutCapAmount,
  isFirstPayoutInCycle,
  payoutSplitPercent,
}: CapProgressCardProps) {
  // Don't show if no caps are configured
  if (lifetimeCapAmount === null && firstPayoutCapAmount === null) {
    return null;
  }

  const hasLifetimeCap = lifetimeCapAmount !== null && lifetimeHeadroom !== null;
  const paidPercentage = hasLifetimeCap ? (lifetimePaidTotal / lifetimeCapAmount) * 100 : 0;
  const firstPayoutComplete = !isFirstPayoutInCycle;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <Award className="h-4 w-4 text-primary" />
          Reward Progress
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Payout Rate */}
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground flex items-center gap-1">
            <TrendingUp className="h-3.5 w-3.5" />
            Your Payout Rate
          </span>
          <Badge variant="secondary" className="font-bold">
            {payoutSplitPercent}%
          </Badge>
        </div>

        {/* First Payout Milestone */}
        {firstPayoutCapAmount !== null && (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">First Payout Milestone</span>
              <span className="font-medium">
                {firstPayoutComplete ? (
                  <Badge variant="default" className="text-xs">✓ Complete</Badge>
                ) : (
                  <span>${firstPayoutCapAmount.toLocaleString()} max</span>
                )}
              </span>
            </div>
            {isFirstPayoutInCycle && (
              <p className="text-xs text-muted-foreground">
                Your first payout is capped at ${firstPayoutCapAmount.toLocaleString()} to establish your track record. 
                Subsequent payouts follow your standard rate.
              </p>
            )}
          </div>
        )}

        {/* Lifetime Progress */}
        {hasLifetimeCap && (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Lifetime Reward Capacity</span>
              <span className="font-medium">{Math.round(paidPercentage)}%</span>
            </div>
            <Progress value={paidPercentage} className="h-2" />
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>${lifetimePaidTotal.toLocaleString()} earned</span>
              <span>${lifetimeHeadroom!.toLocaleString()} remaining</span>
            </div>
          </div>
        )}

        {/* Educational footer */}
        <div className="flex items-start gap-2 text-xs text-muted-foreground bg-muted/50 rounded-lg p-3 mt-2">
          <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          <p>
            Reward caps are designed to sustain platform quality and ensure consistent payouts for all traders. 
            Higher earning tiers are available as you demonstrate sustained performance.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
