import { useState, useCallback, useMemo } from 'react';
import { DashboardLayout, adminNavItems } from '@/components/layout/DashboardLayout';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
  ResponsiveContainer, ReferenceLine, Area, AreaChart, Line,
} from 'recharts';
import { ChartContainer, ChartTooltip, ChartTooltipContent, ChartConfig } from '@/components/ui/chart';
import {
  TrendingUp, TrendingDown, AlertTriangle, Shield, Zap, Info, Play,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { supabase } from '@/integrations/supabase/client';
import { SimulationControls, type SimOverrides } from '@/components/admin/SimulationControls';
import { RiskReportTab } from '@/components/admin/RiskReportTab';
import { CustomerGrowthTab } from '@/components/admin/CustomerGrowthTab';

// ─── Types ────────────────────────────────────────────────────────────────────

interface ServerSimResult {
  run_id: string | null;
  duration_ms: number;
  assumptions_source: string;
  cohorts_used: { id: string; name: string; phase: string }[];
  results: {
    profit: { mean: number; p5: number; p50: number; p95: number; stdDev: number };
    risk: { probabilityOfLoss: number; maxDrawdown: number; worstMonth: number; bestMonth: number; consecutiveLossMonths: number };
    reserve: { breachProbability: number; threshold: number };
    annual: { p5: number; p50: number; p95: number; lossProb: number; mean: number };
    monthlyBands: { p5: number; p50: number; p95: number; mean: number }[];
    cohortBands?: { totalAccounts: number; eligible: number; firstPayout: number; capHits: number }[];
    histogram: { bucket: number; count: number }[];
    diagnostics: { avgPayoutsPerAccount: number; lifetimeCapHitRate: number };
  };
}

interface SavedComparison {
  label: string;
  overrides: SimOverrides;
  result: ServerSimResult;
}

// ─── Chart configs ────────────────────────────────────────────────────────────

const bandChartConfig: ChartConfig = {
  p5: { label: 'P5 (Worst)', color: 'hsl(var(--destructive))' },
  p50: { label: 'P50 (Median)', color: 'hsl(var(--chart-1))' },
  p95: { label: 'P95 (Best)', color: 'hsl(var(--chart-3))' },
  prev_p50: { label: 'Prev P50', color: 'hsl(var(--muted-foreground))' },
};

const histogramConfig: ChartConfig = {
  count: { label: 'Iterations', color: 'hsl(var(--chart-1))' },
  prev_count: { label: 'Previous', color: 'hsl(var(--muted-foreground))' },
};

// ─── Verdict helper ───────────────────────────────────────────────────────────

function getVerdict(r: ServerSimResult['results']) {
  const checks = [
    { label: 'Annual profit positive', pass: r.annual.mean > 0 },
    { label: 'Annual loss prob < 10%', pass: r.annual.lossProb < 0.1 },
    { label: 'Reserve breach < 10%', pass: r.reserve.breachProbability < 0.1 },
    { label: 'Worst month > -$50k', pass: r.risk.worstMonth > -50000 },
  ];
  const passed = checks.filter(c => c.pass).length;
  const score = Math.round((passed / checks.length) * 100);
  return { score, checks };
}

// ─── Default overrides ────────────────────────────────────────────────────────

const DEFAULT_OVERRIDES: SimOverrides = {
  accountsPerMonth: 150,
  fixedMonthlyCosts: 6000,
  entryFee: 149,
  resetFee: 99,
  horizon: 12,
  attackIntensity: 0,
  iterations: 2000,
  reserveThreshold: 16000,
};

// ─── Component ────────────────────────────────────────────────────────────────

export default function MonteCarloAnalytics() {
  const [isRunning, setIsRunning] = useState(false);
  const [result, setResult] = useState<ServerSimResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [overrides, setOverrides] = useState<SimOverrides>(DEFAULT_OVERRIDES);
  const [comparison, setComparison] = useState<SavedComparison | null>(null);

  const runServerSimulation = useCallback(async () => {
    setIsRunning(true);
    setError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Not authenticated');

      const response = await fetch(
        `https://sfxmgwkrjwuerfkqxokq.supabase.co/functions/v1/run-simulation`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({
            iterations: overrides.iterations,
            months: overrides.horizon,
            seed: 42,
            reserve_threshold: overrides.reserveThreshold,
            overrides: {
              accountsPerMonth: overrides.accountsPerMonth,
              fixedMonthlyCosts: overrides.fixedMonthlyCosts,
              pricePerAccount: overrides.entryFee,
              knobs: {
                resetPrice: overrides.resetFee,
                attackIntensity: overrides.attackIntensity,
              },
            },
          }),
        }
      );

      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Simulation failed');
      setResult(data as ServerSimResult);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsRunning(false);
    }
  }, [overrides]);

  const handleSaveComparison = useCallback(() => {
    if (!result) return;
    setComparison({
      label: `${overrides.accountsPerMonth} accts, $${(overrides.fixedMonthlyCosts / 1000).toFixed(0)}k costs`,
      overrides: { ...overrides },
      result,
    });
  }, [result, overrides]);

  const verdict = useMemo(() => result ? getVerdict(result.results) : null, [result]);
  const fmt = (v: number) => '$' + v.toLocaleString(undefined, { maximumFractionDigits: 0 });
  const pct = (v: number) => (v * 100).toFixed(1) + '%';

  // Merge band data for comparison overlay
  const bandData = useMemo(() => {
    if (!result) return [];
    return result.results.monthlyBands.map((b, i) => ({
      month: i + 1,
      ...b,
      ...(comparison ? {
        prev_p5: comparison.result.results.monthlyBands[i]?.p5,
        prev_p50: comparison.result.results.monthlyBands[i]?.p50,
        prev_p95: comparison.result.results.monthlyBands[i]?.p95,
      } : {}),
    }));
  }, [result, comparison]);

  // Merge histogram data for comparison overlay
  const histogramData = useMemo(() => {
    if (!result) return [];
    if (!comparison) return result.results.histogram;
    const map = new Map<number, { bucket: number; count: number; prev_count: number }>();
    for (const h of result.results.histogram) {
      map.set(h.bucket, { ...h, prev_count: 0 });
    }
    for (const h of comparison.result.results.histogram) {
      const existing = map.get(h.bucket);
      if (existing) existing.prev_count = h.count;
      else map.set(h.bucket, { bucket: h.bucket, count: 0, prev_count: h.count });
    }
    return Array.from(map.values()).sort((a, b) => a.bucket - b.bucket);
  }, [result, comparison]);

  return (
    <DashboardLayout title="Monte Carlo Analytics" navItems={adminNavItems}>
      <div className="space-y-6">
        {/* Header */}
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Economic Simulation</h2>
          <p className="text-muted-foreground">
            Server-side Monte Carlo using your live cohort rules. Results are persisted for audit.
          </p>
        </div>

        {/* Controls */}
        <SimulationControls
          overrides={overrides}
          onChange={setOverrides}
          onRun={runServerSimulation}
          onCompare={handleSaveComparison}
          isRunning={isRunning}
          hasResult={!!result}
          error={error}
        />

        {/* Comparison indicator */}
        {comparison && (
          <div className="flex items-center gap-2 rounded-lg border border-muted bg-muted/30 p-3 text-sm">
            <span className="text-muted-foreground">Comparing against:</span>
            <Badge variant="outline">{comparison.label}</Badge>
            <Button variant="ghost" size="sm" onClick={() => setComparison(null)}>Clear</Button>
          </div>
        )}

        {result ? (
          <>
            {/* Verdict Banner */}
            <Card className={
              verdict && verdict.score >= 75
                ? 'border-success/50 bg-success/5'
                : verdict && verdict.score >= 50
                  ? 'border-warning/50 bg-warning/5'
                  : 'border-destructive/50 bg-destructive/5'
            }>
              <CardContent className="pt-6">
                <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                  <div className="flex items-center gap-4">
                    <div className={`flex h-16 w-16 items-center justify-center rounded-full ${
                      verdict && verdict.score >= 75
                        ? 'bg-success/20 text-success'
                        : verdict && verdict.score >= 50
                          ? 'bg-warning/20 text-warning'
                          : 'bg-destructive/20 text-destructive'
                    }`}>
                      <span className="text-2xl font-bold">{verdict?.score}</span>
                    </div>
                    <div>
                      <h3 className="text-lg font-semibold">
                        {verdict && verdict.score >= 75 ? 'PROFITABLE' : verdict && verdict.score >= 50 ? 'MARGINAL' : 'UNPROFITABLE'}
                      </h3>
                      <p className="text-sm text-muted-foreground">
                        {overrides.iterations.toLocaleString()} iterations × {overrides.horizon} months
                        {' | '}{(overrides.accountsPerMonth * overrides.horizon).toLocaleString()} customers ({overrides.accountsPerMonth}/mo)
                        {' | '}live cohort rules
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {verdict?.checks.map((c, i) => (
                      <Badge key={i} variant="outline" className={c.pass ? 'border-success/50 text-success' : 'border-destructive/50 text-destructive'}>
                        {c.pass ? '✓' : '✗'} {c.label}
                      </Badge>
                    ))}
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Key Metrics Grid */}
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-5">
              <MetricCard
                title={`${overrides.horizon}-Mo Profit`}
                value={fmt(result.results.annual.mean)}
                positive={result.results.annual.mean >= 0}
                icon={result.results.annual.mean >= 0 ? <TrendingUp className="h-4 w-4 text-success" /> : <TrendingDown className="h-4 w-4 text-destructive" />}
                detail={`P5: ${fmt(result.results.annual.p5)} / P95: ${fmt(result.results.annual.p95)}`}
              />
              <MetricCard
                title="Monthly Profit (avg)"
                value={fmt(result.results.profit.mean)}
                positive={result.results.profit.mean >= 0}
                detail={`P5: ${fmt(result.results.profit.p5)} / P95: ${fmt(result.results.profit.p95)}`}
              />
              <MetricCard
                title="Annual Loss Prob"
                value={pct(result.results.annual.lossProb)}
                icon={<AlertTriangle className={`h-4 w-4 ${result.results.annual.lossProb > 0.1 ? 'text-destructive' : 'text-muted-foreground'}`} />}
                detail={`Monthly loss: ${pct(result.results.risk.probabilityOfLoss)}`}
              />
              <MetricCard
                title="Reserve Breach"
                value={pct(result.results.reserve.breachProbability)}
                positive={result.results.reserve.breachProbability <= 0.1}
                icon={<Shield className={`h-4 w-4 ${result.results.reserve.breachProbability > 0.1 ? 'text-destructive' : 'text-success'}`} />}
                detail={`Threshold: ${fmt(result.results.reserve.threshold)}`}
              />
              <MetricCard
                title="Worst Month"
                value={fmt(result.results.risk.worstMonth)}
                positive={false}
                detail={`Best: ${fmt(result.results.risk.bestMonth)}`}
              />
            </div>

            {/* Charts */}
            <Tabs defaultValue="bands" className="space-y-4">
              <TabsList>
                <TabsTrigger value="bands">Monthly Bands</TabsTrigger>
                <TabsTrigger value="customers">Customers</TabsTrigger>
                <TabsTrigger value="histogram">Profit Distribution</TabsTrigger>
                <TabsTrigger value="risk">Risk Report</TabsTrigger>
                <TabsTrigger value="diagnostics">Diagnostics</TabsTrigger>
              </TabsList>

              <TabsContent value="bands">
                <Card>
                  <CardHeader>
                    <CardTitle>Monthly Profit Bands (P5 / P50 / P95)</CardTitle>
                    <CardDescription>
                      Confidence bands across {overrides.iterations.toLocaleString()} iterations
                      {comparison && ' — dashed lines show previous run'}
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <ChartContainer config={bandChartConfig} className="h-[350px]">
                      <ResponsiveContainer width="100%" height="100%">
                        <AreaChart data={bandData}>
                          <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                          <XAxis dataKey="month" tickFormatter={(v) => `M${v}`} className="text-xs" />
                          <YAxis tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`} className="text-xs" />
                          <ChartTooltip content={<ChartTooltipContent />} formatter={(value) => [fmt(Number(value)), '']} />
                          <ReferenceLine y={0} stroke="hsl(var(--muted-foreground))" strokeDasharray="5 5" />
                          <Area type="monotone" dataKey="p95" stroke="hsl(var(--chart-3))" fill="hsl(var(--chart-3))" fillOpacity={0.15} />
                          <Area type="monotone" dataKey="p50" stroke="hsl(var(--chart-1))" fill="hsl(var(--chart-1))" fillOpacity={0.25} />
                          <Area type="monotone" dataKey="p5" stroke="hsl(var(--destructive))" fill="hsl(var(--destructive))" fillOpacity={0.15} />
                          {comparison && (
                            <Line type="monotone" dataKey="prev_p50" stroke="hsl(var(--muted-foreground))" strokeDasharray="6 3" dot={false} />
                          )}
                        </AreaChart>
                      </ResponsiveContainer>
                    </ChartContainer>
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="customers">
                {result.results.cohortBands ? (
                  <CustomerGrowthTab
                    cohortBands={result.results.cohortBands}
                    accountsPerMonth={overrides.accountsPerMonth}
                    horizon={overrides.horizon}
                  />
                ) : (
                  <Card>
                    <CardContent className="py-8 text-center text-muted-foreground">
                      Re-run the simulation to see customer growth data (requires updated edge function).
                    </CardContent>
                  </Card>
                )}
              </TabsContent>

              <TabsContent value="histogram">
                <Card>
                  <CardHeader>
                    <CardTitle>{overrides.horizon}-Month Cumulative Profit Distribution</CardTitle>
                    <CardDescription>How many iterations ended at each profit level</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <ChartContainer config={histogramConfig} className="h-[300px]">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={histogramData}>
                          <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                          <XAxis dataKey="bucket" tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`} className="text-xs" />
                          <YAxis className="text-xs" />
                          <ChartTooltip content={<ChartTooltipContent />} formatter={(value, _name, props) => [`${value} iterations`, `${fmt(props.payload.bucket)}`]} />
                          <ReferenceLine x={0} stroke="hsl(var(--muted-foreground))" strokeDasharray="5 5" />
                          <Bar dataKey="count" fill="hsl(var(--chart-1))" radius={[4, 4, 0, 0]} />
                          {comparison && (
                            <Bar dataKey="prev_count" fill="hsl(var(--muted-foreground))" radius={[4, 4, 0, 0]} fillOpacity={0.4} />
                          )}
                        </BarChart>
                      </ResponsiveContainer>
                    </ChartContainer>
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="risk">
                <RiskReportTab results={result.results} overrides={overrides} />
              </TabsContent>

              <TabsContent value="diagnostics">
                <div className="grid gap-4 lg:grid-cols-2">
                  <Card>
                    <CardHeader><CardTitle>Simulation Diagnostics</CardTitle></CardHeader>
                    <CardContent>
                      <div className="space-y-3">
                        {[
                          ['Total Customers Simulated', (overrides.accountsPerMonth * overrides.horizon).toLocaleString()],
                          ['Peak Eligible Pool', result.results.cohortBands ? Math.max(...result.results.cohortBands.map(b => b.eligible)).toLocaleString() : 'n/a'],
                          ['Avg Payouts / Account', result.results.diagnostics.avgPayoutsPerAccount.toFixed(3)],
                          ['Lifetime Cap Hit Rate', pct(result.results.diagnostics.lifetimeCapHitRate)],
                          ['Max Drawdown (tail)', fmt(result.results.risk.maxDrawdown)],
                          ['Consecutive Loss Months', result.results.risk.consecutiveLossMonths.toString()],
                          ['Std Deviation (monthly)', fmt(result.results.profit.stdDev)],
                        ].map(([label, value]) => (
                          <div key={label} className="flex justify-between border-b pb-2 last:border-0">
                            <span className="text-muted-foreground">{label}</span>
                            <span className="font-medium">{value}</span>
                          </div>
                        ))}
                      </div>
                    </CardContent>
                  </Card>

                  <Card>
                    <CardHeader><CardTitle>Cohorts Used</CardTitle></CardHeader>
                    <CardContent>
                      <div className="space-y-3">
                        {result.cohorts_used.map(c => (
                          <div key={c.id} className="flex items-center justify-between border-b pb-2 last:border-0">
                            <span className="font-medium">{c.name}</span>
                            <Badge variant="secondary">{c.phase}</Badge>
                          </div>
                        ))}
                        <div className="flex justify-between border-b pb-2">
                          <span className="text-muted-foreground">Source</span>
                          <Badge variant="outline">{result.assumptions_source}</Badge>
                        </div>
                        <div className="flex justify-between border-b pb-2">
                          <span className="text-muted-foreground">Duration</span>
                          <span className="font-medium">{(result.duration_ms / 1000).toFixed(1)}s</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Run ID</span>
                          <span className="font-mono text-xs">{result.run_id?.slice(0, 8) ?? 'n/a'}</span>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                </div>

                <div className="mt-4 flex items-start gap-2 rounded-lg border border-muted bg-muted/30 p-4 text-sm text-muted-foreground">
                  <Info className="mt-0.5 h-4 w-4 shrink-0" />
                  <div>
                    <strong>Note on Max Drawdown:</strong> The {fmt(result.results.risk.maxDrawdown)} figure is the worst
                    cumulative peak-to-trough across all {overrides.iterations.toLocaleString()} iterations — a statistical tail extreme,
                    not a realistic single-month loss. The operationally relevant risk metric is <strong>Worst Month ({fmt(result.results.risk.worstMonth)})</strong>.
                  </div>
                </div>
              </TabsContent>
            </Tabs>
          </>
        ) : (
          <Card className="border-dashed">
            <CardContent className="flex flex-col items-center justify-center py-16">
              <Zap className="h-12 w-12 text-muted-foreground mb-4" />
              <h3 className="text-lg font-medium mb-2">No Simulation Data</h3>
              <p className="text-muted-foreground text-center mb-4">
                Run a simulation to see profit forecasts, risk metrics, and monthly bands — all derived from your live cohort rules.
              </p>
              <Button onClick={runServerSimulation} disabled={isRunning} size="lg">
                <Play className="mr-2 h-4 w-4" />
                Run Simulation
              </Button>
            </CardContent>
          </Card>
        )}
      </div>
    </DashboardLayout>
  );
}

// ─── Reusable metric card ─────────────────────────────────────────────────────

function MetricCard({ title, value, positive, icon, detail }: {
  title: string; value: string; positive?: boolean; icon?: React.ReactNode; detail: string;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
        {icon}
      </CardHeader>
      <CardContent>
        <div className={`text-2xl font-bold ${positive === true ? 'text-success' : positive === false ? 'text-destructive' : ''}`}>
          {value}
        </div>
        <p className="text-xs text-muted-foreground">{detail}</p>
      </CardContent>
    </Card>
  );
}
