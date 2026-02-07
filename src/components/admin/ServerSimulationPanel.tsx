import { useState, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Slider } from '@/components/ui/slider';
import { Label } from '@/components/ui/label';
import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid,
  ResponsiveContainer, ReferenceLine, Area, AreaChart,
} from 'recharts';
import { ChartContainer, ChartTooltip, ChartTooltipContent, ChartConfig } from '@/components/ui/chart';
import {
  Play, RefreshCw, TrendingUp, TrendingDown, AlertTriangle, Shield, Server,
} from 'lucide-react';

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

const bandChartConfig: ChartConfig = {
  p5: { label: 'P5 (Worst)', color: 'hsl(var(--destructive))' },
  p50: { label: 'P50 (Median)', color: 'hsl(var(--chart-1))' },
  p95: { label: 'P95 (Best)', color: 'hsl(var(--chart-3))' },
};

const histogramConfig: ChartConfig = {
  count: { label: 'Iterations', color: 'hsl(var(--chart-1))' },
};

export function ServerSimulationPanel() {
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

  return (
    <div className="space-y-6">
      {/* Controls */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Server className="h-5 w-5 text-muted-foreground" />
            <CardTitle className="text-lg">Server-Side Simulation</CardTitle>
          </div>
          <CardDescription>
            Runs on real cohort configs from your database. Results are persisted for audit.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-6 md:grid-cols-3">
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Label>Iterations</Label>
                <span className="text-sm font-medium">{iterations[0].toLocaleString()}</span>
              </div>
              <Slider value={iterations} onValueChange={setIterations} min={500} max={5000} step={500} />
            </div>
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Label>Reserve Threshold</Label>
                <span className="text-sm font-medium">${reserveThreshold[0].toLocaleString()}</span>
              </div>
              <Slider value={reserveThreshold} onValueChange={setReserveThreshold} min={5000} max={50000} step={1000} />
            </div>
            <div className="flex items-end">
              <Button onClick={runServerSimulation} disabled={isRunning} className="w-full">
                {isRunning ? (
                  <><RefreshCw className="mr-2 h-4 w-4 animate-spin" />Running ({iterations[0]} iterations)...</>
                ) : (
                  <><Play className="mr-2 h-4 w-4" />Run Server Simulation</>
                )}
              </Button>
            </div>
          </div>
          {error && (
            <div className="mt-4 rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
              {error}
            </div>
          )}
        </CardContent>
      </Card>

      {result && (
        <>
          {/* Key Metrics */}
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
                  ${result.results.annual.mean.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                </div>
                <p className="text-xs text-muted-foreground">
                  P5: ${result.results.annual.p5.toLocaleString(undefined, { maximumFractionDigits: 0 })} / P95: ${result.results.annual.p95.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Monthly Profit</CardTitle>
              </CardHeader>
              <CardContent>
                <div className={`text-2xl font-bold ${result.results.profit.mean >= 0 ? 'text-success' : 'text-destructive'}`}>
                  ${result.results.profit.mean.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                </div>
                <p className="text-xs text-muted-foreground">
                  σ = ${result.results.profit.stdDev.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Annual Loss Prob</CardTitle>
                <AlertTriangle className={`h-4 w-4 ${result.results.annual.lossProb > 0.3 ? 'text-destructive' : 'text-muted-foreground'}`} />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">
                  {(result.results.annual.lossProb * 100).toFixed(1)}%
                </div>
                <p className="text-xs text-muted-foreground">
                  Monthly: {(result.results.risk.probabilityOfLoss * 100).toFixed(1)}%
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
                  {(result.results.reserve.breachProbability * 100).toFixed(1)}%
                </div>
                <p className="text-xs text-muted-foreground">
                  Threshold: ${result.results.reserve.threshold.toLocaleString()}
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Max Drawdown</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-destructive">
                  ${result.results.risk.maxDrawdown.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                </div>
                <p className="text-xs text-muted-foreground">
                  Worst month: ${result.results.risk.worstMonth.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                </p>
              </CardContent>
            </Card>
          </div>

          {/* Monthly Profit Bands */}
          <Card>
            <CardHeader>
              <CardTitle>Monthly Profit Bands (P5 / P50 / P95)</CardTitle>
              <CardDescription>
                Confidence bands across {iterations[0].toLocaleString()} iterations
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ChartContainer config={bandChartConfig} className="h-[350px]">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={result.results.monthlyBands.map((b, i) => ({ month: i + 1, ...b }))}>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                    <XAxis dataKey="month" tickFormatter={(v) => `M${v}`} className="text-xs" />
                    <YAxis tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`} className="text-xs" />
                    <ChartTooltip content={<ChartTooltipContent />} formatter={(value) => [`$${Number(value).toLocaleString()}`, '']} />
                    <ReferenceLine y={0} stroke="hsl(var(--muted-foreground))" strokeDasharray="5 5" />
                    <Area type="monotone" dataKey="p95" stroke="hsl(var(--chart-3))" fill="hsl(var(--chart-3))" fillOpacity={0.15} />
                    <Area type="monotone" dataKey="p50" stroke="hsl(var(--chart-1))" fill="hsl(var(--chart-1))" fillOpacity={0.25} />
                    <Area type="monotone" dataKey="p5" stroke="hsl(var(--destructive))" fill="hsl(var(--destructive))" fillOpacity={0.15} />
                  </AreaChart>
                </ResponsiveContainer>
              </ChartContainer>
            </CardContent>
          </Card>

          {/* Annual Profit Histogram */}
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
                    <ChartTooltip content={<ChartTooltipContent />} formatter={(value, _name, props) => [`${value} iterations`, `$${props.payload.bucket.toLocaleString()}`]} />
                    <ReferenceLine x={0} stroke="hsl(var(--muted-foreground))" strokeDasharray="5 5" />
                    <Bar dataKey="count" fill="hsl(var(--chart-1))" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </ChartContainer>
            </CardContent>
          </Card>

          {/* Metadata */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Run Metadata</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid gap-2 text-sm md:grid-cols-3">
                <div>
                  <span className="text-muted-foreground">Run ID: </span>
                  <span className="font-mono text-xs">{result.run_id?.slice(0, 8) ?? 'not persisted'}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">Duration: </span>
                  <span>{(result.duration_ms / 1000).toFixed(1)}s</span>
                </div>
                <div>
                  <span className="text-muted-foreground">Source: </span>
                  <Badge variant="outline">{result.assumptions_source}</Badge>
                </div>
              </div>
              {result.cohorts_used.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {result.cohorts_used.map(c => (
                    <Badge key={c.id} variant="secondary">{c.name} ({c.phase})</Badge>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
