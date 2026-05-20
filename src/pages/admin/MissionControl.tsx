import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase, SUPABASE_FUNCTIONS_URL } from '@/integrations/supabase/client';
import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Link } from 'react-router-dom';
import {
  ShieldCheck, ShieldX, AlertTriangle, CheckCircle2, XCircle,
  RefreshCw, Loader2, Activity, Cpu, TrendingUp, Zap, Lock,
  Unlock, Clock, Power, PowerOff, DollarSign, CreditCard,
  Shield, ChevronRight, ExternalLink, Gauge, Save, Settings,
} from 'lucide-react';
import { formatDistanceToNow, differenceInHours, differenceInMinutes } from 'date-fns';
import { toast } from 'sonner';
import { missionControlNavItems } from '@/components/layout/AdminNav';
import type { DomainCheck, DomainResult, LockState, GovernorConfig, GovernorResult } from '@/lib/governor/types';
import { GovernorResultSchema } from '@/lib/governor/types';
import { Input } from '@/components/ui/input';

type Signal = 'green' | 'yellow' | 'red';

const DOMAIN_META: Record<string, { label: string; color: string }> = {
  capital: { label: 'Capital', color: 'text-chart-1' },
  processor: { label: 'Processor', color: 'text-chart-2' },
  cohort: { label: 'Cohort', color: 'text-chart-3' },
  riskEngine: { label: 'Risk Engine', color: 'text-chart-4' },
};

// ── Governor hook ──

function useGovernor() {
  const queryClient = useQueryClient();

  const fetchGovernor = async (): Promise<GovernorResult> => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) throw new Error('Not authenticated');
    const res = await fetch(`${SUPABASE_FUNCTIONS_URL}/system-governor`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${res.status}`);
    }
    const raw = await res.json();
    const parsed = GovernorResultSchema.safeParse(raw);
    if (!parsed.success) {
      console.error('Governor contract violation:', parsed.error.flatten());
      throw new Error('Governor response invalid — verify edge deployment.');
    }
    return parsed.data;
  };

  const query = useQuery({ queryKey: ['system-governor'], queryFn: fetchGovernor, refetchInterval: 60_000 });

  const runNow = useMutation({
    mutationFn: fetchGovernor,
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['system-governor'] });
      queryClient.invalidateQueries({ queryKey: ['mc-action-items'] });
      queryClient.invalidateQueries({ queryKey: ['mc-money-snapshot'] });
      toast.success(`Governor: ${result.verdict.toUpperCase()} — ${result.autoActionDetail}`);
    },
    onError: (err) => toast.error(`Governor error: ${(err as Error).message}`),
  });

  return { ...query, runNow };
}

// ── Action items hook (pending payouts, failed payments, stale crons, open flags) ──

interface ActionItem {
  id: string;
  type: 'payout' | 'dispute' | 'cron' | 'flag' | 'reconciliation';
  severity: Signal;
  title: string;
  detail: string;
  link: string;
}

function parseIntervalToMinutes(interval: string): number {
  if (!interval) return 60;
  let totalMinutes = 0;
  const dayMatch = interval.match(/(\d+)\s*days?/i);
  if (dayMatch) totalMinutes += parseInt(dayMatch[1], 10) * 24 * 60;
  const timeMatch = interval.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (timeMatch) totalMinutes += parseInt(timeMatch[1], 10) * 60 + parseInt(timeMatch[2], 10);
  return totalMinutes || 60;
}

function useActionItems() {
  return useQuery({
    queryKey: ['mc-action-items'],
    queryFn: async () => {
      const items: ActionItem[] = [];

      // Parallel fetch all action sources
      const [payoutsRes, flagsRes, cronConfigRes, cronRunsRes, failedPaymentsRes] = await Promise.all([
        supabase.from('payouts').select('id, status, amount, updated_at, account_id')
          .in('status', ['pending', 'under_review', 'approved']),
        supabase.from('flags').select('id, flag_type, reason, severity, account_id, created_at')
          .eq('status', 'pending').order('created_at', { ascending: false }).limit(10),
        supabase.from('cron_health_config').select('*').eq('enabled', true),
        supabase.from('cron_http_runs').select('jobname, http_status, ran_at')
          .order('ran_at', { ascending: false }).limit(1000),
        supabase.from('payout_payments').select('id, payout_id, status, initiated_at')
          .eq('status', 'failed').limit(10),
      ]);

      // Pending payouts needing action
      const pendingPayouts = (payoutsRes.data || []).filter(p => p.status === 'pending');
      if (pendingPayouts.length > 0) {
        const total = pendingPayouts.reduce((s, p) => s + Number(p.amount || 0), 0);
        items.push({
          id: 'pending-payouts',
          type: 'payout',
          severity: pendingPayouts.length >= 5 ? 'red' : 'yellow',
          title: `${pendingPayouts.length} payout${pendingPayouts.length > 1 ? 's' : ''} pending review`,
          detail: `$${total.toLocaleString(undefined, { maximumFractionDigits: 0 })} total`,
          link: '/risk/queue?status=pending',
        });
      }

      // Failed payments — read from payout_payments (the actual state-of-record).
      // The payouts.status enum has 'payment_failed', but the production state
      // machine reverts to 'approved' on failure and writes the failure on the
      // payout_payments row instead.
      const failedPayments = failedPaymentsRes.data || [];
      if (failedPayments.length > 0) {
        items.push({
          id: 'failed-payments',
          type: 'payout',
          severity: 'red',
          title: `${failedPayments.length} payout payment${failedPayments.length > 1 ? 's' : ''} failed`,
          detail: 'Requires manual investigation',
          link: '/risk/queue?tab=failed-payments',
        });
      }

      // Open flags
      const flags = flagsRes.data || [];
      if (flags.length > 0) {
        const highSev = flags.filter(f => f.severity === 'high' || f.severity === 'critical');
        items.push({
          id: 'open-flags',
          type: 'flag',
          severity: highSev.length > 0 ? 'red' : 'yellow',
          title: `${flags.length} open flag${flags.length > 1 ? 's' : ''} pending review`,
          detail: highSev.length > 0 ? `${highSev.length} high/critical severity` : 'Medium or lower severity',
          link: '/risk/queue?tab=flags',
        });
      }

      // Cron failures
      const now = new Date();
      const cronConfig = cronConfigRes.data || [];
      const cronRuns = cronRunsRes.data || [];
      for (const cfg of cronConfig) {
        const jobRuns = cronRuns.filter(r => r.jobname === cfg.jobname);
        const lastRun = jobRuns[0];
        const expectedMin = parseIntervalToMinutes(cfg.expected_interval as string);
        const ageMins = lastRun?.ran_at ? differenceInMinutes(now, new Date(lastRun.ran_at)) : Infinity;
        const isStale = ageMins > expectedMin * 4;
        const lastFailed = lastRun && (lastRun.http_status === null || lastRun.http_status >= 400);

        if (isStale || lastFailed) {
          items.push({
            id: `cron-${cfg.jobname}`,
            type: 'cron',
            severity: isStale ? 'red' : 'yellow',
            title: `Cron job "${cfg.jobname}" ${isStale ? 'stale' : 'failing'}`,
            detail: lastRun?.ran_at
              ? `Last run: ${formatDistanceToNow(new Date(lastRun.ran_at), { addSuffix: true })}`
              : 'Never run',
            link: `/admin/ops-metrics?job=${cfg.jobname}`,
          });
        }
      }

      // Sort: red first, then yellow, then green
      const order: Record<Signal, number> = { red: 0, yellow: 1, green: 2 };
      items.sort((a, b) => order[a.severity] - order[b.severity]);
      return items;
    },
    refetchInterval: 60_000,
  });
}

// ── Money snapshot hook ──

function useMoneySnapshot() {
  return useQuery({
    queryKey: ['mc-money-snapshot'],
    queryFn: async () => {
      const [snapRes, disputeRes, breakerRes, payoutsInFlightRes] = await Promise.all([
        supabase.from('risk_snapshots')
          .select('net_buffer, pending_payouts_amount, pending_payouts_count, created_at')
          .order('created_at', { ascending: false }).limit(1).maybeSingle(),
        supabase.rpc('get_dispute_rate_snapshot', { window_days: 30 }) as any,
        supabase.from('econ_breaker_state').select('rolling_pass_rate, breaker_level').single(),
        supabase.from('payouts').select('amount')
          .in('status', ['approved', 'payment_initiated']),
      ]);

      const inFlightTotal = (payoutsInFlightRes.data || []).reduce((s, p) => s + Number(p.amount || 0), 0);

      return {
        netBuffer: snapRes.data?.net_buffer ?? null,
        pendingPayoutsAmount: snapRes.data?.pending_payouts_amount ?? 0,
        pendingPayoutsCount: snapRes.data?.pending_payouts_count ?? 0,
        snapshotAge: snapRes.data?.created_at
          ? differenceInHours(new Date(), new Date(snapRes.data.created_at))
          : null,
        disputeRate: disputeRes.data?.dispute_rate_percent ?? null,
        disputeLevel: disputeRes.data?.alert_level ?? 'ok',
        passRate: breakerRes.data?.rolling_pass_rate ?? null,
        breakerLevel: breakerRes.data?.breaker_level ?? 'normal',
        inFlightTotal,
      };
    },
    refetchInterval: 60_000,
  });
}

// ── CPC hook (reads latest snapshot, does NOT compute) ──

interface CpcSnapshot {
  score: number;
  band: string;
  realized_margin: number;
  realized_margin_score: number;
  buffer_coverage_ratio: number;
  buffer_coverage_score: number;
  pass_rate: number | null;
  pass_rate_score: number;
  monte_carlo_ruin_pct: number;
  monte_carlo_score: number;
  breaker_level: string;
  breaker_penalty: boolean;
  revenue_30d: number;
  payouts_30d: number;
  in_flight_payouts: number;
  net_buffer: number | null;
  source: string;
  computed_at: string;
}

function useCpc() {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ['mc-cpc'],
    queryFn: async (): Promise<CpcSnapshot | null> => {
      const { data, error } = await supabase
        .from('cpc_snapshots')
        .select('*')
        .order('computed_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) { console.warn('CPC read failed:', error); return null; }
      return data;
    },
    refetchInterval: 60_000,
  });

  // "Compute Now" calls edge function, then refetches snapshot
  // Cooldown: disable if last snapshot < 2 min old
  const isFresh = query.data?.computed_at
    ? differenceInMinutes(new Date(), new Date(query.data.computed_at)) < 2
    : false;

  const computeNow = useMutation({
    mutationFn: async () => {
      if (isFresh) throw new Error('Snapshot is less than 2 minutes old');
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Not authenticated');
      const res = await fetch(`${SUPABASE_FUNCTIONS_URL}/compute-cpc`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['mc-cpc'] });
      toast.success('CPC computed');
    },
    onError: (err) => toast.error(`CPC error: ${(err as Error).message}`),
  });

  return { ...query, computeNow, isFresh };
}

// ── Components ──

function SwitchDot({ paused, unknown, label }: { paused: boolean; unknown?: boolean; label: string }) {
  return (
    <div className="flex items-center gap-1.5">
      {unknown ? (
        <AlertTriangle className="h-3.5 w-3.5 text-warning" />
      ) : paused ? (
        <PowerOff className="h-3.5 w-3.5 text-destructive" />
      ) : (
        <Power className="h-3.5 w-3.5 text-success" />
      )}
      <span className="text-xs font-medium">{label}</span>
    </div>
  );
}

// ── Cash Reserve Editor ──

function CashReserveEditor({ onSaved }: { onSaved: () => void }) {
  const [cashReserve, setCashReserve] = useState('');
  const [avgPayout, setAvgPayout] = useState('');
  const [loaded, setLoaded] = useState(false);

  // Load current settings
  const { data: settings } = useQuery({
    queryKey: ['liability-buffer-settings'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_liability_buffer_settings');
      if (error) throw error;
      return data as { cash_reserve: number; assumed_avg_first_payout: number } | null;
    },
  });

  useEffect(() => {
    if (settings && !loaded) {
      setCashReserve(String(settings.cash_reserve));
      setAvgPayout(String(settings.assumed_avg_first_payout));
      setLoaded(true);
    }
  }, [settings, loaded]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const cr = Number(cashReserve);
      const avg = Number(avgPayout);
      if (isNaN(cr) || cr < 0) throw new Error('Cash reserve must be ≥ 0');
      if (isNaN(avg) || avg <= 0) throw new Error('Avg payout must be > 0');
      const { error } = await supabase.rpc('upsert_liability_buffer_settings', {
        _cash_reserve: cr,
        _assumed_avg_first_payout: avg,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Cash reserve updated — re-running Governor…');
      onSaved();
    },
    onError: (err) => toast.error(`Save failed: ${(err as Error).message}`),
  });

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <Settings className="h-4 w-4" /> Cash Reserve Settings
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap items-end gap-4">
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Cash Reserve ($)</label>
            <Input
              type="number"
              min={0}
              step={100}
              value={cashReserve}
              onChange={e => setCashReserve(e.target.value)}
              className="w-40 h-8 text-sm"
              placeholder="e.g. 20000"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Assumed Avg 1st Payout ($)</label>
            <Input
              type="number"
              min={1}
              step={50}
              value={avgPayout}
              onChange={e => setAvgPayout(e.target.value)}
              className="w-40 h-8 text-sm"
              placeholder="e.g. 300"
            />
          </div>
          <Button
            size="sm"
            onClick={() => saveMutation.mutate()}
            disabled={saveMutation.isPending}
          >
            {saveMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <Save className="h-3.5 w-3.5 mr-1" />}
            Save & Recheck
          </Button>
        </div>
        <p className="text-xs text-muted-foreground mt-2">
          This is your actual cash set aside for payout obligations. Net Buffer = Cash Reserve − pending liabilities − forward exposure.
        </p>
      </CardContent>
    </Card>
  );
}

// ── Main Page ──

export default function MissionControl() {
  const governor = useGovernor();
  const actionItems = useActionItems();
  const money = useMoneySnapshot();
  const cpc = useCpc();

  const gov = governor.data;
  const ls = gov?.lockState;
  const cfg = gov?.effectiveConfig;
  const isLoading = governor.isLoading;
  const cpcData = cpc.data;

  const refetchAll = () => {
    governor.refetch();
    actionItems.refetch();
    money.refetch();
    cpc.refetch();
  };

  if (isLoading) {
    return (
      <DashboardLayout title="Mission Control" navItems={missionControlNavItems}>
        <div className="flex items-center justify-center h-64">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </DashboardLayout>
    );
  }

  const items = actionItems.data || [];
  const m = money.data;

  // Extract live net buffer from Governor's capital domain checks (canonical truth)
  const liveNetBuffer = (() => {
    const check = gov?.capital?.checks?.find(c => c.name.includes('Net buffer'));
    if (!check) return null;
    // Format: "$-500" or "$14,500"
    const match = check.detail.match(/\$([-+]?[\d,]+)/);
    return match ? Number(match[1].replace(/,/g, '')) : null;
  })();

  const isAllClear = gov?.verdict === 'safe' && items.length === 0 &&
    (['capital', 'processor', 'cohort', 'riskEngine'] as const).every(d => gov[d]?.signal !== 'red');

  // ── Autopilot rollup: one-line "is the light green?" digest ──
  const redCount = items.filter(i => i.severity === 'red').length;
  const yellowCount = items.filter(i => i.severity === 'yellow').length;
  const govBad = !!gov && gov.verdict !== 'safe';
  const disputeBad = !!m && m.disputeLevel && m.disputeLevel !== 'ok';
  const breakerBad = !!m && m.breakerLevel && m.breakerLevel !== 'normal';
  const autopilotGreen = !govBad && !disputeBad && !breakerBad && redCount === 0 && yellowCount === 0;
  const autopilotTone: 'green' | 'yellow' | 'red' =
    govBad || disputeBad || breakerBad || redCount > 0 ? 'red'
    : yellowCount > 0 ? 'yellow'
    : 'green';
  const firstActionLink = items[0]?.link;
  // Single queue chip — domain health (Governor/Disputes/Breaker) is owned by the GO/NO-GO banner below.
  const totalCount = redCount + yellowCount;
  const queueChipLabel = totalCount === 0
    ? 'Queue clear'
    : redCount > 0 && yellowCount > 0
    ? `${totalCount} items · ${redCount} urgent`
    : redCount > 0
    ? `${redCount} urgent`
    : `${yellowCount} review`;
  const queueChipTone: 'green' | 'yellow' | 'red' =
    redCount > 0 ? 'red' : yellowCount > 0 ? 'yellow' : 'green';

  return (
    <DashboardLayout title="Mission Control" navItems={missionControlNavItems}>
      <div className="space-y-6 max-w-5xl">
        {/* ── Autopilot status strip — the "is the light green?" line ── */}
        <div
          className={`flex flex-wrap items-center gap-3 rounded-lg border px-4 py-2.5 text-sm ${
            autopilotTone === 'green'
              ? 'border-success/40 bg-success/5 text-success'
              : autopilotTone === 'yellow'
              ? 'border-warning/40 bg-warning/5 text-warning'
              : 'border-destructive/40 bg-destructive/5 text-destructive'
          }`}
          role="status"
          aria-live="polite"
        >
          {autopilotTone === 'green' ? (
            <CheckCircle2 className="h-4 w-4 shrink-0" />
          ) : autopilotTone === 'yellow' ? (
            <AlertTriangle className="h-4 w-4 shrink-0" />
          ) : (
            <XCircle className="h-4 w-4 shrink-0" />
          )}
          <span className="font-semibold">
            {autopilotGreen
              ? 'Autopilot — all systems green. Close the laptop.'
              : redCount + yellowCount > 0
              ? `${redCount + yellowCount} item${redCount + yellowCount === 1 ? '' : 's'} need you`
              : 'Attention needed — see status below'}
          </span>
          <div className="flex flex-wrap items-center gap-1.5 ml-auto">
            <span
              className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${
                queueChipTone === 'green'
                  ? 'border-success/30 bg-success/10 text-success'
                  : queueChipTone === 'yellow'
                  ? 'border-warning/30 bg-warning/10 text-warning'
                  : 'border-destructive/30 bg-destructive/10 text-destructive'
              }`}
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  queueChipTone === 'green' ? 'bg-success' : queueChipTone === 'yellow' ? 'bg-warning' : 'bg-destructive'
                }`}
              />
              {queueChipLabel}
            </span>
            {!autopilotGreen && firstActionLink && (
              <Button asChild size="sm" variant="outline" className="h-7 ml-1">
                <Link to={firstActionLink}>
                  Jump to action <ChevronRight className="h-3 w-3 ml-0.5" />
                </Link>
              </Button>
            )}
          </div>
        </div>

        {/* ── GO / NO-GO Banner ── */}
        {gov ? (
          <Card className={`border-2 ${gov.verdict === 'safe' ? 'border-success/50 bg-success/5' : 'border-destructive/50 bg-destructive/5'}`}>
            <CardContent className="pt-6 pb-4">
              <div className="flex items-center gap-4">
                {gov.verdict === 'safe' ? (
                  <ShieldCheck className="h-14 w-14 text-success shrink-0" />
                ) : (
                  <ShieldX className="h-14 w-14 text-destructive shrink-0" />
                )}

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-3 flex-wrap">
                    <h2 className={`text-3xl font-black ${gov.verdict === 'safe' ? 'text-success' : 'text-destructive'}`}>
                      {gov.verdict === 'safe' ? 'GO' : 'NO-GO'}
                    </h2>

                    {/* Domain pills */}
                    <div className="flex gap-1.5">
                      {(['capital', 'processor', 'cohort', 'riskEngine'] as const).map(d => {
                        const domain = gov[d];
                        return (
                          <Badge key={d} variant={domain.signal === 'red' ? 'destructive' : 'outline'}
                            className={domain.signal === 'green' ? 'border-success/50 text-success' : domain.signal === 'yellow' ? 'border-warning/50 text-warning' : ''}>
                            {DOMAIN_META[d].label}
                          </Badge>
                        );
                      })}
                    </div>
                  </div>

                  {/* Lock state + streak inline */}
                  <div className="flex items-center gap-4 mt-2 flex-wrap">
                    <div className="flex items-center gap-3">
                      <SwitchDot paused={ls?.inbound_paused ?? false} label="Inbound" />
                      <SwitchDot paused={ls?.outbound_paused ?? false} label="Outbound" />
                      <SwitchDot paused={ls?.intake_paused ?? false} unknown={ls?.intake_unknown} label="Intake" />
                    </div>
                    <span className="text-xs text-muted-foreground">|</span>
                    <span className="text-xs text-muted-foreground">
                      Owner: <span className="font-medium text-foreground">{ls?.lock_owner ?? 'none'}</span>
                    </span>
                    <span className="text-xs text-muted-foreground">|</span>
                    <span className="text-xs text-muted-foreground">
                      Streak: <span className={`font-bold ${gov.safeStreak >= gov.unlockThreshold ? 'text-success' : 'text-foreground'}`}>{gov.safeStreak}</span>/{gov.unlockThreshold}
                    </span>
                    <span className="text-xs text-muted-foreground">|</span>
                    <span className="text-xs text-muted-foreground">
                      {formatDistanceToNow(new Date(gov.certifiedAt), { addSuffix: true })}
                    </span>
                  </div>

                  {/* Blockers inline */}
                  {gov.blockers.length > 0 && (
                    <div className="mt-3 space-y-1">
                      {gov.blockers.slice(0, 3).map((b, i) => (
                        <div key={i} className="flex items-center gap-2 text-sm text-destructive">
                          <XCircle className="h-3.5 w-3.5 shrink-0" />
                          <span className="font-medium">[{b.domain}]</span> {b.detail}
                        </div>
                      ))}
                      {gov.blockers.length > 3 && (
                        <Link to="/admin/governor" className="text-xs text-primary hover:underline">
                          +{gov.blockers.length - 3} more blockers →
                        </Link>
                      )}
                    </div>
                  )}

                  {/* Warnings collapsed */}
                  {gov.warnings?.length > 0 && gov.blockers.length === 0 && (
                    <p className="text-xs text-warning mt-2">
                      {gov.warnings.length} warning{gov.warnings.length > 1 ? 's' : ''} — <Link to="/admin/governor" className="underline">view</Link>
                    </p>
                  )}
                </div>

                <div className="flex flex-col gap-2 shrink-0">
                  <Button size="sm" onClick={() => governor.runNow.mutate()} disabled={governor.runNow.isPending}>
                    <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${governor.runNow.isPending ? 'animate-spin' : ''}`} />
                    Run Now
                  </Button>
                  <Button size="sm" variant="outline" asChild>
                    <Link to="/admin/governor">Full Governor →</Link>
                  </Button>
                </div>
              </div>

              {/* All Clear banner */}
              {isAllClear && (
                <div className="mt-3 flex items-center gap-2 text-sm text-success border-t border-success/20 pt-3">
                  <CheckCircle2 className="h-4 w-4" />
                  <span className="font-medium">All clear — no action items, all domains healthy.</span>
                </div>
              )}
            </CardContent>
          </Card>
        ) : governor.error ? (
          <Card className="border-destructive/50 bg-destructive/5">
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <AlertTriangle className="h-8 w-8 text-destructive" />
                <div>
                  <p className="font-bold text-destructive">Governor Error</p>
                  <p className="text-sm text-muted-foreground">{(governor.error as Error).message}</p>
                </div>
              </div>
            </CardContent>
          </Card>
        ) : null}

        {/* ── Action Items ── */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base font-semibold flex items-center gap-2">
                <AlertTriangle className="h-4 w-4" />
                Today's Action Items
                {items.length > 0 && (
                  <Badge variant={items.some(i => i.severity === 'red') ? 'destructive' : 'secondary'}>
                    {items.length}
                  </Badge>
                )}
              </CardTitle>
              <Button variant="ghost" size="sm" onClick={() => actionItems.refetch()} disabled={actionItems.isRefetching}>
                <RefreshCw className={`h-3.5 w-3.5 ${actionItems.isRefetching ? 'animate-spin' : ''}`} />
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {actionItems.isLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : items.length === 0 ? (
              <div className="flex items-center gap-3 py-4 text-success">
                <CheckCircle2 className="h-5 w-5" />
                <p className="text-sm font-medium">Nothing needs your attention right now.</p>
              </div>
            ) : (
              <div className="space-y-2">
                {items.map(item => (
                  <Link key={item.id} to={item.link}
                    className="flex items-center gap-3 p-3 rounded-lg border border-border hover:bg-muted/50 transition-colors group">
                    <div className={`h-2.5 w-2.5 rounded-full shrink-0 ${
                      item.severity === 'red' ? 'bg-destructive' : item.severity === 'yellow' ? 'bg-warning' : 'bg-success'
                    }`} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium">{item.title}</p>
                      <p className="text-xs text-muted-foreground">{item.detail}</p>
                    </div>
                    <ChevronRight className="h-4 w-4 text-muted-foreground group-hover:text-foreground shrink-0" />
                  </Link>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* ── System Health (4 domain tiles) ── */}
        {gov && (
          <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
            {(['capital', 'processor', 'cohort', 'riskEngine'] as const).map(d => {
              const domain = gov[d];
              const meta = DOMAIN_META[d];
              return (
                <Card key={d} className={`border ${
                  domain.signal === 'green' ? 'border-success/30' : domain.signal === 'yellow' ? 'border-warning/30' : 'border-destructive/30'
                }`}>
                  <CardContent className="pt-4 pb-3 px-4">
                    <div className="flex items-center justify-between mb-2">
                      <span className={`text-xs font-semibold uppercase tracking-wide ${meta.color}`}>{meta.label}</span>
                      {domain.blockerCount > 0 ? (
                        <Badge variant="destructive" className="text-[10px] px-1.5 py-0">{domain.blockerCount}B</Badge>
                      ) : domain.warningCount > 0 ? (
                        <Badge variant="outline" className="text-[10px] px-1.5 py-0 border-warning/50 text-warning">{domain.warningCount}W</Badge>
                      ) : (
                        <CheckCircle2 className="h-3.5 w-3.5 text-success" />
                      )}
                    </div>
                    <div className="space-y-1">
                      {domain.checks.slice(0, 3).map((c, i) => (
                        <div key={i} className="flex items-center gap-1.5 text-xs">
                          {c.ok ? (
                            <CheckCircle2 className="h-3 w-3 text-success shrink-0" />
                          ) : (
                            <XCircle className={`h-3 w-3 shrink-0 ${c.severity === 'blocker' ? 'text-destructive' : 'text-warning'}`} />
                          )}
                          <span className="truncate text-muted-foreground">{c.name}</span>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}

        {/* ── Money & Risk Snapshot ── */}
        {m && (
          <div className="grid gap-3 grid-cols-2 lg:grid-cols-5">
            <SnapshotTile
              label="Net Buffer"
              value={liveNetBuffer !== null
                ? `$${liveNetBuffer.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
                : m.netBuffer !== null
                  ? `$${Number(m.netBuffer).toLocaleString(undefined, { maximumFractionDigits: 0 })}`
                  : '—'}
              signal={
                liveNetBuffer !== null
                  ? liveNetBuffer > 0 ? 'green' : 'red'
                  : m.netBuffer === null ? 'yellow' : Number(m.netBuffer) > 0 ? 'green' : 'red'
              }
              sub={liveNetBuffer !== null
                ? 'LIVE (Governor)'
                : m.snapshotAge !== null
                  ? `⚠️ STALE (${m.snapshotAge}h ago)`
                  : undefined}
            />
            <SnapshotTile
              label="In-Flight Payouts"
              value={`$${m.inFlightTotal.toLocaleString(undefined, { maximumFractionDigits: 0 })}`}
              signal={m.inFlightTotal > 10000 ? 'yellow' : 'green'}
              sub={`${m.pendingPayoutsCount} pending`}
            />
            <SnapshotTile
              label="Dispute Rate"
              value={m.disputeRate !== null ? `${Number(m.disputeRate).toFixed(2)}%` : '—'}
              signal={m.disputeLevel === 'ok' ? 'green' : m.disputeLevel === 'warn' ? 'yellow' : 'red'}
              sub="30-day"
            />
            <SnapshotTile
              label="Pass Rate"
              value={m.passRate !== null ? `${Number(m.passRate).toFixed(1)}%` : '—'}
              signal={m.breakerLevel === 'normal' ? 'green' : m.breakerLevel === 'elevated' ? 'yellow' : 'red'}
              sub={`Breaker: ${m.breakerLevel}`}
            />
            <SnapshotTile
              label="Breaker"
              value={m.breakerLevel?.toUpperCase() ?? '—'}
              signal={m.breakerLevel === 'normal' ? 'green' : m.breakerLevel === 'elevated' ? 'yellow' : 'red'}
            />
          </div>
        )}

        {/* ── Cash Reserve Settings (inline) ── */}
        <CashReserveEditor onSaved={() => { governor.refetch(); money.refetch(); }} />

        {/* ── Cohort Profitability Confidence ── */}
        <Card className={`border ${
          cpcData?.band === 'high' ? 'border-success/30' : cpcData?.band === 'medium' ? 'border-warning/30' : cpcData?.band === 'low' ? 'border-destructive/30' : 'border-border'
        }`}>
          <CardContent className="pt-4 pb-3 px-4">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Gauge className="h-4 w-4 text-muted-foreground" />
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Cohort Profitability Confidence</p>
              </div>
              <div className="flex items-center gap-2">
                {cpcData ? (
                  <Badge variant={cpcData.band === 'high' ? 'outline' : cpcData.band === 'medium' ? 'secondary' : 'destructive'}
                    className={cpcData.band === 'high' ? 'border-success/50 text-success' : cpcData.band === 'medium' ? 'border-warning/50 text-warning' : ''}>
                    {cpcData.band.toUpperCase()} ({cpcData.score})
                  </Badge>
                ) : cpc.isLoading ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                ) : (
                  <Badge variant="outline" className="text-[10px] border-warning/50 text-warning">No data</Badge>
                )}
                <Button variant="ghost" size="sm" onClick={() => cpc.computeNow.mutate()} disabled={cpc.computeNow.isPending || cpc.isFresh} className="h-7 px-2" title={cpc.isFresh ? 'Snapshot is fresh (< 2 min)' : 'Compute CPC now'}>
                  <RefreshCw className={`h-3 w-3 ${cpc.computeNow.isPending ? 'animate-spin' : ''}`} />
                </Button>
              </div>
            </div>
            {cpcData ? (
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <CpcSubScore
                  label="Realized Margin"
                  value={`$${Number(cpcData.realized_margin).toLocaleString()}`}
                  score={Number(cpcData.realized_margin_score)}
                  sub={`Rev $${Number(cpcData.revenue_30d).toLocaleString()} · Pay $${Number(cpcData.payouts_30d).toLocaleString()}`}
                />
                <CpcSubScore
                  label="Buffer Coverage"
                  value={`${cpcData.buffer_coverage_ratio}×`}
                  score={Number(cpcData.buffer_coverage_score)}
                  sub={`Buffer: $${cpcData.net_buffer !== null ? Number(cpcData.net_buffer).toLocaleString() : '—'}`}
                />
                <CpcSubScore
                  label="Stress Ruin Risk"
                  value={`${cpcData.monte_carlo_ruin_pct}%`}
                  score={Number(cpcData.monte_carlo_score)}
                  sub="Phase 2"
                />
                <CpcSubScore
                  label="Pass Rate"
                  value={cpcData.pass_rate !== null ? `${(Number(cpcData.pass_rate) * 100).toFixed(1)}%` : '—'}
                  score={Number(cpcData.pass_rate_score)}
                  sub={cpcData.breaker_penalty ? `Breaker: ${cpcData.breaker_level} (penalty)` : `Breaker: ${cpcData.breaker_level}`}
                />
              </div>
            ) : !cpc.isLoading && (
              <p className="text-xs text-muted-foreground">CPC not yet computed. Hit refresh or wait for cron.</p>
            )}
            {cpcData && cpcData.band === 'low' && (
              <div className="mt-3 pt-2 border-t border-destructive/20 text-xs text-destructive flex items-center gap-2">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                <span>Economics at risk — consider tightening pass gates, increasing buffer, or pausing intake.</span>
              </div>
            )}
            {cpcData && (
              <div className="mt-2 pt-2 border-t border-border text-[11px] text-muted-foreground">
                Computed {formatDistanceToNow(new Date(cpcData.computed_at), { addSuffix: true })} · Source: {cpcData.source}
              </div>
            )}
          </CardContent>
        </Card>


        {gov && (
          <Card className="border-border">
            <CardContent className="pt-4 pb-3 px-4">
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Auto-Pilot Status</p>
                {!cfg && (
                  <Badge variant="outline" className="border-warning/50 text-warning text-[10px]">Config unavailable</Badge>
                )}
              </div>
              {cfg ? (
                <div className="grid grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-2">
                  <AutoPilotRow
                    ok={cfg.auto_lock !== false}
                    label={`Auto-lock: ${cfg.auto_lock !== false ? 'ON' : 'OFF'}`}
                  />
                  <AutoPilotRow
                    ok={cfg.auto_unlock !== false}
                    label={`Staged unlock: ${cfg.auto_unlock !== false ? 'ON' : 'OFF'} (${gov.safeStreak}/${gov.unlockThreshold})`}
                  />
                  <AutoPilotRow
                    ok={true}
                    label={`Owner: ${ls?.lock_owner ?? 'none'}`}
                  />
                  <AutoPilotRow
                    ok={!ls?.intake_unknown && (gov.verdict === 'safe' ? !ls?.intake_paused : ls?.intake_paused === true)}
                    label={`Intake: ${ls?.intake_unknown ? 'UNKNOWN — global_intake_active unset' : ls?.intake_paused ? 'PAUSED' : 'ACTIVE'}`}
                    warn={ls?.intake_unknown}
                  />
                  <AutoPilotRow
                    ok={m?.breakerLevel === 'normal'}
                    label={`Breaker: ${m?.breakerLevel?.toUpperCase() ?? '—'} · Pass rate: ${m?.passRate !== null && m?.passRate !== undefined ? `${Number(m.passRate).toFixed(1)}%` : '—'}`}
                    warn={m?.passRate === null || m?.passRate === undefined}
                  />
                  <AutoPilotRow
                    ok={(() => {
                      const buf = liveNetBuffer ?? (m?.netBuffer !== null ? Number(m?.netBuffer) : null);
                      return buf !== null && cfg.min_net_buffer !== undefined ? buf >= cfg.min_net_buffer : buf !== null;
                    })()}
                    label={`Buffer: $${(liveNetBuffer ?? (m?.netBuffer !== null && m?.netBuffer !== undefined ? Number(m.netBuffer) : null))?.toLocaleString(undefined, { maximumFractionDigits: 0 }) ?? '—'} / min $${cfg.min_net_buffer !== undefined ? cfg.min_net_buffer.toLocaleString() : '—'}${liveNetBuffer !== null ? ' (live)' : ''}`}
                  />
                </div>
              ) : (
                <p className="text-xs text-warning">Config missing from governor response — verify edge deployment.</p>
              )}
              {/* Last run metadata */}
              <div className="flex items-center gap-3 mt-2 pt-2 border-t border-border text-[11px] text-muted-foreground">
                <span>Last run: {formatDistanceToNow(new Date(gov.certifiedAt), { addSuffix: true })}</span>
                <span>·</span>
                <span>Source: <span className="font-medium text-foreground">{gov.source || '—'}</span></span>
                <span>·</span>
                <span>Action: <span className="font-medium text-foreground">{gov.autoAction || 'none'}</span></span>
                {gov.strictMode && (
                  <>
                    <span>·</span>
                    <Badge variant="outline" className="text-[10px] px-1.5 py-0 border-warning/50 text-warning">Strict Mode</Badge>
                  </>
                )}
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </DashboardLayout>
  );
}

function SnapshotTile({ label, value, signal, sub }: { label: string; value: string; signal: Signal; sub?: string }) {
  return (
    <Card className={`border ${signal === 'green' ? 'border-border' : signal === 'yellow' ? 'border-warning/30' : 'border-destructive/30'}`}>
      <CardContent className="pt-3 pb-3 px-4">
        <p className="text-xs text-muted-foreground font-medium mb-1">{label}</p>
        <p className={`text-lg font-bold tabular-nums ${
          signal === 'red' ? 'text-destructive' : signal === 'yellow' ? 'text-warning' : ''
        }`}>{value}</p>
        {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
      </CardContent>
    </Card>
  );
}

function AutoPilotRow({ ok, label, warn }: { ok: boolean; label: string; warn?: boolean }) {
  return (
    <div className="flex items-center gap-1.5 text-xs">
      {warn ? (
        <AlertTriangle className="h-3 w-3 text-warning shrink-0" />
      ) : ok ? (
        <CheckCircle2 className="h-3 w-3 text-success shrink-0" />
      ) : (
        <XCircle className="h-3 w-3 text-destructive shrink-0" />
      )}
      <span className="text-muted-foreground">{label}</span>
    </div>
  );
}

function CpcSubScore({ label, value, score, sub }: { label: string; value: string; score: number; sub?: string }) {
  const signal: Signal = score >= 0.7 ? 'green' : score >= 0.4 ? 'yellow' : 'red';
  return (
    <div className="space-y-0.5">
      <p className="text-[11px] text-muted-foreground font-medium">{label}</p>
      <p className={`text-sm font-bold tabular-nums ${
        signal === 'red' ? 'text-destructive' : signal === 'yellow' ? 'text-warning' : ''
      }`}>{value}</p>
      <div className="flex items-center gap-1.5">
        <div className="flex-1 h-1 rounded-full bg-muted overflow-hidden">
          <div className={`h-full rounded-full transition-all ${
            signal === 'green' ? 'bg-success' : signal === 'yellow' ? 'bg-warning' : 'bg-destructive'
          }`} style={{ width: `${Math.round(score * 100)}%` }} />
        </div>
        <span className="text-[10px] text-muted-foreground tabular-nums">{score}</span>
      </div>
      {sub && <p className="text-[10px] text-muted-foreground truncate">{sub}</p>}
    </div>
  );
}
