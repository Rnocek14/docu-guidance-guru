import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { missionControlNavItems } from '@/components/layout/AdminNav';
import { getSafeToSell, type SafeToSellInputs, type ReserveGateInfo } from '@/lib/safe-to-sell';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { supabase } from '@/integrations/supabase/client';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { format, differenceInHours, differenceInMinutes } from 'date-fns';
import {
  AlertTriangle,
  Shield,
  ShieldCheck,
  ShieldAlert,
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

/** Parse Postgres interval string to minutes. Handles "HH:MM:SS", "N day(s)", "N day(s) HH:MM:SS" */
function parseIntervalToMinutes(interval: string): number {
  if (!interval) return 60; // conservative fallback
  let totalMinutes = 0;
  // Match days (handles "day" and "days")
  const dayMatch = interval.match(/(\d+)\s*days?/i);
  if (dayMatch) totalMinutes += parseInt(dayMatch[1], 10) * 24 * 60;
  // Match HH:MM:SS
  const timeMatch = interval.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (timeMatch) {
    totalMinutes += parseInt(timeMatch[1], 10) * 60 + parseInt(timeMatch[2], 10);
  }
  return totalMinutes || 60; // conservative fallback if unparseable
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
      // Fetch payouts + payout_payments for accurate stuck detection
      const [payoutsRes, paymentsRes] = await Promise.all([
        supabase
          .from('payouts')
          .select('id, status, amount, updated_at')
          .in('status', ['pending', 'under_review', 'approved', 'payment_initiated', 'payment_failed']),
        supabase
          .from('payout_payments')
          .select('payout_id, status, initiated_at')
          .eq('status', 'initiated'),
      ]);
      if (payoutsRes.error) throw payoutsRes.error;

      const now = new Date();
      const buckets: Record<string, { count: number; total: number }> = {};
      let oldestInitiatedHours = 0;

      // Index payout_payments by payout_id for O(1) lookup
      const paymentsByPayoutId = new Map<string, string>();
      for (const pp of paymentsRes.data || []) {
        paymentsByPayoutId.set(pp.payout_id, pp.initiated_at);
      }

      for (const p of payoutsRes.data || []) {
        if (!buckets[p.status]) buckets[p.status] = { count: 0, total: 0 };
        buckets[p.status].count++;
        buckets[p.status].total += Number(p.amount) || 0;

        // Use payout_payments.initiated_at for accurate stuck detection,
        // fall back to payouts.updated_at if no payment record
        if (p.status === 'payment_initiated') {
          const initiatedAt = paymentsByPayoutId.get(p.id) ?? p.updated_at;
          if (initiatedAt) {
            const hours = differenceInHours(now, new Date(initiatedAt));
            if (hours > oldestInitiatedHours) oldestInitiatedHours = hours;
          }
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

        // Parse expected_interval (Postgres interval string e.g. "01:00:00", "1 day", "00:05:00")
        const expectedMinutes = parseIntervalToMinutes(cfg.expected_interval as string);
        const lastRunDate = lastRun ? new Date(lastRun) : null;
        const minutesSinceLastRun = lastRunDate ? differenceInMinutes(now, lastRunDate) : Infinity;
        // Stale if no run in 2x the expected interval
        const isStale = minutesSinceLastRun > expectedMinutes * 2;

        let signal: Signal = 'green';
        if (isStale || !lastRun || successRate < cfg.red_if_success_rate_below) signal = 'red';
        else if (successRate < cfg.yellow_if_success_rate_below) signal = 'yellow';

        return { name: cfg.jobname, signal, successRate, lastRun, isStale, expectedMinutes };
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

function useDataFreshness() {
  const MONITOR_JOBS = ['daily-risk-snapshot', 'check-dispute-rate', 'cron-health-monitor'];
  return useQuery({
    queryKey: ['ops-data-freshness'],
    queryFn: async () => {
      const [runsRes, configRes] = await Promise.all([
        supabase
          .from('cron_http_runs')
          .select('jobname, ran_at, http_status')
          .in('jobname', MONITOR_JOBS)
          .order('ran_at', { ascending: false })
          .limit(50),
        supabase
          .from('cron_health_config')
          .select('jobname, expected_interval')
          .in('jobname', MONITOR_JOBS),
      ]);

      // Build expected-interval lookup
      const intervalMap = new Map<string, number>();
      for (const cfg of configRes.data || []) {
        intervalMap.set(cfg.jobname, parseIntervalToMinutes(cfg.expected_interval as string));
      }

      const now = new Date();
      const results: Record<string, { lastRun: string | null; signal: Signal; expectedMinutes: number; configMissing: boolean }> = {};
      for (const job of MONITOR_JOBS) {
        const latest = (runsRes.data || []).find((r) => r.jobname === job);
        const configMissing = !intervalMap.has(job);
        const expectedMinutes = intervalMap.get(job) ?? 60;
        const ageMinutes = latest?.ran_at ? differenceInMinutes(now, new Date(latest.ran_at)) : Infinity;
        const statusOk = latest ? (latest.http_status ?? 0) >= 200 && (latest.http_status ?? 0) < 300 : false;

        let signal: Signal = 'red';
        if (statusOk && ageMinutes <= expectedMinutes * 2) signal = 'green';
        else if (statusOk && ageMinutes <= expectedMinutes * 4) signal = 'yellow';

        // Missing config is itself a hygiene issue — don't let it stay green
        if (configMissing && signal === 'green') signal = 'yellow';

        results[job] = { lastRun: latest?.ran_at ?? null, signal, expectedMinutes, configMissing };
      }
      return results;
    },
    refetchInterval: 60_000,
  });
}

function usePaymentSystemState() {
  return useQuery({
    queryKey: ['ops-payment-state'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('payment_system_state')
        .select('is_paused_inbound, is_paused_outbound, pause_reason')
        .limit(1)
        .single();
      if (error) throw error;
      return data;
    },
    refetchInterval: 30_000,
  });
}

function useReserveGate() {
  return useQuery({
    queryKey: ['ops-reserve-gate'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('system_settings')
        .select('value')
        .eq('key', 'reserve_aware_approval')
        .single();
      if (error) return { enabled: false, hasSimRunId: false } as ReserveGateInfo;
      const val = data?.value as any;
      return {
        enabled: val?.enabled === true,
        hasSimRunId: !!val?.last_simulation_run_id,
      } as ReserveGateInfo;
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
  const freshness = useDataFreshness();
  const paymentState = usePaymentSystemState();
  const reserveGate = useReserveGate();

  const isLoading =
    dispute.isLoading ||
    breaker.isLoading ||
    snapshot.isLoading ||
    pipeline.isLoading ||
    cron.isLoading ||
    freshness.isLoading ||
    paymentState.isLoading ||
    reserveGate.isLoading;

  const isRefetching =
    dispute.isRefetching ||
    breaker.isRefetching ||
    snapshot.isRefetching ||
    pipeline.isRefetching ||
    cron.isRefetching ||
    freshness.isRefetching ||
    paymentState.isRefetching ||
    reserveGate.isRefetching;

  const refetchAll = () => {
    dispute.refetch();
    breaker.refetch();
    snapshot.refetch();
    pipeline.refetch();
    cron.refetch();
    freshness.refetch();
    paymentState.refetch();
    reserveGate.refetch();
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
  const breakerLevelCard = bk?.breaker_level ?? '';
  const breakerSignal: Signal = !bk ? 'yellow'
    : breakerLevelCard === 'normal' ? 'green'
    : breakerLevelCard === 'elevated' ? 'yellow'
    : 'red'; // critical, emergency
  cards.push({
    id: 'breaker',
    title: 'Econ Breaker',
    icon: <Shield className="h-5 w-5" />,
    signal: breakerSignal,
    headline: bk ? `${breakerLevelCard.toUpperCase()} · ${Number(bk.rolling_pass_rate).toFixed(1)}% pass rate` : '—',
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
      <DashboardLayout title="Morning Checks" navItems={missionControlNavItems}>
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

  // ── "Safe to Sell?" executive signal ──
  const { safe: safeToSell, reasons: safeReasons } = getSafeToSell({
    paymentState: paymentState.data ?? undefined,
    freshness: (freshness.data as SafeToSellInputs['freshness']) ?? undefined,
    breakerLevel: breaker.data?.breaker_level,
    snapshotNetBuffer: snapshot.data?.net_buffer ?? null,
    hasDisputeData: !!dispute.data?.d30,
    hasRedCard: cards.some((c) => c.signal === 'red'),
    reserveGate: reserveGate.data ?? undefined,
  });

  return (
    <DashboardLayout title="Morning Checks" navItems={missionControlNavItems}>
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

        {/* Safe to Sell? banner */}
        <div className={`flex items-center gap-3 rounded-lg px-4 py-3 border ${
          safeToSell
            ? 'bg-green-500/10 border-green-500/30'
            : 'bg-destructive/10 border-destructive/30'
        }`}>
          {safeToSell ? (
            <ShieldCheck className="h-5 w-5 text-green-600 shrink-0" />
          ) : (
            <ShieldAlert className="h-5 w-5 text-destructive shrink-0" />
          )}
          <div className="flex-1 min-w-0">
            <p className={`text-sm font-semibold ${safeToSell ? 'text-green-700 dark:text-green-400' : 'text-destructive'}`}>
              {safeToSell ? 'SAFE TO SELL — all systems nominal' : 'NOT SAFE TO SELL'}
            </p>
            {safeReasons.length > 0 && (
              <p className="text-xs text-muted-foreground mt-0.5">
                {safeReasons.join(' · ')}
              </p>
            )}
          </div>
        </div>

        {/* Data freshness bar */}
        {freshness.data && (
          <div className="flex flex-wrap gap-4 text-xs text-muted-foreground bg-muted/50 rounded-lg px-4 py-2.5 items-center">
            <span className="font-medium text-foreground">Monitor health:</span>
            {Object.entries(freshness.data).map(([job, info]) => {
              const age = info.lastRun ? differenceInMinutes(new Date(), new Date(info.lastRun)) : null;
              const ageLabel = age !== null
                ? age < 60 ? `${age}m ago` : `${Math.round(age / 60)}h ago`
                : 'never';
              const dotColor = info.signal === 'green' ? 'bg-green-500' : info.signal === 'yellow' ? 'bg-yellow-500' : 'bg-red-500';
              const suffix = info.configMissing ? ' (config missing)' : '';
              return (
                <span key={job} className="flex items-center gap-1.5">
                  <span className={`inline-block h-2 w-2 rounded-full ${dotColor}`} />
                  {job}: {ageLabel}{suffix}
                </span>
              );
            })}
          </div>
        )}

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
