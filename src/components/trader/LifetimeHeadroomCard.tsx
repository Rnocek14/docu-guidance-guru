import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Wallet } from 'lucide-react';

interface LifetimeHeadroomCardProps {
  lifetimeCapAmount: number | null;
  lifetimePaidTotal: number;
  lifetimeHeadroom: number | null;
}

/** Qualitative band for lifetime headroom — no exact dollars. */
function getHeadroomBand(paidPct: number): { label: string; variant: 'default' | 'secondary' | 'destructive' } {
  if (paidPct >= 90) return { label: 'Nearing Limit', variant: 'destructive' };
  if (paidPct >= 60) return { label: 'Well Used', variant: 'secondary' };
  return { label: 'Plenty Remaining', variant: 'default' };
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
  const band = getHeadroomBand(paidPercentage);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <Wallet className="h-4 w-4 text-muted-foreground" />
          Lifetime Payout Headroom
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">Capacity Status</span>
          <Badge variant={band.variant} className="text-xs">
            {band.label}
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground">
          Your lifetime reward capacity determines how much you can earn on this account tier.
        </p>
      </CardContent>
    </Card>
  );
}
