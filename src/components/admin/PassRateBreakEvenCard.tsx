import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Gauge } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { supabase, SUPABASE_FUNCTIONS_URL } from '@/integrations/supabase/client';

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
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) throw new Error('Not authenticated');

      const res = await fetch(`${SUPABASE_FUNCTIONS_URL}/get-pass-rate-stats`, {
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
        },
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }

      const json = await res.json();
      return json.tiers as TierPassRate[];
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
                    {/* Break-even marker — scaled to inversion as 100% */}
                    <div
                      className="absolute top-0 h-full w-px bg-warning z-10"
                      style={{ left: `${Math.min(100, (tier.breakEven / tier.inversion) * 100)}%` }}
                      title={`Break-even: ${tier.breakEven}%`}
                    />
                    {/* Inversion marker — right edge */}
                    <div
                      className="absolute top-0 h-full w-0.5 bg-destructive z-10"
                      style={{ left: '100%' }}
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
                        style={{ width: `${Math.min(100, (tier.passRate / tier.inversion) * 100)}%` }}
                      />
                    )}
                  </div>
                  {tier.total < 50 && tier.total > 0 && (
                    <div className="text-[10px] text-warning mt-0.5">⚠ Low sample size ({tier.total} accounts)</div>
                  )}
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
