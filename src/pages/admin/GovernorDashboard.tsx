import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase, SUPABASE_FUNCTIONS_URL } from '@/integrations/supabase/client';
import { DashboardLayout, adminNavItems } from '@/components/layout/DashboardLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  ShieldCheck, ShieldX, AlertTriangle, CheckCircle2, XCircle,
  RefreshCw, Loader2, Activity, Cpu, TrendingUp, Lock, Unlock,
  Zap, Clock,
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { toast } from 'sonner';

interface DomainCheck { name: string; ok: boolean; detail: string }
interface DomainResult { safe: boolean; signal: string; checks: DomainCheck[] }
interface GovernorResult {
  verdict: 'safe' | 'not_safe' | 'error';
  capital: DomainResult;
  processor: DomainResult;
  cohort: DomainResult;
  riskEngine: DomainResult;
  blockers: { domain: string; detail: string }[];
  autoAction: string;
  autoActionDetail: string;
  certifiedAt: string;
}

interface CertHistory {
  id: string;
  certified_at: string;
  verdict: string;
  capital_safe: boolean;
  processor_safe: boolean;
  cohort_safe: boolean;
  risk_engine_safe: boolean;
  auto_action: string;
  auto_action_detail: string;
}

function fmt(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
}

const DOMAIN_META: Record<string, { icon: typeof ShieldCheck; label: string; color: string }> = {
  capital: { icon: TrendingUp, label: 'Capital Safety', color: 'text-chart-1' },
  processor: { icon: Zap, label: 'Processor Safety', color: 'text-chart-2' },
  cohort: { icon: Activity, label: 'Cohort Profitability', color: 'text-chart-3' },
  riskEngine: { icon: Cpu, label: 'Risk Engine Integrity', color: 'text-chart-4' },
};

function DomainCard({ domainKey, domain }: { domainKey: string; domain: DomainResult }) {
  const meta = DOMAIN_META[domainKey];
  const Icon = meta.icon;

  return (
    <Card className={`border ${domain.safe ? 'border-success/30' : 'border-destructive/30'}`}>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Icon className={`h-4 w-4 ${meta.color}`} />
            {meta.label}
          </CardTitle>
          <Badge variant={domain.safe ? 'default' : 'destructive'} className={domain.safe ? 'bg-success text-success-foreground' : ''}>
            {domain.safe ? 'SAFE' : 'UNSAFE'}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {domain.checks.map((c, i) => (
          <div key={i} className="flex items-start gap-2 text-sm">
            {c.ok
              ? <CheckCircle2 className="h-4 w-4 text-success shrink-0 mt-0.5" />
              : <XCircle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />}
            <div className="min-w-0">
              <span className="font-medium">{c.name}</span>
              <p className="text-xs text-muted-foreground truncate">{c.detail}</p>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

export default function GovernorDashboard() {
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

  const { data, isLoading, error, refetch, isRefetching } = useQuery({
    queryKey: ['system-governor'],
    queryFn: fetchGovernor,
    refetchInterval: 60_000, // auto-refresh every minute
  });

  // Certification history
  const { data: history } = useQuery({
    queryKey: ['governor-history'],
    queryFn: async () => {
      const { data } = await supabase
        .from('governor_certifications')
        .select('id, certified_at, verdict, capital_safe, processor_safe, cohort_safe, risk_engine_safe, auto_action, auto_action_detail')
        .order('certified_at', { ascending: false })
        .limit(20);
      return (data || []) as CertHistory[];
    },
    refetchInterval: 60_000,
  });

  // Manual run
  const runMutation = useMutation({
    mutationFn: fetchGovernor,
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['system-governor'] });
      queryClient.invalidateQueries({ queryKey: ['governor-history'] });
      toast.success(`Governor: ${result.verdict.toUpperCase()} — ${result.autoActionDetail}`);
    },
    onError: (err) => toast.error(`Governor error: ${(err as Error).message}`),
  });

  return (
    <DashboardLayout title="System Governor" navItems={adminNavItems}>
      <div className="space-y-6 max-w-6xl">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <Cpu className="h-6 w-6" /> System Governor
            </h2>
            <p className="text-muted-foreground text-sm">
              Autonomous capital flight computer. Auto-certifies or auto-locks every 5 minutes.
            </p>
          </div>
          <Button
            onClick={() => runMutation.mutate()}
            disabled={runMutation.isPending || isRefetching}
          >
            <RefreshCw className={`h-4 w-4 mr-1.5 ${runMutation.isPending ? 'animate-spin' : ''}`} />
            Run Now
          </Button>
        </div>

        {error && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>{(error as Error).message}</AlertDescription>
          </Alert>
        )}

        {isLoading ? (
          <div className="flex items-center justify-center h-64">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : data ? (
          <>
            {/* ── VERDICT BANNER ── */}
            <Card className={`border-2 ${data.verdict === 'safe' ? 'border-success/50 bg-success/5' : 'border-destructive/50 bg-destructive/5'}`}>
              <CardContent className="pt-6">
                <div className="flex items-start gap-4">
                  {data.verdict === 'safe' ? (
                    <ShieldCheck className="h-12 w-12 text-success shrink-0" />
                  ) : (
                    <ShieldX className="h-12 w-12 text-destructive shrink-0" />
                  )}
                  <div className="flex-1">
                    <div className="flex items-center gap-3 flex-wrap">
                      <h3 className={`text-2xl font-black ${data.verdict === 'safe' ? 'text-success' : 'text-destructive'}`}>
                        {data.verdict === 'safe' ? 'SAFE' : 'NOT SAFE'}
                      </h3>
                      <div className="flex gap-2">
                        {(['capital', 'processor', 'cohort', 'riskEngine'] as const).map(d => {
                          const domain = data[d];
                          const meta = DOMAIN_META[d];
                          return (
                            <Badge
                              key={d}
                              variant={domain.safe ? 'outline' : 'destructive'}
                              className={domain.safe ? 'border-success/50 text-success' : ''}
                            >
                              {meta.label.split(' ')[0]}
                            </Badge>
                          );
                        })}
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">
                      Certified {formatDistanceToNow(new Date(data.certifiedAt), { addSuffix: true })}
                    </p>

                    {/* Auto-action indicator */}
                    {data.autoAction !== 'none' && (
                      <div className={`flex items-center gap-2 mt-3 text-sm font-medium ${
                        data.autoAction === 'locked' ? 'text-destructive' : 'text-success'
                      }`}>
                        {data.autoAction === 'locked' ? <Lock className="h-4 w-4" /> : <Unlock className="h-4 w-4" />}
                        {data.autoActionDetail}
                      </div>
                    )}

                    {/* Blockers */}
                    {data.blockers.length > 0 && (
                      <div className="mt-4 space-y-1.5">
                        <p className="text-sm font-medium">{data.blockers.length} blocking issue(s)</p>
                        {data.blockers.map((b, i) => (
                          <div key={i} className="flex items-start gap-2 text-sm">
                            <XCircle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
                            <span className="text-destructive">
                              <span className="font-medium">[{b.domain}]</span> {b.detail}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* ── 4 DOMAIN CARDS ── */}
            <div className="grid gap-4 md:grid-cols-2">
              <DomainCard domainKey="capital" domain={data.capital} />
              <DomainCard domainKey="processor" domain={data.processor} />
              <DomainCard domainKey="cohort" domain={data.cohort} />
              <DomainCard domainKey="riskEngine" domain={data.riskEngine} />
            </div>

            {/* ── CERTIFICATION HISTORY ── */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium flex items-center gap-2">
                  <Clock className="h-4 w-4" /> Certification History
                </CardTitle>
              </CardHeader>
              <CardContent>
                {(!history || history.length === 0) ? (
                  <p className="text-sm text-muted-foreground">No certifications yet. Run the governor to generate the first one.</p>
                ) : (
                  <div className="space-y-1 max-h-80 overflow-y-auto">
                    {history.map(h => (
                      <div key={h.id} className="flex items-center gap-3 text-sm py-1.5 border-b border-border/50 last:border-0">
                        {h.verdict === 'safe'
                          ? <CheckCircle2 className="h-4 w-4 text-success shrink-0" />
                          : <XCircle className="h-4 w-4 text-destructive shrink-0" />}
                        <span className={`font-medium ${h.verdict === 'safe' ? 'text-success' : 'text-destructive'}`}>
                          {h.verdict.toUpperCase()}
                        </span>
                        <div className="flex gap-1">
                          <span className={h.capital_safe ? 'text-success' : 'text-destructive'}>C</span>
                          <span className={h.processor_safe ? 'text-success' : 'text-destructive'}>P</span>
                          <span className={h.cohort_safe ? 'text-success' : 'text-destructive'}>Co</span>
                          <span className={h.risk_engine_safe ? 'text-success' : 'text-destructive'}>R</span>
                        </div>
                        {h.auto_action && h.auto_action !== 'none' && (
                          <Badge variant="outline" className="text-xs">
                            {h.auto_action}
                          </Badge>
                        )}
                        <span className="text-xs text-muted-foreground ml-auto">
                          {formatDistanceToNow(new Date(h.certified_at), { addSuffix: true })}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </>
        ) : null}
      </div>
    </DashboardLayout>
  );
}
