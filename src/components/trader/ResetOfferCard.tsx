import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { RotateCcw, Clock, Sparkles, TrendingUp } from 'lucide-react';
import {
  RESET_BUNDLES,
  formatCountdown,
  isUrgencyActive,
  urgencyMsRemaining,
} from '@/lib/reset-bundles';

interface ResetOfferCardProps {
  accountId: string;
  accountNumber: string | number;
  breachDetectedAt: string | null | undefined;
}

/**
 * Breach-moment CTA. Surfaces reset bundles immediately after a breach,
 * with a 24h urgency discount and a 3-pack option.
 *
 * Frontend-only — actual payment + reset issuance happens in
 * /reset/:accountId via create-reset-checkout edge function.
 */
export function ResetOfferCard({ accountId, accountNumber, breachDetectedAt }: ResetOfferCardProps) {
  const [now, setNow] = useState(() => Date.now());
  const urgencyActive = isUrgencyActive(breachDetectedAt);

  useEffect(() => {
    if (!urgencyActive || !breachDetectedAt) return;
    const i = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(i);
  }, [urgencyActive, breachDetectedAt]);

  const remaining = breachDetectedAt ? urgencyMsRemaining(breachDetectedAt) : 0;
  // re-derive after tick
  void now;

  const single = RESET_BUNDLES.single;
  const urgency = RESET_BUNDLES.urgency_single;
  const threePack = RESET_BUNDLES.three_pack;

  return (
    <Card className="border-primary/30 bg-gradient-to-br from-primary/5 via-card to-card">
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <CardTitle className="flex items-center gap-2 text-foreground">
              <RotateCcw className="h-5 w-5 text-primary" />
              Reset and keep going
            </CardTitle>
            <CardDescription>
              Account #{accountNumber} — resets restore your starting balance and reactivate the rules.
              You keep your account number, history, and any earned ladder progress on future passes.
            </CardDescription>
          </div>
          {urgencyActive && (
            <Badge variant="default" className="gap-1.5 bg-primary text-primary-foreground">
              <Clock className="h-3 w-3" />
              {formatCountdown(remaining)} left
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 md:grid-cols-3">
          {/* 24h urgency offer */}
          {urgencyActive && (
            <BundleTile
              accountId={accountId}
              bundleId={urgency.id}
              title={urgency.label}
              price={urgency.priceUsd}
              compareAt={single.priceUsd}
              footnote="1 reset · expires in 24h"
              highlight
              icon={<Sparkles className="h-4 w-4" />}
              badge="Save $20"
            />
          )}

          {/* Single reset (always available) */}
          <BundleTile
            accountId={accountId}
            bundleId={single.id}
            title={single.label}
            price={single.priceUsd}
            footnote="1 reset · use immediately"
            icon={<RotateCcw className="h-4 w-4" />}
          />

          {/* 3-pack bundle */}
          <BundleTile
            accountId={accountId}
            bundleId={threePack.id}
            title={threePack.label}
            price={threePack.priceUsd}
            compareAt={single.priceUsd * threePack.resetCount}
            footnote={`3 resets · $${(threePack.priceUsd / 3).toFixed(0)}/reset · banked`}
            icon={<TrendingUp className="h-4 w-4" />}
            badge="Best Value"
          />
        </div>

        <p className="text-xs text-muted-foreground">
          Reset history and any unused bundle resets are tied to your trader account, not this specific
          challenge. Bundles do not affect clean payout streaks or the lifetime cap.
        </p>
      </CardContent>
    </Card>
  );
}

interface BundleTileProps {
  accountId: string;
  bundleId: string;
  title: string;
  price: number;
  compareAt?: number;
  footnote: string;
  highlight?: boolean;
  icon: React.ReactNode;
  badge?: string;
}

function BundleTile({
  accountId,
  bundleId,
  title,
  price,
  compareAt,
  footnote,
  highlight,
  icon,
  badge,
}: BundleTileProps) {
  return (
    <div
      className={[
        'relative flex flex-col gap-3 rounded-lg border p-4',
        highlight ? 'border-primary bg-primary/5' : 'border-border bg-background',
      ].join(' ')}
    >
      {badge && (
        <Badge variant={highlight ? 'default' : 'secondary'} className="absolute -top-2 right-3 text-[10px]">
          {badge}
        </Badge>
      )}
      <div className="flex items-center gap-2 text-sm font-medium text-foreground">
        {icon}
        {title}
      </div>
      <div className="flex items-baseline gap-2">
        <span className="text-2xl font-bold text-foreground">${price}</span>
        {compareAt && compareAt > price && (
          <span className="text-sm text-muted-foreground line-through">${compareAt}</span>
        )}
      </div>
      <p className="text-xs text-muted-foreground">{footnote}</p>
      <Button asChild variant={highlight ? 'default' : 'outline'} size="sm" className="mt-auto">
        <Link to={`/reset/${accountId}?bundle=${bundleId}`}>Select</Link>
      </Button>
    </div>
  );
}
