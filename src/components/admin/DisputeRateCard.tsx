import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { supabase } from '@/integrations/supabase/client';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ShieldAlert, TrendingDown, TrendingUp, Minus } from 'lucide-react';

interface DisputeSnapshot {
  window_days: number;
  payments_count: number;
  payments_amount: number;
  disputes_count: number;
  disputes_amount: number;
  disputes_won: number;
  disputes_lost: number;
  disputes_pending: number;
  dispute_rate_percent: number;
  alert_level: 'ok' | 'warn' | 'high' | 'severe' | 'emergency';
  calculated_at: string;
}

const ALERT_CONFIG: Record<string, { color: string; label: string; badgeVariant: 'default' | 'secondary' | 'destructive' | 'outline' }> = {
  ok: { color: 'text-green-600', label: 'OK', badgeVariant: 'secondary' },
  warn: { color: 'text-yellow-600', label: 'WARN', badgeVariant: 'outline' },
  high: { color: 'text-orange-600', label: 'HIGH', badgeVariant: 'destructive' },
  severe: { color: 'text-red-600', label: 'SEVERE', badgeVariant: 'destructive' },
  emergency: { color: 'text-red-700', label: 'EMERGENCY', badgeVariant: 'destructive' },
};

export function DisputeRateCard() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['dispute-rate-snapshots'],
    queryFn: async () => {
      const [res30, res7] = await Promise.all([
        supabase.rpc('get_dispute_rate_snapshot', { window_days: 30 }),
        supabase.rpc('get_dispute_rate_snapshot', { window_days: 7 }),
      ]);

      if (res30.error) throw new Error(res30.error.message);
      if (res7.error) throw new Error(res7.error.message);

      return {
        d30: res30.data as unknown as DisputeSnapshot,
        d7: res7.data as unknown as DisputeSnapshot,
      };
    },
    refetchInterval: 60_000, // Refresh every minute
  });

  const d30 = data?.d30;
  const d7 = data?.d7;

  // Determine effective alert level (worst of the two windows)
  const alertPriority: Record<string, number> = { ok: 0, warn: 1, high: 2, severe: 3, emergency: 4 };
  const effectiveLevel = d30 && d7
    ? (alertPriority[d7.alert_level] > alertPriority[d30.alert_level] ? d7.alert_level : d30.alert_level)
    : d30?.alert_level ?? 'ok';

  const config = ALERT_CONFIG[effectiveLevel] ?? ALERT_CONFIG.ok;

  // Trend: compare 7-day vs 30-day rate
  const trend = d30 && d7
    ? d7.dispute_rate_percent > d30.dispute_rate_percent
      ? 'rising'
      : d7.dispute_rate_percent < d30.dispute_rate_percent
        ? 'falling'
        : 'flat'
    : 'flat';

  const TrendIcon = trend === 'rising' ? TrendingUp : trend === 'falling' ? TrendingDown : Minus;

  const borderClass = effectiveLevel === 'ok'
    ? 'border-border'
    : effectiveLevel === 'warn'
      ? 'border-yellow-500/50'
      : 'border-destructive/50';

  return (
    <Card className={borderClass}>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            {effectiveLevel !== 'ok' ? (
              <ShieldAlert className={`h-4 w-4 ${config.color}`} />
            ) : (
              <AlertTriangle className="h-4 w-4 text-muted-foreground" />
            )}
            Dispute Rate Monitor
          </CardTitle>
          <Badge variant={config.badgeVariant}>
            {config.label}
          </Badge>
        </div>
        <CardDescription>
          Rolling chargeback ratio vs. processor thresholds
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="text-sm text-muted-foreground">Loading…</div>
        ) : error ? (
          <div className="text-sm text-destructive">Failed to load dispute data</div>
        ) : d30 ? (
          <div className="space-y-4">
            {/* Primary metric: 30-day rate */}
            <div className="flex items-baseline justify-between">
              <div>
                <span className={`text-3xl font-bold tabular-nums ${config.color}`}>
                  {d30.dispute_rate_percent.toFixed(2)}%
                </span>
                <span className="text-sm text-muted-foreground ml-1">30-day</span>
              </div>
              <div className="flex items-center gap-1 text-sm text-muted-foreground">
                <TrendIcon className={`h-4 w-4 ${trend === 'rising' ? 'text-destructive' : trend === 'falling' ? 'text-green-600' : ''}`} />
                {d7 && (
                  <span className={`tabular-nums ${trend === 'rising' ? 'text-destructive' : trend === 'falling' ? 'text-green-600' : ''}`}>
                    {d7.dispute_rate_percent.toFixed(2)}% 7d
                  </span>
                )}
              </div>
            </div>

            {/* Counts */}
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <p className="text-muted-foreground">Payments (30d)</p>
                <p className="font-medium tabular-nums">{d30.payments_count.toLocaleString()}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Disputes (30d)</p>
                <p className="font-medium tabular-nums">{d30.disputes_count}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Pending</p>
                <p className="font-medium tabular-nums">{d30.disputes_pending}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Won / Lost</p>
                <p className="font-medium tabular-nums">
                  {d30.disputes_won} / {d30.disputes_lost}
                </p>
              </div>
            </div>

            {/* Threshold ladder */}
            <div className="pt-2 border-t">
              <p className="text-xs text-muted-foreground mb-2">Processor thresholds</p>
              <div className="flex gap-1">
                {[
                  { pct: 0.20, label: '0.20%', level: 'warn' },
                  { pct: 0.30, label: '0.30%', level: 'high' },
                  { pct: 0.40, label: '0.40%', level: 'severe' },
                  { pct: 0.50, label: '0.50%', level: 'emergency' },
                ].map((t) => {
                  const isBreached = d30.dispute_rate_percent >= t.pct;
                  return (
                    <div
                      key={t.level}
                      className={`flex-1 text-center rounded px-1 py-0.5 text-xs font-mono ${
                        isBreached
                          ? 'bg-destructive/20 text-destructive font-semibold'
                          : 'bg-muted text-muted-foreground'
                      }`}
                    >
                      {t.label}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        ) : (
          <div className="text-sm text-muted-foreground">No data available</div>
        )}
      </CardContent>
    </Card>
  );
}
