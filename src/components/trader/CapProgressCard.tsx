import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { TrendingUp, Award, Info } from 'lucide-react';

interface CapProgressCardProps {
  lifetimeCapAmount: number | null;
  lifetimePaidTotal: number;
  lifetimeHeadroom: number | null;
  firstPayoutCapAmount: number | null;
  isFirstPayoutInCycle: boolean;
  payoutSplitPercent: number;
}

/** Qualitative band for lifetime cap usage — no exact percentages. */
function getCapBand(paidPct: number): { label: string; variant: 'default' | 'secondary' | 'destructive' } {
  if (paidPct >= 90) return { label: 'Nearing Limit', variant: 'destructive' };
  if (paidPct >= 60) return { label: 'Well Used', variant: 'secondary' };
  return { label: 'Plenty Available', variant: 'default' };
}

/**
 * Brand-safe cap progress card for trader-facing UI.
 * B2 HARDENED: No exact dollar amounts, percentages, or progress bars.
 * Frames caps as achievement milestones, not restrictions.
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
  const capBand = hasLifetimeCap ? getCapBand(paidPercentage) : null;

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
                  <Badge variant="outline" className="text-xs">First payout cap applies</Badge>
                )}
              </span>
            </div>
            {isFirstPayoutInCycle && (
              <p className="text-xs text-muted-foreground">
                Your first payout has a cap to establish your track record. 
                Subsequent payouts follow your standard rate.
              </p>
            )}
          </div>
        )}

        {/* Lifetime Progress — qualitative band only */}
        {hasLifetimeCap && capBand && (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Lifetime Reward Capacity</span>
              <Badge variant={capBand.variant} className="text-xs">
                {capBand.label}
              </Badge>
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
