import { DashboardLayout, adminNavItems } from '@/components/layout/DashboardLayout';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { supabase, SUPABASE_FUNCTIONS_URL } from '@/integrations/supabase/client';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, AlertTriangle, XCircle, RefreshCw, ExternalLink, Loader2, ShieldCheck } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useState } from 'react';

interface CheckResult {
  ok: boolean;
  detail: string;
  verifyUnavailable?: boolean;
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

type CheckKey = keyof TierData['checks'];

const CHECK_LABELS: Record<CheckKey, { label: string; description: string }> = {
  purchasable: { label: 'Purchasable', description: 'isLive flag enables UI + server acceptance' },
  stripeWired: { label: 'Stripe Wired', description: 'Price ID, Product ID, and API key present' },
  cohortReady: { label: 'Cohort Present', description: 'Active cohort row matches this tier' },
  serverGateOk: { label: 'Server Gate', description: 'create-checkout-session will accept requests' },
};

function CheckIcon({ ok, isLive, verifyUnavailable }: { ok: boolean; isLive: boolean; verifyUnavailable?: boolean }) {
  if (ok) return <CheckCircle2 className="h-5 w-5 text-emerald-500" />;
  if (verifyUnavailable) return <AlertTriangle className="h-5 w-5 text-amber-500" />;
  if (!isLive) return <AlertTriangle className="h-5 w-5 text-amber-500" />;
  return <XCircle className="h-5 w-5 text-destructive" />;
}

function TierReadinessCard({ tier }: { tier: TierData }) {
  const checkEntries = Object.entries(tier.checks) as [CheckKey, CheckResult][];
  const allOk = checkEntries.every(([, c]) => c.ok);
  const failCount = checkEntries.filter(([, c]) => !c.ok).length;

  return (
    <Card className={cn(
      'relative overflow-hidden',
      tier.isLive && allOk && 'border-emerald-500/50',
      tier.isLive && !allOk && 'border-destructive/50',
      !tier.isLive && 'border-amber-500/30',
    )}>
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

        <div className="space-y-2">
          {checkEntries.map(([key, check]) => {
            const meta = CHECK_LABELS[key];
            return (
              <div key={key} className="flex items-start gap-3 p-2 rounded-md bg-muted/50">
                <CheckIcon ok={check.ok} isLive={tier.isLive} verifyUnavailable={check.verifyUnavailable} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">{meta.label}</p>
                  <p className="text-xs text-muted-foreground">{check.detail}</p>
                </div>
              </div>
            );
          })}
        </div>

        <div className="pt-2 border-t border-border">
          <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
            <div>First payout cap: <span className="font-medium text-foreground">${tier.firstPayoutCap}</span></div>
            <div>Lifetime cap: <span className="font-medium text-foreground">{tier.lifetimeCapMultiple}× entry</span></div>
          </div>
        </div>

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

async function fetchTierReadiness(deep: boolean) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error('Not authenticated');

  const url = `${SUPABASE_FUNCTIONS_URL}/get-tier-readiness${deep ? '?deep=1' : ''}`;
  const response = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    const err = await response.json();
    throw new Error(err.error || 'Failed to fetch tier readiness');
  }

  return response.json() as Promise<{ tiers: TierData[]; deep: boolean; checkedAt: string }>;
}

export default function TierReadiness() {
  const [deepMode, setDeepMode] = useState(false);

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['tier-readiness', deepMode],
    queryFn: () => fetchTierReadiness(deepMode),
    staleTime: 30_000,
  });

  const tiers = data?.tiers ?? [];
  const isDeepResult = data?.deep ?? false;
  const checkedAt = data?.checkedAt;

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
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setDeepMode(true)}
              disabled={isFetching}
            >
              <ShieldCheck className="h-4 w-4 mr-1.5" />
              Verify Stripe
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => { setDeepMode(false); refetch(); }}
              disabled={isFetching}
            >
              <RefreshCw className={cn('h-4 w-4 mr-1.5', isFetching && 'animate-spin')} />
              Refresh
            </Button>
          </div>
        </div>

        {!isLoading && !error && checkedAt && (
          <div className="flex items-center gap-3 text-xs text-muted-foreground bg-muted/50 rounded-md px-3 py-2">
            <Badge variant={isDeepResult ? 'default' : 'secondary'} className="text-[10px] px-1.5 py-0">
              {isDeepResult ? 'Deep Stripe Verify (live API)' : 'Config Only'}
            </Badge>
            <span title={checkedAt}>
              Checked {new Date(checkedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
              {' · '}
              {new Date(checkedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              {' '}
              {Intl.DateTimeFormat().resolvedOptions().timeZone.replace(/_/g, ' ')}
            </span>
            {isDeepResult && (
              <span className="flex items-center gap-1">
                <ShieldCheck className="h-3.5 w-3.5" />
                Price/product IDs verified against live Stripe
              </span>
            )}
          </div>
        )}

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

        {!isLoading && !error && isDeepResult && tiers.some(t =>
          Object.values(t.checks).some(c => c.verifyUnavailable)
        ) && (
          <div className="flex items-center gap-2 text-sm bg-amber-500/10 border border-amber-500/30 rounded-md px-3 py-2">
            <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0" />
            <span className="text-amber-700">
              Stripe verification unavailable (rate limit / network). Flip is locked until verification succeeds.
            </span>
          </div>
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
