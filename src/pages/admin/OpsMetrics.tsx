import { DashboardLayout, adminNavItems } from '@/components/layout/DashboardLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { supabase } from '@/integrations/supabase/client';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { format } from 'date-fns';
import {
  AlertTriangle,
  Shield,
  DollarSign,
  CreditCard,
  Activity,
  RefreshCw,
  Loader2,
  ExternalLink,
} from 'lucide-react';

// ── Traffic-light types ──
type Signal = 'green' | 'yellow' | 'red';

interface MetricCard {
  id: string;
  title: string;
  icon: React.ReactNode;
  signal: Signal;
  headline: string;
  details: string[];
  playbookLink: string;
  playbookLabel: string;
  updatedAt: string | null;
}

const signalStyles: Record<Signal, { dot: string; border: string; badge: 'default' | 'secondary' | 'destructive' }> = {
  green: { dot: 'bg-green-500', border: 'border-border', badge: 'secondary' },
  yellow: { dot: 'bg-yellow-500', border: 'border-yellow-500/40', badge: 'default' },
  red: { dot: 'bg-red-500', border: 'border-destructive/50', badge: 'destructive' },
};

// ── Data hooks ──

function useDisputeRate() {
  return useQuery({
    queryKey: ['ops-dispute-rate'],
    queryFn: async () => {
      const [r30, r7] = await Promise.all([
        supabase.rpc('get_dispute_rate_snapshot', { window_days: 30 }),
        supabase.rpc('get_dispute_rate_snapshot', { window_days: 7 }),
      ]);
      return {
        d30: r30.data as any,
        d7: r7.data as any,
        error: r30.error || r7.error,
      };
    },
    refetchInterval: 60_000,
  });
}

function useBreakerState() {
  return useQuery({
    queryKey: ['ops-breaker'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('econ_breaker_state')
        .select('*')
        .single();
      if (error) throw error;
      return data;
    },
    refetchInterval: 30_000,
  });
}

function useLatestSnapshot() {
  return useQuery({
    queryKey: ['ops-latest-snapshot'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('risk_snapshots')
        .select('net_buffer, pending_payouts_amount, pending_payouts_count, created_at')
        .order('created_at', { ascending: false })
        .limit(1)
        .single();
      if (error) throw error;
      return data;
    },
    refetchInterval: 60_000,
  });
}

function usePayoutPipeline() {
  return useQuery({
    queryKey: ['ops-payout-pipeline'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('payouts')
        .select('status, amount')
        .in('status', ['pending', 'under_review', 'approved', 'payment_initiated', 'payment_failed']);
      if (error) throw error;

      const buckets: Record<string, { count: number; total: number }> = {};
      for (const p of data || []) {
        if (!buckets[p.status]) buckets[p.status] = { count: 0, total: 0 };
        buckets[p.status].count++;
        buckets[p.status].total += Number(p.amount) || 0;
      }
      return buckets;
    },
    refetchInterval: 30_000,
  });
}

function useCronHealth() {
  return useQuery({
    queryKey: ['ops-cron-health'],
    queryFn: async () => {
      const { data: config } = await supabase
        .from('cron_health_config')
        .select('*')
        .eq('enabled', true);

      const { data: runs } = await supabase
        .from('cron_http_runs')
        .select('jobname, http_status, ran_at')
        .order('ran_at', { ascending: false })
        .limit(200);

      if (!config?.length) return { signal: 'green' as Signal, jobs: [] };

      const now = Date.now();
      const jobResults = config.map((cfg) => {
        const jobRuns = (runs || []).filter((r) => r.jobname === cfg.jobname);
        const recent = jobRuns.slice(0, cfg.min_expected_runs || 5);
        const successCount = recent.filter((r) => r.http_status && r.http_status >= 200 && r.http_status < 300).length;
        const successRate = recent.length > 0 ? (successCount / recent.length) * 100 : 0;
        const lastRun = jobRuns[0]?.ran_at;
        const stale = !lastRun;

        let signal: Signal = 'green';
        if (stale || successRate < cfg.red_if_success_rate_below) signal = 'red';
        else if (successRate < cfg.yellow_if_success_rate_below) signal = 'yellow';

        return { name: cfg.jobname, signal, successRate, lastRun };
      });

      const worst: Signal = jobResults.some((j) => j.signal === 'red')
        ? 'red'
        : jobResults.some((j) => j.signal === 'yellow')
          ? 'yellow'
          : 'green';

      return { signal: worst, jobs: jobResults };
    },
    refetchInterval: 60_000,
  });
}

// ── Component ──

export default function OpsMetrics() {
  const dispute = useDisputeRate();
  const breaker = useBreakerState();
  const snapshot = useLatestSnapshot();
  const pipeline = usePayoutPipeline();
  const cron = useCronHealth();

  const isLoading = dispute.isLoading || breaker.isLoading || snapshot.isLoading || pipeline.isLoading || cron.isLoading;
  const isRefetching = dispute.isRefetching || breaker.isRefetching || snapshot.isRefetching || pipeline.isRefetching || cron.isRefetching;

  const refetchAll = () => {
    dispute.refetch();
    breaker.refetch();
    snapshot.refetch();
    pipeline.refetch();
    cron.refetch();
  };

  // ── Build cards ──

  const cards: MetricCard[] = [];

  // 1. Dispute Rate
  const d30 = dispute.data?.d30;
  const d7 = dispute.data?.d7;
  const disputeLevel = d30?.alert_level ?? 'ok';
  const disputeSignal: Signal = disputeLevel === 'ok' ? 'green' : disputeLevel === 'warn' ? 'yellow' : 'red';
  cards.push({
    id: 'dispute',
    title: 'Dispute Rate',
    icon: <AlertTriangle className="h-5 w-5" />,
    signal: disputeSignal,
    headline: d30 ? `${Number(d30.dispute_rate_percent).toFixed(2)}% (30d)` : '—',
    details: [
      d7 ? `7-day: ${Number(d7.dispute_rate_percent).toFixed(2)}%` : '',
      d30 ? `${d30.disputes_count} disputes / ${d30.payments_count} payments` : '',
    ].filter(Boolean),
    playbookLink: '/admin/ops-playbook',
    playbookLabel: 'Dispute Rate Alert →',
    updatedAt: d30?.calculated_at ?? null,
  });

  // 2. Econ Breaker
  const bk = breaker.data;
  const breakerSignal: Signal = !bk ? 'yellow' : bk.breaker_level === 'normal' ? 'green' : bk.breaker_level === 'elevated' ? 'yellow' : 'red';
  cards.push({
    id: 'breaker',
    title: 'Econ Breaker',
    icon: <Shield className="h-5 w-5" />,
    signal: breakerSignal,
    headline: bk ? `${bk.breaker_level.toUpperCase()} · ${Number(bk.rolling_pass_rate).toFixed(1)}% pass rate` : '—',
    details: [
      bk ? `${bk.rolling_pass_count}/${bk.rolling_total_count} passed (30d)` : '',
      bk?.approvals_blocked ? '⛔ Approvals blocked' : '',
      bk?.payouts_blocked ? '⛔ Payouts blocked' : '',
    ].filter(Boolean),
    playbookLink: '/admin/ops-playbook',
    playbookLabel: 'Breaker Runbook →',
    updatedAt: bk?.last_evaluated_at ?? null,
  });

  // 3. Net Buffer
  const snap = snapshot.data;
  const netBuffer = snap ? Number(snap.net_buffer ?? 0) : null;
  const bufferSignal: Signal = netBuffer === null ? 'yellow' : netBuffer > 0 ? 'green' : 'red';
  cards.push({
    id: 'buffer',
    title: 'Net Buffer',
    icon: <DollarSign className="h-5 w-5" />,
    signal: bufferSignal,
    headline: netBuffer !== null ? `$${netBuffer.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}` : '—',
    details: [
      snap ? `Pending payouts: ${snap.pending_payouts_count ?? 0} ($${Number(snap.pending_payouts_amount ?? 0).toLocaleString()})` : '',
    ].filter(Boolean),
    playbookLink: '/admin/liability',
    playbookLabel: 'Liability Dashboard →',
    updatedAt: snap?.created_at ?? null,
  });

  // 4. Payout Pipeline
  const pp = pipeline.data ?? {};
  const stuckCount = (pp['payment_initiated']?.count ?? 0);
  const failedCount = (pp['payment_failed']?.count ?? 0);
  const totalInFlight = Object.values(pp).reduce((s, b) => s + b.count, 0);
  const totalAmount = Object.values(pp).reduce((s, b) => s + b.total, 0);
  const pipelineSignal: Signal = failedCount > 0 ? 'red' : stuckCount > 0 ? 'yellow' : 'green';
  cards.push({
    id: 'pipeline',
    title: 'Payout Pipeline',
    icon: <CreditCard className="h-5 w-5" />,
    signal: pipelineSignal,
    headline: `${totalInFlight} in flight · $${totalAmount.toLocaleString(undefined, { maximumFractionDigits: 0 })}`,
    details: [
      pp['pending'] ? `Pending: ${pp['pending'].count}` : '',
      pp['under_review'] ? `Under review: ${pp['under_review'].count}` : '',
      pp['approved'] ? `Approved: ${pp['approved'].count}` : '',
      pp['payment_initiated'] ? `Initiated: ${pp['payment_initiated'].count}` : '',
      failedCount > 0 ? `⚠ Failed: ${failedCount}` : '',
    ].filter(Boolean),
    playbookLink: '/admin/ops-playbook',
    playbookLabel: 'Stuck Payout Runbook →',
    updatedAt: null,
  });

  // 5. Cron Health
  const cronData = cron.data;
  const cronSignal: Signal = cronData?.signal ?? 'yellow';
  const redJobs = cronData?.jobs.filter((j) => j.signal === 'red') ?? [];
  const yellowJobs = cronData?.jobs.filter((j) => j.signal === 'yellow') ?? [];
  cards.push({
    id: 'cron',
    title: 'Cron Health',
    icon: <Activity className="h-5 w-5" />,
    signal: cronSignal,
    headline: cronSignal === 'green'
      ? `All ${cronData?.jobs.length ?? 0} jobs healthy`
      : `${redJobs.length} red, ${yellowJobs.length} yellow`,
    details: [
      ...redJobs.map((j) => `🔴 ${j.name} (${j.successRate.toFixed(0)}%)`),
      ...yellowJobs.map((j) => `🟡 ${j.name} (${j.successRate.toFixed(0)}%)`),
    ],
    playbookLink: '/admin/system',
    playbookLabel: 'System Overview →',
    updatedAt: null,
  });

  if (isLoading) {
    return (
      <DashboardLayout title="Morning Checks" navItems={adminNavItems}>
        <div className="flex items-center justify-center h-64">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </DashboardLayout>
    );
  }

  // Overall signal
  const overallSignal: Signal = cards.some((c) => c.signal === 'red')
    ? 'red'
    : cards.some((c) => c.signal === 'yellow')
      ? 'yellow'
      : 'green';

  const overallLabel = overallSignal === 'green' ? 'ALL CLEAR' : overallSignal === 'yellow' ? 'ATTENTION' : 'ACTION REQUIRED';

  return (
    <DashboardLayout title="Morning Checks" navItems={adminNavItems}>
      <div className="space-y-6 max-w-5xl">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-bold tracking-tight">Daily Ops Metrics</h2>
            <p className="text-muted-foreground">
              The 5 numbers you check every morning. Linked to the Ops Playbook.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Badge variant={signalStyles[overallSignal].badge} className="text-sm px-3 py-1 gap-1.5">
              <span className={`inline-block h-2 w-2 rounded-full ${signalStyles[overallSignal].dot}`} />
              {overallLabel}
            </Badge>
            <button
              onClick={refetchAll}
              disabled={isRefetching}
              className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              <RefreshCw className={`h-4 w-4 ${isRefetching ? 'animate-spin' : ''}`} />
              Refresh
            </button>
          </div>
        </div>

        {/* Cards grid */}
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {cards.map((card) => {
            const style = signalStyles[card.signal];
            return (
              <Card key={card.id} className={style.border}>
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between">
                    <CardTitle className="flex items-center gap-2 text-sm font-medium">
                      {card.icon}
                      {card.title}
                    </CardTitle>
                    <span className={`inline-block h-3 w-3 rounded-full ${style.dot}`} />
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  <p className="text-lg font-semibold tabular-nums">{card.headline}</p>

                  {card.details.length > 0 && (
                    <ul className="text-sm text-muted-foreground space-y-0.5">
                      {card.details.map((d, i) => (
                        <li key={i}>{d}</li>
                      ))}
                    </ul>
                  )}

                  <div className="flex items-center justify-between pt-2 border-t">
                    <Link
                      to={card.playbookLink}
                      className="text-xs text-primary hover:underline flex items-center gap-1"
                    >
                      <ExternalLink className="h-3 w-3" />
                      {card.playbookLabel}
                    </Link>
                    {card.updatedAt && (
                      <span className="text-xs text-muted-foreground">
                        {format(new Date(card.updatedAt), 'HH:mm')}
                      </span>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      </div>
    </DashboardLayout>
  );
}
