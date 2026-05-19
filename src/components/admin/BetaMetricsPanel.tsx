import { useEffect, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Loader2, RefreshCw, Activity } from 'lucide-react';
import { supabase, SUPABASE_FUNCTIONS_URL } from '@/integrations/supabase/client';
import { toast } from 'sonner';

interface MetricPair { observed: number; assumed: number }
interface BetaMetricsResponse {
  ok: true;
  generated_at: string;
  confidence: 'insufficient' | 'low' | 'medium' | 'high';
  sampleSize: {
    totalAccounts: number;
    distinctSignupUsers: number;
    fundedAccounts: number;
    fundedClosed: number;
    totalPayoutRequests: number;
    totalPaidPayouts: number;
    totalResets: number;
  };
  metrics: {
    passRate: MetricPair;
    payoutRequestRatePerActiveMonth: MetricPair;
    resetsPerSignup: MetricPair;
    medianFundedLifespanDays: MetricPair;
    avgPaidPayoutAmount: number;
  };
}

function pct(n: number, d = 1) { return `${(n * 100).toFixed(d)}%`; }
function num(n: number, d = 2) { return n.toFixed(d); }

function delta(observed: number, assumed: number) {
  if (assumed === 0) return { label: '—', tone: 'muted' as const };
  const diff = (observed - assumed) / assumed;
  const tone: 'good' | 'bad' | 'muted' =
    Math.abs(diff) < 0.1 ? 'muted' : diff > 0 ? 'bad' : 'good';
  const sign = diff >= 0 ? '+' : '';
  return { label: `${sign}${(diff * 100).toFixed(0)}% vs assumed`, tone };
}

const CONFIDENCE_TONE: Record<BetaMetricsResponse['confidence'], string> = {
  insufficient: 'bg-muted text-muted-foreground',
  low: 'bg-destructive/20 text-foreground',
  medium: 'bg-primary/15 text-foreground',
  high: 'bg-primary/30 text-foreground',
};

export function BetaMetricsPanel() {
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<BetaMetricsResponse | null>(null);

  async function load() {
    setLoading(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch(`${SUPABASE_FUNCTIONS_URL}/beta-metrics`, {
        headers: { Authorization: `Bearer ${session?.access_token ?? ''}` },
      });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        toast.error(json.error ?? 'Failed to load beta metrics');
      } else {
        setData(json);
      }
    } catch (e) {
      console.error(e);
      toast.error('Failed to load beta metrics');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Activity className="h-5 w-5 text-primary" />
              Beta Calibration Metrics
            </CardTitle>
            <CardDescription>
              Real observed behavior vs. assumed model defaults. Re-calibrate the treasury model once confidence reaches medium/high.
            </CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {!data ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-3">
              <Badge className={CONFIDENCE_TONE[data.confidence]}>
                Confidence: {data.confidence}
              </Badge>
              <span className="text-xs text-muted-foreground">
                {data.sampleSize.fundedAccounts} funded · {data.sampleSize.distinctSignupUsers} signups ·
                {' '}{data.sampleSize.totalPaidPayouts} paid payouts · {data.sampleSize.totalResets} resets
              </span>
            </div>

            <Separator />

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              <MetricCard
                label="Pass rate"
                observed={pct(data.metrics.passRate.observed)}
                assumed={pct(data.metrics.passRate.assumed)}
                delta={delta(data.metrics.passRate.observed, data.metrics.passRate.assumed)}
                hint="Funded / total accounts"
              />
              <MetricCard
                label="Payout requests / funded-month"
                observed={num(data.metrics.payoutRequestRatePerActiveMonth.observed, 3)}
                assumed={num(data.metrics.payoutRequestRatePerActiveMonth.assumed, 3)}
                delta={delta(
                  data.metrics.payoutRequestRatePerActiveMonth.observed,
                  data.metrics.payoutRequestRatePerActiveMonth.assumed,
                )}
                hint="Extraction velocity"
              />
              <MetricCard
                label="Resets per signup"
                observed={num(data.metrics.resetsPerSignup.observed, 2)}
                assumed={num(data.metrics.resetsPerSignup.assumed, 2)}
                delta={delta(data.metrics.resetsPerSignup.observed, data.metrics.resetsPerSignup.assumed)}
                hint="Reset revenue driver"
              />
              <MetricCard
                label="Median funded lifespan"
                observed={`${num(data.metrics.medianFundedLifespanDays.observed, 0)}d`}
                assumed={`${num(data.metrics.medianFundedLifespanDays.assumed, 0)}d`}
                delta={delta(
                  data.metrics.medianFundedLifespanDays.observed,
                  data.metrics.medianFundedLifespanDays.assumed,
                )}
                hint={`${data.sampleSize.fundedClosed} closed / ${data.sampleSize.fundedAccounts} funded`}
              />
            </div>

            <p className="text-xs text-muted-foreground">
              Avg paid payout: ${num(data.metrics.avgPaidPayoutAmount, 0)} ·
              {' '}Updated {new Date(data.generated_at).toLocaleString()}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function MetricCard({
  label, observed, assumed, delta, hint,
}: {
  label: string;
  observed: string;
  assumed: string;
  delta: { label: string; tone: 'good' | 'bad' | 'muted' };
  hint: string;
}) {
  const toneClass =
    delta.tone === 'good' ? 'text-primary' :
    delta.tone === 'bad' ? 'text-destructive' :
    'text-muted-foreground';
  return (
    <div className="rounded-md border bg-card p-3">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="text-2xl font-bold mt-1">{observed}</p>
      <p className="text-xs text-muted-foreground mt-1">assumed: {assumed}</p>
      <p className={`text-xs mt-1 ${toneClass}`}>{delta.label}</p>
      <p className="text-[10px] text-muted-foreground/70 mt-2">{hint}</p>
    </div>
  );
}