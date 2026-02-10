import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase, SUPABASE_FUNCTIONS_URL } from '@/integrations/supabase/client';
import { DashboardLayout, adminNavItems } from '@/components/layout/DashboardLayout';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  ShieldCheck,
  ShieldX,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  RefreshCw,
  Clock,
  DollarSign,
  FileText,
  Loader2,
  ExternalLink,
  Info,
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

interface CheckResult { ok: boolean; detail: string; verifyUnavailable?: boolean }

interface TierReadiness {
  id: string; name: string; isLive: boolean; entryFee: number;
  configLiveReady: boolean;
  checks: { purchasable: CheckResult; stripeWired: CheckResult; cohortReady: CheckResult; serverGateOk: CheckResult };
}

interface CohortExposure {
  id: string; name: string; tier_id: string | null;
  pending_amount: number; approved_unpaid: number; total_exposure: number;
  pending_count: number; approved_count: number;
}

interface AuditHealth {
  ok: boolean; lastSnapshotAt: string | null; lastReconAt: string | null;
  snapshotAgeHours: number | null; reconAgeHours: number | null;
  failuresLast24h: number; detail: string;
}

interface Blocker { key: string; severity: 'warning' | 'blocking'; detail: string }

interface ReadinessResponse {
  checkedAt: string; deep: boolean; safeToSell: boolean;
  blockers: Blocker[]; tiers: TierReadiness[]; cohorts: CohortExposure[];
  audits: AuditHealth;
  liability: {
    cashReserve: number; assumedAvgPayout: number; totalPending: number;
    approvedUnpaid: number; openingSoonCount: number; openingSoonLiability: number;
    netBuffer: number | null;
  };
}

function fmt(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
}

function CheckIcon({ ok, unavailable }: { ok: boolean; unavailable?: boolean }) {
  if (unavailable) return <AlertTriangle className="h-4 w-4 text-warning shrink-0" />;
  return ok
    ? <CheckCircle2 className="h-4 w-4 text-success shrink-0" />
    : <XCircle className="h-4 w-4 text-destructive shrink-0" />;
}

const CHECK_LABELS: Record<string, string> = {
  purchasable: 'Purchasable',
  stripeWired: 'Stripe Wired',
  cohortReady: 'Cohort Ready',
  serverGateOk: 'Server Gate',
};

export default function AdminReadiness() {
  const [deep, setDeep] = useState(false);

  const fetchReadiness = async (deepMode: boolean): Promise<ReadinessResponse> => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) throw new Error('Not authenticated');

    const res = await fetch(
      `${SUPABASE_FUNCTIONS_URL}/get-admin-readiness?deep=${deepMode ? '1' : '0'}`,
      { headers: { Authorization: `Bearer ${session.access_token}` } }
    );
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${res.status}`);
    }
    return res.json() as Promise<ReadinessResponse>;
  };

  const { data: activeData, isLoading: activeLoading, error, refetch, isRefetching } = useQuery({
    queryKey: ['admin-readiness', deep],
    queryFn: () => fetchReadiness(deep),
    refetchInterval: 30_000,
  });

  if (error) {
    return (
      <DashboardLayout title="Launch Readiness" navItems={adminNavItems}>
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>{(error as Error).message}</AlertDescription>
        </Alert>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout title="Launch Readiness" navItems={adminNavItems}>
      <div className="space-y-6 max-w-5xl">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-bold tracking-tight">Safe to Sell?</h2>
            <p className="text-muted-foreground text-sm">
              Fail-closed readiness gate. All checks must pass before accepting purchases.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant={deep ? 'default' : 'outline'} size="sm"
              onClick={() => setDeep(!deep)}
            >
              {deep ? 'Deep Mode ON' : 'Deep Verify'}
            </Button>
            <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isRefetching}>
              <RefreshCw className={`h-4 w-4 mr-1.5 ${isRefetching ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
          </div>
        </div>

        {activeLoading ? (
          <div className="flex items-center justify-center h-64">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : activeData ? (
          <>
            {/* ── Verdict Card ── */}
            <Card className={`border-2 ${activeData.safeToSell ? 'border-success/50 bg-success/5' : 'border-destructive/50 bg-destructive/5'}`}>
              <CardContent className="pt-6">
                <div className="flex items-start gap-4">
                  {activeData.safeToSell ? (
                    <ShieldCheck className="h-10 w-10 text-success shrink-0" />
                  ) : (
                    <ShieldX className="h-10 w-10 text-destructive shrink-0" />
                  )}
                  <div className="flex-1">
                    <div className="flex items-center gap-3">
                      <h3 className={`text-xl font-bold ${activeData.safeToSell ? 'text-success' : 'text-destructive'}`}>
                        {activeData.safeToSell ? 'SAFE TO SELL' : 'NOT SAFE TO SELL'}
                      </h3>
                      <Badge variant={activeData.deep ? 'default' : 'secondary'}>
                        {activeData.deep ? 'Deep Verified' : 'Config Only'}
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">
                      Checked {formatDistanceToNow(new Date(activeData.checkedAt), { addSuffix: true })}
                    </p>

                    {activeData.blockers.length > 0 && (
                      <div className="mt-4 space-y-2">
                        <p className="text-sm font-medium">
                          {activeData.blockers.filter(b => b.severity === 'blocking').length} blocking
                          {activeData.blockers.filter(b => b.severity === 'warning').length > 0 &&
                            `, ${activeData.blockers.filter(b => b.severity === 'warning').length} warning(s)`}
                        </p>
                        <ul className="space-y-1.5">
                          {activeData.blockers.map(b => (
                            <li key={b.key} className="flex items-start gap-2 text-sm">
                              {b.severity === 'blocking'
                                ? <XCircle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
                                : <AlertTriangle className="h-4 w-4 text-warning shrink-0 mt-0.5" />
                              }
                              <span className={b.severity === 'blocking' ? 'text-destructive' : 'text-warning'}>
                                {b.detail}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* ── Liability Summary (global only — fix #2) ── */}
            <div className="grid gap-4 md:grid-cols-4">
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium flex items-center gap-1.5">
                    <DollarSign className="h-4 w-4 text-muted-foreground" /> Cash Reserve
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-2xl font-bold">{fmt(activeData.liability.cashReserve)}</p>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium">Total Pending</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-2xl font-bold">{fmt(activeData.liability.totalPending)}</p>
                  <p className="text-xs text-muted-foreground">{fmt(activeData.liability.approvedUnpaid)} approved unpaid</p>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium">Opening Soon (7d)</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-2xl font-bold">{activeData.liability.openingSoonCount}</p>
                  <p className="text-xs text-muted-foreground">{fmt(activeData.liability.openingSoonLiability)} est.</p>
                </CardContent>
              </Card>
              <Card className={activeData.liability.netBuffer !== null && activeData.liability.netBuffer <= 0 ? 'border-destructive/50' : ''}>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium">Net Buffer (Global)</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className={`text-2xl font-bold ${activeData.liability.netBuffer !== null && activeData.liability.netBuffer <= 0 ? 'text-destructive' : ''}`}>
                    {activeData.liability.netBuffer !== null ? fmt(activeData.liability.netBuffer) : '—'}
                  </p>
                </CardContent>
              </Card>
            </div>

            {/* ── Drilldown Tabs ── */}
            <Tabs defaultValue="tiers">
              <TabsList>
                <TabsTrigger value="tiers">Tier Flip Safety</TabsTrigger>
                <TabsTrigger value="cohorts">Cohort Exposure</TabsTrigger>
                <TabsTrigger value="audit">Audit & Recon</TabsTrigger>
              </TabsList>

              {/* Tiers */}
              <TabsContent value="tiers" className="space-y-3 mt-4">
                {activeData.tiers.map(t => (
                  <Card key={t.id} className={!t.isLive ? 'opacity-60' : ''}>
                    <CardHeader className="pb-2">
                      <div className="flex items-center justify-between">
                        <CardTitle className="text-sm font-medium">{t.name}</CardTitle>
                        <div className="flex gap-2">
                          <Badge variant={t.isLive ? 'default' : 'secondary'}>
                            {t.isLive ? 'Live' : 'Upcoming'}
                          </Badge>
                          {!t.isLive && t.configLiveReady && (
                            <Badge variant="outline" className="text-warning border-warning/30 bg-warning/10">
                              Config Ready
                            </Badge>
                          )}
                          <Badge variant="outline">${t.entryFee}</Badge>
                        </div>
                      </div>
                    </CardHeader>
                    <CardContent>
                      <div className="grid gap-2 sm:grid-cols-2">
                        {Object.entries(t.checks).map(([key, check]) => (
                          <div key={key} className="flex items-start gap-2 text-sm">
                            <CheckIcon ok={check.ok} unavailable={check.verifyUnavailable} />
                            <div>
                              <span className="font-medium">{CHECK_LABELS[key] || key}</span>
                              <p className="text-xs text-muted-foreground">{check.detail}</p>
                            </div>
                          </div>
                        ))}
                      </div>
                      {!t.isLive && t.configLiveReady && (
                        <div className="flex items-center gap-2 mt-3 text-xs text-warning bg-warning/10 rounded px-2 py-1.5">
                          <Info className="h-3.5 w-3.5 shrink-0" />
                          Stripe config is valid — ensure create-checkout-session blocks with TIER_NOT_LIVE
                        </div>
                      )}
                    </CardContent>
                  </Card>
                ))}
              </TabsContent>

              {/* Cohorts — exposure breakdown only (fix #2/#3) */}
              <TabsContent value="cohorts" className="space-y-3 mt-4">
                <div className="flex items-center gap-2 text-sm text-muted-foreground bg-muted/50 rounded-lg px-4 py-2.5">
                  <Info className="h-4 w-4 shrink-0" />
                  Per-cohort exposure breakdown. Net buffer is calculated globally (see summary above).
                </div>
                {activeData.cohorts.length === 0 ? (
                  <Alert>
                    <AlertTriangle className="h-4 w-4" />
                    <AlertTitle>No Active Cohorts</AlertTitle>
                    <AlertDescription>No active cohorts found. Create cohorts before selling.</AlertDescription>
                  </Alert>
                ) : activeData.cohorts.map(c => (
                  <Card key={c.id}>
                    <CardHeader className="pb-2">
                      <div className="flex items-center justify-between">
                        <CardTitle className="text-sm font-medium">{c.name}</CardTitle>
                        <Badge variant="outline">{fmt(c.total_exposure)} exposure</Badge>
                      </div>
                    </CardHeader>
                    <CardContent>
                      <div className="grid gap-3 sm:grid-cols-4 text-sm">
                        <div>
                          <p className="text-xs text-muted-foreground">Pending</p>
                          <p className="font-medium">{c.pending_count} ({fmt(c.pending_amount)})</p>
                        </div>
                        <div>
                          <p className="text-xs text-muted-foreground">Approved Unpaid</p>
                          <p className="font-medium">{c.approved_count} ({fmt(c.approved_unpaid)})</p>
                        </div>
                        <div>
                          <p className="text-xs text-muted-foreground">Total Exposure</p>
                          <p className="font-medium">{fmt(c.total_exposure)}</p>
                        </div>
                        <div>
                          <p className="text-xs text-muted-foreground">Tier</p>
                          <p className="font-medium">{c.tier_id || 'unlinked'}</p>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </TabsContent>

              {/* Audit */}
              <TabsContent value="audit" className="space-y-3 mt-4">
                <Card className={!activeData.audits.ok ? 'border-destructive/30' : ''}>
                  <CardHeader className="pb-2">
                    <div className="flex items-center justify-between">
                      <CardTitle className="text-sm font-medium flex items-center gap-2">
                        <FileText className="h-4 w-4" /> Audit Health
                      </CardTitle>
                      <CheckIcon ok={activeData.audits.ok} />
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="grid gap-3 sm:grid-cols-2 text-sm">
                      <div className="flex items-center gap-2">
                        <Clock className="h-4 w-4 text-muted-foreground" />
                        <div>
                          <p className="text-xs text-muted-foreground">Last Risk Snapshot</p>
                          <p className="font-medium">
                            {activeData.audits.lastSnapshotAt
                              ? `${formatDistanceToNow(new Date(activeData.audits.lastSnapshotAt), { addSuffix: true })} (${activeData.audits.snapshotAgeHours}h)`
                              : 'Never'}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Clock className="h-4 w-4 text-muted-foreground" />
                        <div>
                          <p className="text-xs text-muted-foreground">Last Reconciliation</p>
                          <p className="font-medium">
                            {activeData.audits.lastReconAt
                              ? `${formatDistanceToNow(new Date(activeData.audits.lastReconAt), { addSuffix: true })} (${activeData.audits.reconAgeHours}h)`
                              : 'Never'}
                          </p>
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 text-sm">
                      <CheckIcon ok={activeData.audits.failuresLast24h === 0} />
                      <span>
                        {activeData.audits.failuresLast24h === 0
                          ? 'No failed audits in 24h'
                          : `${activeData.audits.failuresLast24h} failed audit(s) in 24h`}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground">{activeData.audits.detail}</p>

                    <div className="flex gap-2 pt-2 border-t">
                      <Button asChild variant="outline" size="sm">
                        <a href="/admin/liability" className="gap-1.5">
                          <ExternalLink className="h-3 w-3" /> Liability Dashboard
                        </a>
                      </Button>
                      <Button asChild variant="outline" size="sm">
                        <a href="/admin/ops-metrics" className="gap-1.5">
                          <ExternalLink className="h-3 w-3" /> Morning Checks
                        </a>
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              </TabsContent>
            </Tabs>
          </>
        ) : null}
      </div>
    </DashboardLayout>
  );
}