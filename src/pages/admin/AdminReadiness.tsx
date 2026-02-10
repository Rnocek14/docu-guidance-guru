import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { DashboardLayout, adminNavItems } from '@/components/layout/DashboardLayout';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Skeleton } from '@/components/ui/skeleton';
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
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

interface CheckResult { ok: boolean; detail: string; verifyUnavailable?: boolean }

interface TierReadiness {
  id: string; name: string; isLive: boolean; entryFee: number;
  checks: { purchasable: CheckResult; stripeWired: CheckResult; cohortReady: CheckResult; serverGateOk: CheckResult };
}

interface CohortHealth {
  id: string; name: string; tier_id: string | null;
  cash_reserve: number; pending_liability: number; opening_soon_liability: number;
  net_buffer: number; ok: boolean; detail: string;
}

interface AuditHealth {
  ok: boolean; lastSnapshotAt: string | null; lastReconAt: string | null;
  snapshotAgeHours: number | null; reconAgeHours: number | null;
  failuresLast24h: number; detail: string;
}

interface Blocker { key: string; severity: 'warning' | 'blocking'; detail: string }

interface ReadinessResponse {
  checkedAt: string; deep: boolean; safeToSell: boolean;
  blockers: Blocker[]; tiers: TierReadiness[]; cohorts: CohortHealth[];
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

export default function AdminReadiness() {
  const [deep, setDeep] = useState(false);

  const { data, isLoading, error, refetch, isRefetching } = useQuery({
    queryKey: ['admin-readiness', deep],
    queryFn: async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Not authenticated');
      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/get-admin-readiness?deep=${deep ? '1' : '0'}`,
        { headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' } }
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      return res.json() as Promise<ReadinessResponse>;
    },
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

        {isLoading ? (
          <div className="flex items-center justify-center h-64">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : data ? (
          <>
            {/* ── Verdict Card ── */}
            <Card className={`border-2 ${data.safeToSell ? 'border-success/50 bg-success/5' : 'border-destructive/50 bg-destructive/5'}`}>
              <CardContent className="pt-6">
                <div className="flex items-start gap-4">
                  {data.safeToSell ? (
                    <ShieldCheck className="h-10 w-10 text-success shrink-0" />
                  ) : (
                    <ShieldX className="h-10 w-10 text-destructive shrink-0" />
                  )}
                  <div className="flex-1">
                    <div className="flex items-center gap-3">
                      <h3 className={`text-xl font-bold ${data.safeToSell ? 'text-success' : 'text-destructive'}`}>
                        {data.safeToSell ? 'SAFE TO SELL' : 'NOT SAFE TO SELL'}
                      </h3>
                      <Badge variant={data.safeToSell ? 'secondary' : 'destructive'}>
                        {data.deep ? 'Deep Verified' : 'Config Only'}
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">
                      Checked {formatDistanceToNow(new Date(data.checkedAt), { addSuffix: true })}
                    </p>

                    {/* Blockers */}
                    {data.blockers.length > 0 && (
                      <div className="mt-4 space-y-2">
                        <p className="text-sm font-medium">
                          {data.blockers.filter(b => b.severity === 'blocking').length} blocking issue{data.blockers.filter(b => b.severity === 'blocking').length !== 1 ? 's' : ''}
                          {data.blockers.filter(b => b.severity === 'warning').length > 0 && `, ${data.blockers.filter(b => b.severity === 'warning').length} warning(s)`}
                        </p>
                        <ul className="space-y-1.5">
                          {data.blockers.map(b => (
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

            {/* ── Liability Summary ── */}
            <div className="grid gap-4 md:grid-cols-4">
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium flex items-center gap-1.5">
                    <DollarSign className="h-4 w-4 text-muted-foreground" /> Cash Reserve
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-2xl font-bold">{fmt(data.liability.cashReserve)}</p>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium">Pending Liability</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-2xl font-bold">{fmt(data.liability.totalPending)}</p>
                  <p className="text-xs text-muted-foreground">{fmt(data.liability.approvedUnpaid)} approved unpaid</p>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium">Opening Soon (7d)</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-2xl font-bold">{data.liability.openingSoonCount}</p>
                  <p className="text-xs text-muted-foreground">{fmt(data.liability.openingSoonLiability)} est. liability</p>
                </CardContent>
              </Card>
              <Card className={data.liability.netBuffer !== null && data.liability.netBuffer <= 0 ? 'border-destructive/50' : ''}>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium">Net Buffer</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className={`text-2xl font-bold ${data.liability.netBuffer !== null && data.liability.netBuffer <= 0 ? 'text-destructive' : ''}`}>
                    {data.liability.netBuffer !== null ? fmt(data.liability.netBuffer) : '—'}
                  </p>
                </CardContent>
              </Card>
            </div>

            {/* ── Drilldown Tabs ── */}
            <Tabs defaultValue="tiers">
              <TabsList>
                <TabsTrigger value="tiers">Tier Flip Safety</TabsTrigger>
                <TabsTrigger value="cohorts">Cohort Health</TabsTrigger>
                <TabsTrigger value="audit">Audit & Recon</TabsTrigger>
              </TabsList>

              {/* Tiers */}
              <TabsContent value="tiers" className="space-y-3 mt-4">
                {data.tiers.map(t => (
                  <Card key={t.id} className={!t.isLive ? 'opacity-60' : ''}>
                    <CardHeader className="pb-2">
                      <div className="flex items-center justify-between">
                        <CardTitle className="text-sm font-medium">{t.name}</CardTitle>
                        <div className="flex gap-2">
                          <Badge variant={t.isLive ? 'default' : 'secondary'}>
                            {t.isLive ? 'Live' : 'Upcoming'}
                          </Badge>
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
                              <span className="font-medium">{key.replace(/([A-Z])/g, ' $1').trim()}</span>
                              <p className="text-xs text-muted-foreground">{check.detail}</p>
                            </div>
                          </div>
                        ))}
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </TabsContent>

              {/* Cohorts */}
              <TabsContent value="cohorts" className="space-y-3 mt-4">
                {data.cohorts.length === 0 ? (
                  <Alert>
                    <AlertTriangle className="h-4 w-4" />
                    <AlertTitle>No Active Cohorts</AlertTitle>
                    <AlertDescription>No active cohorts found. Create cohorts before selling.</AlertDescription>
                  </Alert>
                ) : data.cohorts.map(c => (
                  <Card key={c.id} className={!c.ok ? 'border-destructive/30' : ''}>
                    <CardHeader className="pb-2">
                      <div className="flex items-center justify-between">
                        <CardTitle className="text-sm font-medium">{c.name}</CardTitle>
                        <CheckIcon ok={c.ok} />
                      </div>
                    </CardHeader>
                    <CardContent>
                      <div className="grid gap-2 sm:grid-cols-3 text-sm">
                        <div>
                          <p className="text-xs text-muted-foreground">Reserve</p>
                          <p className="font-medium">{fmt(c.cash_reserve)}</p>
                        </div>
                        <div>
                          <p className="text-xs text-muted-foreground">Pending Liability</p>
                          <p className="font-medium">{fmt(c.pending_liability)}</p>
                        </div>
                        <div>
                          <p className="text-xs text-muted-foreground">Net Buffer</p>
                          <p className={`font-medium ${c.net_buffer < 0 ? 'text-destructive' : ''}`}>{fmt(c.net_buffer)}</p>
                        </div>
                      </div>
                      <p className="text-xs text-muted-foreground mt-2">{c.detail}</p>
                    </CardContent>
                  </Card>
                ))}
              </TabsContent>

              {/* Audit */}
              <TabsContent value="audit" className="space-y-3 mt-4">
                <Card className={!data.audits.ok ? 'border-destructive/30' : ''}>
                  <CardHeader className="pb-2">
                    <div className="flex items-center justify-between">
                      <CardTitle className="text-sm font-medium flex items-center gap-2">
                        <FileText className="h-4 w-4" /> Audit Health
                      </CardTitle>
                      <CheckIcon ok={data.audits.ok} />
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="grid gap-3 sm:grid-cols-2 text-sm">
                      <div className="flex items-center gap-2">
                        <Clock className="h-4 w-4 text-muted-foreground" />
                        <div>
                          <p className="text-xs text-muted-foreground">Last Risk Snapshot</p>
                          <p className="font-medium">
                            {data.audits.lastSnapshotAt
                              ? `${formatDistanceToNow(new Date(data.audits.lastSnapshotAt), { addSuffix: true })} (${data.audits.snapshotAgeHours}h)`
                              : 'Never'}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Clock className="h-4 w-4 text-muted-foreground" />
                        <div>
                          <p className="text-xs text-muted-foreground">Last Reconciliation</p>
                          <p className="font-medium">
                            {data.audits.lastReconAt
                              ? `${formatDistanceToNow(new Date(data.audits.lastReconAt), { addSuffix: true })} (${data.audits.reconAgeHours}h)`
                              : 'Never'}
                          </p>
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 text-sm">
                      <CheckIcon ok={data.audits.failuresLast24h === 0} />
                      <span>
                        {data.audits.failuresLast24h === 0
                          ? 'No failed audits in 24h'
                          : `${data.audits.failuresLast24h} failed audit(s) in 24h`}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground">{data.audits.detail}</p>

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