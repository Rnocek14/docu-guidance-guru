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
  Shield, ChevronRight, ExternalLink,
} from 'lucide-react';
import { formatDistanceToNow, differenceInHours, differenceInMinutes } from 'date-fns';
import { toast } from 'sonner';
import { missionControlNavItems } from '@/components/layout/AdminNav';

// ── Types ──

interface DomainCheck { name: string; ok: boolean; severity: 'blocker' | 'warning'; detail: string }
interface DomainResult { safe: boolean; signal: string; checks: DomainCheck[]; blockerCount: number; warningCount: number }
interface LockState {
  inbound_paused: boolean; outbound_paused: boolean; intake_paused: boolean;
  intake_unknown: boolean; lock_owner: 'governor' | 'operator' | 'none';
  pause_reason: string | null; paused_at: string | null;
}
interface GovernorConfig {
  enabled?: boolean;
  auto_lock?: boolean;
  auto_unlock?: boolean;
  min_net_buffer?: number;
  unlock_after_consecutive_safe?: number;
  strict_launch_mode?: boolean;
}
interface GovernorResult {
  verdict: 'safe' | 'not_safe' | 'error';
  capital: DomainResult; processor: DomainResult; cohort: DomainResult; riskEngine: DomainResult;
  blockers: { domain: string; detail: string; severity: string }[];
  warnings: { domain: string; detail: string }[];
  autoAction: string; autoActionDetail: string; certifiedAt: string;
  safeStreak: number; strictMode: boolean; unlockThreshold: number; lockState: LockState;
  effectiveConfig?: GovernorConfig;
  source?: string;
}

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
    return res.json();
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
          .in('status', ['pending', 'under_review', 'approved', 'payment_failed']),
        supabase.from('flags').select('id, flag_type, reason, severity, account_id, created_at')
          .eq('status', 'pending').order('created_at', { ascending: false }).limit(10),
        supabase.from('cron_health_config').select('*').eq('enabled', true),
        supabase.from('cron_http_runs').select('jobname, http_status, ran_at')
          .order('ran_at', { ascending: false }).limit(200),
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

      // Failed payments
      const failedPayouts = (payoutsRes.data || []).filter(p => p.status === 'payment_failed');
      if (failedPayouts.length > 0) {
        items.push({
          id: 'failed-payments',
          type: 'payout',
          severity: 'red',
          title: `${failedPayouts.length} payout payment${failedPayouts.length > 1 ? 's' : ''} failed`,
          detail: 'Requires manual investigation',
          link: '/risk/queue?status=payment_failed',
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

// ── Main Page ──

export default function MissionControl() {
  const governor = useGovernor();
  const actionItems = useActionItems();
  const money = useMoneySnapshot();

  const gov = governor.data;
  const ls = gov?.lockState;
  const cfg = gov?.effectiveConfig;
  const isLoading = governor.isLoading;

  const refetchAll = () => {
    governor.refetch();
    actionItems.refetch();
    money.refetch();
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

  const isAllClear = gov?.verdict === 'safe' && items.length === 0 &&
    (['capital', 'processor', 'cohort', 'riskEngine'] as const).every(d => gov[d]?.signal !== 'red');

  return (
    <DashboardLayout title="Mission Control" navItems={missionControlNavItems}>
      <div className="space-y-6 max-w-5xl">
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
              value={m.netBuffer !== null ? `$${Number(m.netBuffer).toLocaleString(undefined, { maximumFractionDigits: 0 })}` : '—'}
              signal={m.netBuffer === null ? 'yellow' : Number(m.netBuffer) > 0 ? 'green' : 'red'}
              sub={m.snapshotAge !== null ? `${m.snapshotAge}h ago` : undefined}
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

        {/* ── Auto-Pilot Status ── */}
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
                    ok={m?.netBuffer !== null && cfg.min_net_buffer !== undefined ? Number(m?.netBuffer) >= cfg.min_net_buffer : m?.netBuffer !== null}
                    label={`Buffer: $${m?.netBuffer !== null && m?.netBuffer !== undefined ? Number(m.netBuffer).toLocaleString(undefined, { maximumFractionDigits: 0 }) : '—'} / min $${cfg.min_net_buffer !== undefined ? cfg.min_net_buffer.toLocaleString() : '—'}`}
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
