import { DashboardLayout, adminNavItems } from '@/components/layout/DashboardLayout';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { supabase, SUPABASE_FUNCTIONS_URL } from '@/integrations/supabase/client';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, AlertTriangle, XCircle, RefreshCw, ExternalLink, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

interface CheckResult {
  ok: boolean;
  detail: string;
}

interface TierData {
  id: string;
  name: string;
  isLive: boolean;
  entryFee: number;
  accountSize: number;
  firstPayoutCap: number;
  splitPercent: number;
  lifetimeCapMultiple: number;
  checks: {
    purchasable: CheckResult;
    stripeWired: CheckResult;
    cohortReady: CheckResult;
    serverGateOk: CheckResult;
  };
}

const CHECK_LABELS: Record<string, { label: string; description: string }> = {
  purchasable: { label: 'Purchasable', description: 'isLive flag enables UI + server acceptance' },
  stripeWired: { label: 'Stripe Wired', description: 'Price ID, Product ID, and API key present' },
  cohortReady: { label: 'Cohort Present', description: 'Active cohort row matches this tier' },
  serverGateOk: { label: 'Server Gate', description: 'create-checkout-session will accept requests' },
};

function CheckIcon({ ok, isLive }: { ok: boolean; isLive: boolean }) {
  if (ok) return <CheckCircle2 className="h-5 w-5 text-emerald-500" />;
  if (!isLive) return <AlertTriangle className="h-5 w-5 text-amber-500" />;
  return <XCircle className="h-5 w-5 text-destructive" />;
}

function TierReadinessCard({ tier }: { tier: TierData }) {
  const checkEntries = Object.entries(tier.checks) as [string, CheckResult][];
  const allOk = checkEntries.every(([, c]) => c.ok);
  const failCount = checkEntries.filter(([, c]) => !c.ok).length;

  return (
    <Card className={cn(
      'relative overflow-hidden',
      tier.isLive && allOk && 'border-emerald-500/50',
      tier.isLive && !allOk && 'border-destructive/50',
      !tier.isLive && 'border-amber-500/30',
    )}>
      {/* Status ribbon */}
      <div className={cn(
        'absolute top-0 left-0 right-0 h-1',
        allOk ? 'bg-emerald-500' : tier.isLive ? 'bg-destructive' : 'bg-amber-500',
      )} />

      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg">{tier.name}</CardTitle>
          <Badge variant={tier.isLive ? 'default' : 'secondary'}>
            {tier.isLive ? 'LIVE' : 'UPCOMING'}
          </Badge>
        </div>
        <CardDescription className="flex gap-3 text-xs">
          <span>${tier.entryFee}</span>
          <span>·</span>
          <span>${tier.accountSize.toLocaleString()} account</span>
          <span>·</span>
          <span>{tier.splitPercent}% split</span>
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-3">
        {/* Summary line */}
        <div className="flex items-center gap-2 text-sm font-medium">
          {allOk ? (
            <>
              <CheckCircle2 className="h-4 w-4 text-emerald-500" />
              <span className="text-emerald-600">All checks passing</span>
            </>
          ) : (
            <>
              {tier.isLive ? (
                <XCircle className="h-4 w-4 text-destructive" />
              ) : (
                <AlertTriangle className="h-4 w-4 text-amber-500" />
              )}
              <span className={tier.isLive ? 'text-destructive' : 'text-amber-600'}>
                {failCount} check{failCount > 1 ? 's' : ''} {tier.isLive ? 'failing' : 'pending'}
              </span>
            </>
          )}
        </div>

        {/* Individual checks */}
        <div className="space-y-2">
          {checkEntries.map(([key, check]) => {
            const meta = CHECK_LABELS[key];
            return (
              <div key={key} className="flex items-start gap-3 p-2 rounded-md bg-muted/50">
                <CheckIcon ok={check.ok} isLive={tier.isLive} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">{meta?.label ?? key}</p>
                  <p className="text-xs text-muted-foreground">{check.detail}</p>
                </div>
              </div>
            );
          })}
        </div>

        {/* Tier details */}
        <div className="pt-2 border-t border-border">
          <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
            <div>First payout cap: <span className="font-medium text-foreground">${tier.firstPayoutCap}</span></div>
            <div>Lifetime cap: <span className="font-medium text-foreground">{tier.lifetimeCapMultiple}× entry</span></div>
          </div>
        </div>

        {/* CTA */}
        <div className="pt-2">
          {tier.isLive ? (
            <Button variant="outline" size="sm" className="w-full" asChild>
              <a href={`/checkout?tier=${tier.id}`} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="h-3.5 w-3.5 mr-1.5" />
                Preview Checkout
              </a>
            </Button>
          ) : (
            <Button variant="secondary" size="sm" className="w-full" disabled>
              Not yet purchasable
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export default function TierReadiness() {
  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['tier-readiness'],
    queryFn: async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Not authenticated');

      const response = await fetch(`${SUPABASE_FUNCTIONS_URL}/get-tier-readiness`, {
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || 'Failed to fetch tier readiness');
      }

      return response.json() as Promise<{ tiers: TierData[] }>;
    },
    staleTime: 30_000,
  });

  const tiers = data?.tiers ?? [];

  return (
    <DashboardLayout title="Tier Readiness" navItems={adminNavItems}>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-bold tracking-tight">Launch Readiness</h2>
            <p className="text-muted-foreground">
              Pre-flight checklist for each pricing tier. All checks must pass before flipping a tier live.
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => refetch()}
            disabled={isFetching}
          >
            <RefreshCw className={cn('h-4 w-4 mr-1.5', isFetching && 'animate-spin')} />
            Refresh
          </Button>
        </div>

        {isLoading && (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
          </div>
        )}

        {error && (
          <Card className="border-destructive/50">
            <CardContent className="pt-6">
              <p className="text-destructive text-sm">{(error as Error).message}</p>
            </CardContent>
          </Card>
        )}

        {!isLoading && !error && (
          <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
            {tiers.map((tier) => (
              <TierReadinessCard key={tier.id} tier={tier} />
            ))}
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
