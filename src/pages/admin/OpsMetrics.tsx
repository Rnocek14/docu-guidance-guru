import { DashboardLayout, adminNavItems } from '@/components/layout/DashboardLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { supabase } from '@/integrations/supabase/client';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { format, differenceInHours, differenceInMinutes } from 'date-fns';
import {
  AlertTriangle,
  Shield,
  DollarSign,
  CreditCard,
  Activity,
  RefreshCw,
  Loader2,
  ExternalLink,
  Clock,
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
  staleWarning?: string;
}

const signalStyles: Record<Signal, { dot: string; border: string; badge: 'default' | 'secondary' | 'destructive' }> = {
  green: { dot: 'bg-green-500', border: 'border-border', badge: 'secondary' },
  yellow: { dot: 'bg-yellow-500', border: 'border-yellow-500/40', badge: 'default' },
  red: { dot: 'bg-red-500', border: 'border-destructive/50', badge: 'destructive' },
};

const ALERT_PRIORITY: Record<string, number> = { ok: 0, warn: 1, high: 2, severe: 3, emergency: 4 };

function worstAlertSignal(level: string): Signal {
  if (level === 'ok') return 'green';
  if (level === 'warn') return 'yellow';
  return 'red'; // high, severe, emergency
}

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
        .select('status, amount, updated_at')
        .in('status', ['pending', 'under_review', 'approved', 'payment_initiated', 'payment_failed']);
      if (error) throw error;

      const now = new Date();
      const buckets: Record<string, { count: number; total: number }> = {};
      let oldestInitiatedHours = 0;

      for (const p of data || []) {
        if (!buckets[p.status]) buckets[p.status] = { count: 0, total: 0 };
        buckets[p.status].count++;
        buckets[p.status].total += Number(p.amount) || 0;

        // Track how long the oldest payment_initiated has been stuck
        if (p.status === 'payment_initiated' && p.updated_at) {
          const hours = differenceInHours(now, new Date(p.updated_at));
          if (hours > oldestInitiatedHours) oldestInitiatedHours = hours;
        }
      }
      return { buckets, oldestInitiatedHours };
    },
    refetchInterval: 30_000,
  });
}

function useCronHealth() {
  return useQuery({
    queryKey: ['ops-cron-health'],
    queryFn: async () => {
      const [configRes, runsRes] = await Promise.all([
        supabase.from('cron_health_config').select('*').eq('enabled', true),
        supabase.from('cron_http_runs').select('jobname, http_status, ran_at').order('ran_at', { ascending: false }).limit(200),
      ]);

      const config = configRes.data;
      const runs = runsRes.data;

      if (!config?.length) return { signal: 'green' as Signal, jobs: [] };

      const now = new Date();
      const jobResults = config.map((cfg) => {
        const jobRuns = (runs || []).filter((r) => r.jobname === cfg.jobname);
        const recent = jobRuns.slice(0, cfg.min_expected_runs || 5);
        const successCount = recent.filter((r) => r.http_status && r.http_status >= 200 && r.http_status < 300).length;
        const successRate = recent.length > 0 ? (successCount / recent.length) * 100 : 0;
        const lastRun = jobRuns[0]?.ran_at;

        // Staleness: if last run is older than 2x expected interval, it's stale
        const lastRunDate = lastRun ? new Date(lastRun) : null;
        const minutesSinceLastRun = lastRunDate ? differenceInMinutes(now, lastRunDate) : Infinity;
        // expected_interval is an interval type — we can't easily parse it client-side,
        // so use a heuristic: if no run in 24h, mark stale
        const isStale = minutesSinceLastRun > 24 * 60;

        let signal: Signal = 'green';
        if (isStale || !lastRun || successRate < cfg.red_if_success_rate_below) signal = 'red';
        else if (successRate < cfg.yellow_if_success_rate_below) signal = 'yellow';

        return { name: cfg.jobname, signal, successRate, lastRun, isStale };
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

  // 1. Dispute Rate — use worst-of(7d, 30d) to match ops behavior
  const d30 = dispute.data?.d30;
  const d7 = dispute.data?.d7;
  const d30Level = d30?.alert_level ?? 'ok';
  const d7Level = d7?.alert_level ?? 'ok';
  const effectiveLevel = (ALERT_PRIORITY[d7Level] ?? 0) > (ALERT_PRIORITY[d30Level] ?? 0) ? d7Level : d30Level;
  const disputeSignal = worstAlertSignal(effectiveLevel);
  cards.push({
    id: 'dispute',
    title: 'Dispute Rate',
    icon: <AlertTriangle className="h-5 w-5" />,
    signal: disputeSignal,
    headline: d30 ? `${Number(d30.dispute_rate_percent).toFixed(2)}% (30d)` : '—',
    details: [
      d7 ? `7-day: ${Number(d7.dispute_rate_percent).toFixed(2)}% [${d7Level.toUpperCase()}]` : '',
      d30 ? `${d30.disputes_count} disputes / ${d30.payments_count} payments` : '',
      effectiveLevel !== 'ok' ? `⚠ Effective alert: ${effectiveLevel.toUpperCase()}` : '',
    ].filter(Boolean),
    playbookLink: '/admin/ops-playbook#dispute-rate',
    playbookLabel: 'Dispute Rate Alert →',
    updatedAt: d30?.calculated_at ?? null,
  });

  // 2. Econ Breaker
  const bk = breaker.data;
  const breakerLevel = bk?.breaker_level ?? '';
  const breakerSignal: Signal = !bk ? 'yellow'
    : breakerLevel === 'normal' ? 'green'
    : breakerLevel === 'elevated' ? 'yellow'
    : 'red'; // critical, emergency
  cards.push({
    id: 'breaker',
    title: 'Econ Breaker',
    icon: <Shield className="h-5 w-5" />,
    signal: breakerSignal,
    headline: bk ? `${breakerLevel.toUpperCase()} · ${Number(bk.rolling_pass_rate).toFixed(1)}% pass rate` : '—',
    details: [
      bk ? `${bk.rolling_pass_count}/${bk.rolling_total_count} passed (30d)` : '',
      bk?.approvals_blocked ? '⛔ Approvals blocked' : '',
      bk?.payouts_blocked ? '⛔ Payouts blocked' : '',
      bk?.evaluations_frozen ? '⛔ Evaluations frozen' : '',
    ].filter(Boolean),
    playbookLink: '/admin/ops-playbook#breaker-fired',
    playbookLabel: 'Breaker Runbook →',
    updatedAt: bk?.last_evaluated_at ?? null,
  });

  // 3. Net Buffer — with staleness warning
  const snap = snapshot.data;
  const netBuffer = snap ? Number(snap.net_buffer ?? 0) : null;
  const snapAge = snap?.created_at ? differenceInHours(new Date(), new Date(snap.created_at)) : null;
  const snapStale = snapAge !== null && snapAge > 26;
  const bufferSignal: Signal = snapStale ? 'red' : netBuffer === null ? 'yellow' : netBuffer > 0 ? 'green' : 'red';
  cards.push({
    id: 'buffer',
    title: 'Net Buffer',
    icon: <DollarSign className="h-5 w-5" />,
    signal: bufferSignal,
    headline: netBuffer !== null ? `$${netBuffer.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}` : '—',
    details: [
      snap ? `Pending payouts: ${snap.pending_payouts_count ?? 0} ($${Number(snap.pending_payouts_amount ?? 0).toLocaleString()})` : '',
    ].filter(Boolean),
    playbookLink: '/admin/ops-playbook#liability-negative',
    playbookLabel: 'Liability Runbook →',
    updatedAt: snap?.created_at ?? null,
    staleWarning: snapStale ? `⚠ Snapshot is ${snapAge}h old — daily-risk-snapshot may not be running` : undefined,
  });

  // 4. Payout Pipeline — improved stuck/failed logic
  const pp = pipeline.data?.buckets ?? {};
  const oldestInitiatedHours = pipeline.data?.oldestInitiatedHours ?? 0;
  const failedCount = (pp['payment_failed']?.count ?? 0);
  const totalInFlight = Object.values(pp).reduce((s, b) => s + b.count, 0);
  const totalAmount = Object.values(pp).reduce((s, b) => s + b.total, 0);

  let pipelineSignal: Signal = 'green';
  if (failedCount > 0 || oldestInitiatedHours >= 48) pipelineSignal = 'red';
  else if (oldestInitiatedHours >= 12) pipelineSignal = 'yellow';

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
      pp['payment_initiated'] ? `Initiated: ${pp['payment_initiated'].count}${oldestInitiatedHours > 0 ? ` (oldest: ${oldestInitiatedHours}h)` : ''}` : '',
      failedCount > 0 ? `🔴 Failed: ${failedCount}` : '',
      oldestInitiatedHours >= 48 ? `🔴 Stuck payout: ${oldestInitiatedHours}h in payment_initiated` : '',
      oldestInitiatedHours >= 12 && oldestInitiatedHours < 48 ? `🟡 Initiated ${oldestInitiatedHours}h ago — monitor` : '',
    ].filter(Boolean),
    playbookLink: '/admin/ops-playbook#stuck-payout',
    playbookLabel: 'Stuck Payout Runbook →',
    updatedAt: null,
  });

  // 5. Cron Health — with stale detection
  const cronData = cron.data;
  const cronSignal: Signal = cronData?.signal ?? 'yellow';
  const redJobs = cronData?.jobs.filter((j) => j.signal === 'red') ?? [];
  const yellowJobs = cronData?.jobs.filter((j) => j.signal === 'yellow') ?? [];
  const staleJobs = cronData?.jobs.filter((j) => j.isStale) ?? [];
  cards.push({
    id: 'cron',
    title: 'Cron Health',
    icon: <Activity className="h-5 w-5" />,
    signal: cronSignal,
    headline: cronSignal === 'green'
      ? `All ${cronData?.jobs.length ?? 0} jobs healthy`
      : `${redJobs.length} red, ${yellowJobs.length} yellow`,
    details: [
      ...redJobs.map((j) => `🔴 ${j.name} (${j.successRate.toFixed(0)}%)${j.isStale ? ' — STALE' : ''}`),
      ...yellowJobs.map((j) => `🟡 ${j.name} (${j.successRate.toFixed(0)}%)`),
      ...staleJobs.filter((j) => j.signal !== 'red').map((j) => `⏰ ${j.name} — no recent runs`),
    ],
    playbookLink: '/admin/ops-playbook#cron-failure',
    playbookLabel: 'Cron Failure Runbook →',
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

                  {card.staleWarning && (
                    <div className="flex items-center gap-1.5 text-xs text-destructive bg-destructive/10 rounded px-2 py-1">
                      <Clock className="h-3 w-3 shrink-0" />
                      {card.staleWarning}
                    </div>
                  )}

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
