import { Card, CardContent } from '@/components/ui/card';
import { Wallet, Trophy, Target, ArrowRight } from 'lucide-react';

interface PayoutTrackerBarProps {
  paidTotal: number;
  firstPayoutCap: number;
  lifetimeCap: number;
  cleanPayoutCount?: number;
  payoutCadenceDays?: number;
}

/**
 * Visible progress bar across the top of the trader dashboard.
 * Shows $ paid → first payout cap → lifetime cap.
 *
 * Per memory rule (Trader vs Admin Precision): qualitative bands are used
 * for derived headroom/risk numbers. The values rendered here are
 * concrete published values (trader's own paid total + tier-published caps),
 * not derived risk metrics, so showing exact dollars is appropriate.
 */
export function PayoutTrackerBar({
  paidTotal,
  firstPayoutCap,
  lifetimeCap,
  cleanPayoutCount = 0,
  payoutCadenceDays = 14,
}: PayoutTrackerBarProps) {
  const safePaid = Math.max(0, paidTotal);
  const safeLifetime = Math.max(1, lifetimeCap);
  const pct = Math.min(100, (safePaid / safeLifetime) * 100);
  const firstMarker = Math.min(100, (firstPayoutCap / safeLifetime) * 100);
  const hitFirst = safePaid >= firstPayoutCap;
  const proPayoutsNeeded = Math.max(0, 3 - cleanPayoutCount);

  return (
    <Card className="bg-gradient-to-r from-card via-card to-primary/5">
      <CardContent className="py-4 px-5">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-3 text-xs">
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <Wallet className="h-3.5 w-3.5" />
            <span className="font-semibold text-foreground tabular-nums">
              ${safePaid.toLocaleString()}
            </span>{' '}
            paid lifetime
          </span>
          <span className="flex items-center gap-3 text-muted-foreground">
            <span className="flex items-center gap-1">
              <Target className="h-3 w-3" />
              First payout&nbsp;
              <span className="tabular-nums text-foreground">${firstPayoutCap.toLocaleString()}</span>
            </span>
            <span className="flex items-center gap-1">
              <Trophy className="h-3 w-3" />
              Lifetime cap&nbsp;
              <span className="tabular-nums text-foreground">${lifetimeCap.toLocaleString()}</span>
            </span>
          </span>
        </div>
        <div className="relative h-2 rounded-full bg-muted overflow-hidden">
          <div
            className="absolute inset-y-0 left-0 bg-gradient-to-r from-primary/70 to-primary transition-all"
            style={{ width: `${pct}%` }}
          />
          {/* First payout marker */}
          <div
            className="absolute inset-y-0 w-px bg-foreground/40"
            style={{ left: `${firstMarker}%` }}
            aria-hidden
          />
        </div>
        <div className="flex justify-between text-[10px] text-muted-foreground mt-1.5">
          <span>Start</span>
          <span className={hitFirst ? 'text-success font-medium' : ''}>
            {hitFirst ? '✓ ' : ''}First payout cap
          </span>
          <span>Lifetime cap</span>
        </div>
        {hitFirst && (
          <div className="mt-3 pt-3 border-t border-border/40 flex flex-wrap items-center justify-between gap-2 text-xs">
            <span className="text-muted-foreground">
              First cap cleared. Subsequent payouts paid every{' '}
              <span className="text-foreground font-medium">{payoutCadenceDays} days</span>,{' '}
              <span className="text-foreground font-medium">paced for platform stability</span>.
            </span>
            {proPayoutsNeeded > 0 ? (
              <span className="flex items-center gap-1 text-primary">
                <ArrowRight className="h-3 w-3" />
                {proPayoutsNeeded} clean payout{proPayoutsNeeded === 1 ? '' : 's'} to Pro tier (85/15 split)
              </span>
            ) : (
              <span className="flex items-center gap-1 text-success font-medium">
                <ArrowRight className="h-3 w-3" />
                Pro tier unlocked — 85/15 split active
              </span>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
