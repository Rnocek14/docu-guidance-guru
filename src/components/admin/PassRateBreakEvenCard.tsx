import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Gauge } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { subDays, format } from 'date-fns';
import { TIERS } from '@/lib/pricing-data';

interface TierPassRate {
  tierName: string;
  passRate: number;
  breakEven: number;
  inversion: number;
  passed: number;
  total: number;
}

export function PassRateBreakEvenCard() {
  const { data: tierStats, isLoading } = useQuery({
    queryKey: ['admin-pass-rate-by-tier'],
    queryFn: async () => {
      const thirtyDaysAgo = format(subDays(new Date(), 30), 'yyyy-MM-dd');

      // Get cohorts with tier_id to map to pricing tiers
      const { data: cohorts, error: cohortErr } = await supabase
        .from('cohorts')
        .select('id, name, tier_id, cohort_phase')
        .eq('is_active', true);
      if (cohortErr) throw cohortErr;

      // Get accounts resolved in last 30 days
      const { data: accounts, error: accErr } = await supabase
        .from('accounts')
        .select('cohort_id, status, updated_at')
        .in('status', ['passed', 'failed_confirmed'])
        .gte('updated_at', thirtyDaysAgo);
      if (accErr) throw accErr;

      // Group by tier
      const tierMap = new Map<string, { passed: number; total: number }>();

      // Initialize from pricing tiers
      for (const tier of TIERS) {
        tierMap.set(tier.id, { passed: 0, total: 0 });
      }

      // Map cohorts to tiers
      const cohortToTier = new Map<string, string>();
      for (const c of cohorts ?? []) {
        if (c.tier_id) {
          cohortToTier.set(c.id, c.tier_id);
        } else {
          // Fallback: map evaluation cohorts to starter
          if (c.cohort_phase === 'evaluation') {
            cohortToTier.set(c.id, 'starter');
          }
        }
      }

      for (const acc of accounts ?? []) {
        const tierId = cohortToTier.get(acc.cohort_id);
        if (!tierId) continue;
        const entry = tierMap.get(tierId) ?? { passed: 0, total: 0 };
        entry.total++;
        if (acc.status === 'passed') entry.passed++;
        tierMap.set(tierId, entry);
      }

      const results: TierPassRate[] = TIERS.map((tier) => {
        const stats = tierMap.get(tier.id) ?? { passed: 0, total: 0 };
        const passRate = stats.total > 0 ? (stats.passed / stats.total) * 100 : 0;
        return {
          tierName: tier.name,
          passRate,
          breakEven: 17, // ~16-18% midpoint
          inversion: 22,
          passed: stats.passed,
          total: stats.total,
        };
      });

      return results;
    },
    refetchInterval: 60000,
  });

  const getStatus = (rate: number, breakEven: number, inversion: number) => {
    if (rate >= inversion) return { label: 'Critical', variant: 'destructive' as const };
    if (rate >= breakEven) return { label: 'Warning', variant: 'outline' as const };
    return { label: 'Safe', variant: 'default' as const };
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-lg">
          <Gauge className="h-5 w-5 text-primary" />
          Pass Rate vs Break-Even
        </CardTitle>
        <CardDescription>Rolling 30-day pass rate per tier against profitability thresholds</CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="h-24 flex items-center justify-center text-muted-foreground text-sm">Loading...</div>
        ) : (
          <div className="space-y-4">
            {tierStats?.map((tier) => {
              const status = getStatus(tier.passRate, tier.breakEven, tier.inversion);
              return (
                <div key={tier.tierName} className="space-y-1.5">
                  <div className="flex items-center justify-between text-sm">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{tier.tierName}</span>
                      <Badge variant={status.variant} className="text-xs">{status.label}</Badge>
                    </div>
                    <span className="font-mono text-sm">
                      {tier.total > 0 ? `${tier.passRate.toFixed(1)}%` : 'No data'}
                      <span className="text-muted-foreground ml-1 text-xs">
                        ({tier.passed}/{tier.total})
                      </span>
                    </span>
                  </div>
                  <div className="relative h-2 rounded-full bg-muted overflow-hidden">
                    {/* Break-even marker */}
                    <div
                      className="absolute top-0 h-full w-px bg-warning z-10"
                      style={{ left: `${Math.min(100, (tier.breakEven / 30) * 100)}%` }}
                      title={`Break-even: ${tier.breakEven}%`}
                    />
                    {/* Inversion marker */}
                    <div
                      className="absolute top-0 h-full w-px bg-destructive z-10"
                      style={{ left: `${Math.min(100, (tier.inversion / 30) * 100)}%` }}
                      title={`Inversion: ${tier.inversion}%`}
                    />
                    {/* Current rate bar */}
                    {tier.total > 0 && (
                      <div
                        className={`h-full rounded-full transition-all ${
                          tier.passRate >= tier.inversion
                            ? 'bg-destructive'
                            : tier.passRate >= tier.breakEven
                              ? 'bg-warning'
                              : 'bg-success'
                        }`}
                        style={{ width: `${Math.min(100, (tier.passRate / 30) * 100)}%` }}
                      />
                    )}
                  </div>
                </div>
              );
            })}
            <div className="flex items-center gap-4 text-[11px] text-muted-foreground pt-2 border-t border-border">
              <span className="flex items-center gap-1">
                <span className="inline-block w-2 h-2 rounded-full bg-warning" /> Break-even (~17%)
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block w-2 h-2 rounded-full bg-destructive" /> Inversion (~22%)
              </span>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
