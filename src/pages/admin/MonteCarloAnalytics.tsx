import { useState, useCallback, useMemo } from 'react';
import { DashboardLayout, adminNavItems } from '@/components/layout/DashboardLayout';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Slider } from '@/components/ui/slider';
import { Label } from '@/components/ui/label';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
  ResponsiveContainer, ReferenceLine, Area, AreaChart,
} from 'recharts';
import { ChartContainer, ChartTooltip, ChartTooltipContent, ChartConfig } from '@/components/ui/chart';
import {
  Play, RefreshCw, TrendingUp, TrendingDown, AlertTriangle,
  Shield, Server, Zap, Info,
} from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';

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
    histogram: { bucket: number; count: number }[];
    diagnostics: { avgPayoutsPerAccount: number; lifetimeCapHitRate: number };
  };
}

// ─── Chart configs ────────────────────────────────────────────────────────────

const bandChartConfig: ChartConfig = {
  p5: { label: 'P5 (Worst)', color: 'hsl(var(--destructive))' },
  p50: { label: 'P50 (Median)', color: 'hsl(var(--chart-1))' },
  p95: { label: 'P95 (Best)', color: 'hsl(var(--chart-3))' },
};

const histogramConfig: ChartConfig = {
  count: { label: 'Iterations', color: 'hsl(var(--chart-1))' },
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

// ─── Component ────────────────────────────────────────────────────────────────

export default function MonteCarloAnalytics() {
  const [isRunning, setIsRunning] = useState(false);
  const [result, setResult] = useState<ServerSimResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [iterations, setIterations] = useState([2000]);
  const [reserveThreshold, setReserveThreshold] = useState([16000]);

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
            iterations: iterations[0],
            months: 12,
            seed: 42,
            reserve_threshold: reserveThreshold[0],
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
  }, [iterations, reserveThreshold]);

  const verdict = useMemo(() => result ? getVerdict(result.results) : null, [result]);

  const fmt = (v: number) => '$' + v.toLocaleString(undefined, { maximumFractionDigits: 0 });
  const pct = (v: number) => (v * 100).toFixed(1) + '%';

  return (
    <DashboardLayout title="Monte Carlo Analytics" navItems={adminNavItems}>
      <div className="space-y-6">
        {/* Header + Controls */}
        <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
          <div>
            <h2 className="text-2xl font-bold tracking-tight">Economic Simulation</h2>
            <p className="text-muted-foreground">
              Server-side Monte Carlo using your live cohort rules. Results are persisted for audit.
            </p>
          </div>
          <Button onClick={runServerSimulation} disabled={isRunning} size="lg">
            {isRunning ? (
              <><RefreshCw className="mr-2 h-4 w-4 animate-spin" />Running ({iterations[0].toLocaleString()} iterations)...</>
            ) : (
              <><Play className="mr-2 h-4 w-4" />Run Simulation</>
            )}
          </Button>
        </div>

        {/* Parameter Controls */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Server className="h-5 w-5 text-muted-foreground" />
              <CardTitle className="text-lg">Simulation Parameters</CardTitle>
            </div>
            <CardDescription>
              Uses real cohort configs from your database — evaluation, verification &amp; performance phases.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-6 md:grid-cols-2">
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <Label>Iterations</Label>
                  <span className="text-sm font-medium">{iterations[0].toLocaleString()}</span>
                </div>
                <Slider value={iterations} onValueChange={setIterations} min={500} max={5000} step={500} />
                <p className="text-xs text-muted-foreground">More iterations = more accurate tail risk estimates</p>
              </div>
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <Label>Reserve Threshold</Label>
                  <span className="text-sm font-medium">${reserveThreshold[0].toLocaleString()}</span>
                </div>
                <Slider value={reserveThreshold} onValueChange={setReserveThreshold} min={5000} max={50000} step={1000} />
                <p className="text-xs text-muted-foreground">Cash reserve level to test breach probability</p>
              </div>
            </div>
            {error && (
              <div className="mt-4 rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
                {error}
              </div>
            )}
          </CardContent>
        </Card>

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
                        Based on {iterations[0].toLocaleString()} iterations × 12 months using live cohort rules
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
              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">12-Month Profit</CardTitle>
                  {result.results.annual.mean >= 0 ? (
                    <TrendingUp className="h-4 w-4 text-success" />
                  ) : (
                    <TrendingDown className="h-4 w-4 text-destructive" />
                  )}
                </CardHeader>
                <CardContent>
                  <div className={`text-2xl font-bold ${result.results.annual.mean >= 0 ? 'text-success' : 'text-destructive'}`}>
                    {fmt(result.results.annual.mean)}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    P5: {fmt(result.results.annual.p5)} / P95: {fmt(result.results.annual.p95)}
                  </p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">Monthly Profit (avg)</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className={`text-2xl font-bold ${result.results.profit.mean >= 0 ? 'text-success' : 'text-destructive'}`}>
                    {fmt(result.results.profit.mean)}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    P5: {fmt(result.results.profit.p5)} / P95: {fmt(result.results.profit.p95)}
                  </p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">Annual Loss Prob</CardTitle>
                  <AlertTriangle className={`h-4 w-4 ${result.results.annual.lossProb > 0.1 ? 'text-destructive' : 'text-muted-foreground'}`} />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{pct(result.results.annual.lossProb)}</div>
                  <p className="text-xs text-muted-foreground">
                    Monthly loss: {pct(result.results.risk.probabilityOfLoss)}
                  </p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">Reserve Breach</CardTitle>
                  <Shield className={`h-4 w-4 ${result.results.reserve.breachProbability > 0.1 ? 'text-destructive' : 'text-success'}`} />
                </CardHeader>
                <CardContent>
                  <div className={`text-2xl font-bold ${result.results.reserve.breachProbability > 0.1 ? 'text-destructive' : 'text-success'}`}>
                    {pct(result.results.reserve.breachProbability)}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Threshold: {fmt(result.results.reserve.threshold)}
                  </p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">Worst Month</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold text-destructive">
                    {fmt(result.results.risk.worstMonth)}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Best: {fmt(result.results.risk.bestMonth)}
                  </p>
                </CardContent>
              </Card>
            </div>

            {/* Charts */}
            <Tabs defaultValue="bands" className="space-y-4">
              <TabsList>
                <TabsTrigger value="bands">Monthly Bands</TabsTrigger>
                <TabsTrigger value="histogram">Profit Distribution</TabsTrigger>
                <TabsTrigger value="diagnostics">Diagnostics</TabsTrigger>
              </TabsList>

              <TabsContent value="bands">
                <Card>
                  <CardHeader>
                    <CardTitle>Monthly Profit Bands (P5 / P50 / P95)</CardTitle>
                    <CardDescription>
                      Confidence bands across {iterations[0].toLocaleString()} iterations — shows margin compression over time
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <ChartContainer config={bandChartConfig} className="h-[350px]">
                      <ResponsiveContainer width="100%" height="100%">
                        <AreaChart data={result.results.monthlyBands.map((b, i) => ({ month: i + 1, ...b }))}>
                          <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                          <XAxis dataKey="month" tickFormatter={(v) => `M${v}`} className="text-xs" />
                          <YAxis tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`} className="text-xs" />
                          <ChartTooltip content={<ChartTooltipContent />} formatter={(value) => [fmt(Number(value)), '']} />
                          <ReferenceLine y={0} stroke="hsl(var(--muted-foreground))" strokeDasharray="5 5" />
                          <Area type="monotone" dataKey="p95" stroke="hsl(var(--chart-3))" fill="hsl(var(--chart-3))" fillOpacity={0.15} />
                          <Area type="monotone" dataKey="p50" stroke="hsl(var(--chart-1))" fill="hsl(var(--chart-1))" fillOpacity={0.25} />
                          <Area type="monotone" dataKey="p5" stroke="hsl(var(--destructive))" fill="hsl(var(--destructive))" fillOpacity={0.15} />
                        </AreaChart>
                      </ResponsiveContainer>
                    </ChartContainer>
                    <div className="mt-4 grid grid-cols-3 gap-4 text-center">
                      <div className="rounded-lg bg-muted p-3">
                        <div className="text-sm text-muted-foreground">Month 1 (median)</div>
                        <div className="text-lg font-semibold text-success">{fmt(result.results.monthlyBands[0]?.p50 ?? 0)}</div>
                      </div>
                      <div className="rounded-lg bg-muted p-3">
                        <div className="text-sm text-muted-foreground">Month 6 (median)</div>
                        <div className={`text-lg font-semibold ${(result.results.monthlyBands[5]?.p50 ?? 0) >= 0 ? 'text-success' : 'text-destructive'}`}>
                          {fmt(result.results.monthlyBands[5]?.p50 ?? 0)}
                        </div>
                      </div>
                      <div className="rounded-lg bg-muted p-3">
                        <div className="text-sm text-muted-foreground">Month 12 (median)</div>
                        <div className={`text-lg font-semibold ${(result.results.monthlyBands[11]?.p50 ?? 0) >= 0 ? 'text-success' : 'text-destructive'}`}>
                          {fmt(result.results.monthlyBands[11]?.p50 ?? 0)}
                        </div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="histogram">
                <Card>
                  <CardHeader>
                    <CardTitle>12-Month Cumulative Profit Distribution</CardTitle>
                    <CardDescription>
                      How many iterations ended at each profit level
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <ChartContainer config={histogramConfig} className="h-[300px]">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={result.results.histogram}>
                          <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                          <XAxis dataKey="bucket" tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`} className="text-xs" />
                          <YAxis className="text-xs" />
                          <ChartTooltip content={<ChartTooltipContent />} formatter={(value, _name, props) => [`${value} iterations`, `${fmt(props.payload.bucket)}`]} />
                          <ReferenceLine x={0} stroke="hsl(var(--muted-foreground))" strokeDasharray="5 5" />
                          <Bar dataKey="count" fill="hsl(var(--chart-1))" radius={[4, 4, 0, 0]} />
                        </BarChart>
                      </ResponsiveContainer>
                    </ChartContainer>
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="diagnostics">
                <div className="grid gap-4 lg:grid-cols-2">
                  <Card>
                    <CardHeader><CardTitle>Simulation Diagnostics</CardTitle></CardHeader>
                    <CardContent>
                      <div className="space-y-3">
                        {[
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
                    cumulative peak-to-trough across all {iterations[0].toLocaleString()} iterations — a statistical tail extreme,
                    not a realistic single-month loss. The operationally relevant risk metric is <strong>Worst Month ({fmt(result.results.risk.worstMonth)})</strong>.
                  </div>
                </div>
              </TabsContent>
            </Tabs>

            {/* Metadata */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Quick Scenario Reference</CardTitle>
                <CardDescription>Compare different cap configurations</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b">
                        <th className="py-2 text-left font-medium">Scenario</th>
                        <th className="py-2 text-right font-medium">Cap Amount</th>
                        <th className="py-2 text-right font-medium">Expected Margin</th>
                        <th className="py-2 text-right font-medium">Risk Level</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr className="border-b">
                        <td className="py-2">No Cap (Baseline)</td>
                        <td className="py-2 text-right">Unlimited</td>
                        <td className="py-2 text-right text-destructive">-33%</td>
                        <td className="py-2 text-right"><Badge variant="destructive">Critical</Badge></td>
                      </tr>
                      <tr className="border-b">
                        <td className="py-2">8× Cap</td>
                        <td className="py-2 text-right">$1,192</td>
                        <td className="py-2 text-right text-warning">~0%</td>
                        <td className="py-2 text-right"><Badge variant="secondary">Breakeven</Badge></td>
                      </tr>
                      <tr className="border-b bg-muted/50">
                        <td className="py-2 font-medium">7× Cap (Current)</td>
                        <td className="py-2 text-right font-medium">$1,043</td>
                        <td className="py-2 text-right font-medium text-success">+6.8%</td>
                        <td className="py-2 text-right"><Badge className="bg-success text-success-foreground">Safe</Badge></td>
                      </tr>
                      <tr>
                        <td className="py-2">5× Cap (Conservative)</td>
                        <td className="py-2 text-right">$745</td>
                        <td className="py-2 text-right text-success">+15%</td>
                        <td className="py-2 text-right"><Badge className="bg-success text-success-foreground">Very Safe</Badge></td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
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
