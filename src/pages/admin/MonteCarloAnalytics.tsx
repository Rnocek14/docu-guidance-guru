import { useState, useCallback, useMemo } from 'react';
import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { missionControlNavItems } from '@/components/layout/AdminNav';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
  ResponsiveContainer, ReferenceLine, Area, AreaChart, Line,
} from 'recharts';
import { ChartContainer, ChartTooltip, ChartTooltipContent, ChartConfig } from '@/components/ui/chart';
import {
  TrendingUp, TrendingDown, AlertTriangle, Shield, Zap, Info, Play, ShieldCheck, ShieldAlert, Clock,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { supabase } from '@/integrations/supabase/client';
import { SimulationControls, type SimOverrides } from '@/components/admin/SimulationControls';
import { RiskReportTab } from '@/components/admin/RiskReportTab';
import { CustomerGrowthTab } from '@/components/admin/CustomerGrowthTab';
import { BreakerValidationPanel } from '@/components/admin/BreakerValidationPanel';
import { HOSTILE_PRESETS, evaluateAssertions, computeOverallVerdict, type HostilePreset, type AssertionResult } from '@/lib/hostile-presets';
import { captureDbConfigSnapshot, validateBreakerConfig, type BreakerValidationResult } from '@/lib/breaker-evaluator';

// ─── Types ────────────────────────────────────────────────────────────────────

interface CrossCheckResult {
  shadow_iterations: number;
  profit_mean_delta: number;
  reserve_breach_delta: number;
  annual_loss_prob_delta: number;
  worst_month_delta: number;
  trust: 'high' | 'medium' | 'low';
  note?: string;
}

interface ScalingInfo {
  original: number;
  actual: number;
  reason: string;
}

interface ServerSimResult {
  run_id: string | null;
  duration_ms: number;
  assumptions_source: string;
  engine: string;
  partial: boolean;
  scaling: ScalingInfo | null;
  cross_check: CrossCheckResult | null;
  cohorts_used: { id: string; name: string; phase: string }[];
  results: {
    completedIterations: number;
    requestedIterations: number;
    partial: boolean;
    profit: { mean: number; p5: number; p50: number; p95: number; stdDev: number };
    risk: { probabilityOfLoss: number; maxDrawdown: number; worstMonth: number; bestMonth: number; consecutiveLossMonths: number; maxPayoutOutflowMonth?: { p95: number; p99: number; max: number } };
    reserve: { breachProbability: number; threshold: number };
    annual: { p5: number; p50: number; p95: number; lossProb: number; mean: number };
    monthlyBands: { p5: number; p50: number; p95: number; mean: number }[];
    cohortBands?: { totalAccounts: number; eligible: number; firstPayout: number; capHits: number }[];
    histogram: { bucket: number; count: number }[];
    diagnostics: {
      avgPayoutDollarsPerPassedAccount?: number;
      avgPayoutCountPerPassedAccount?: number;
      totalPayoutRequests?: number;
      capCompletions?: number;
      capClips?: number;
      capRejections?: number;
      capCompletionsPerPassedAccount?: number;
      capClipsPerPassedAccount?: number;
      capRejectionsPerPayoutRequest?: number;
      // Legacy compat
      avgPayoutsPerAccount: number;
      lifetimeCapHitRate: number;
    };
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
  const [activePreset, setActivePreset] = useState<HostilePreset | null>(null);
  const [assertionResults, setAssertionResults] = useState<AssertionResult[] | null>(null);
  const [breakerValidation, setBreakerValidation] = useState<BreakerValidationResult | null>(null);

  const runServerSimulation = useCallback(async () => {
    setIsRunning(true);
    setError(null);
    setAssertionResults(null);
    setBreakerValidation(null);
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
      const simResult = data as ServerSimResult;
      setResult(simResult);

      // Run assertions if hostile preset is active
      if (activePreset) {
        const assertions = evaluateAssertions(activePreset, simResult.results);
        setAssertionResults(assertions);

        // Run breaker validation against live DB
        try {
          const snapshot = await captureDbConfigSnapshot();
          const validation = validateBreakerConfig(
            snapshot,
            {
              worstMonthNetProfit: simResult.results.risk.worstMonth,
              reserveBreachProb: simResult.results.reserve.breachProbability,
              annualMeanProfit: simResult.results.annual.mean,
            },
            {
              attackIntensity: overrides.attackIntensity,
              reserveThreshold: overrides.reserveThreshold,
              entryFee: overrides.entryFee,
            },
          );
          setBreakerValidation(validation);

          // Persist run for audit trail
          const { error: saveErr } = await supabase.from('collapse_sim_runs' as any).insert({
            preset_id: activePreset.presetId,
            scenario_version: activePreset.scenarioVersion,
            inputs_json: overrides,
            db_snapshot_json: snapshot,
            results_json: {
              annual: simResult.results.annual,
              profit: simResult.results.profit,
              risk: simResult.results.risk,
              reserve: simResult.results.reserve,
              completedIterations: simResult.results.completedIterations,
              diagnostics: simResult.results.diagnostics ?? null,
            },
            assertions_json: assertions,
            overall_pass: computeOverallVerdict(assertions, validation) === 'pass',
            overall_verdict: computeOverallVerdict(assertions, validation),
          });
          if (saveErr) console.error('Failed to save sim run:', saveErr);
        } catch (e) {
          console.error('Breaker validation failed:', e);
        }
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsRunning(false);
    }
  }, [overrides, activePreset]);

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
    <DashboardLayout title="Monte Carlo Analytics" navItems={missionControlNavItems}>
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
          activePreset={activePreset}
          onSelectPreset={setActivePreset}
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
                        {result.results.completedIterations.toLocaleString()}
                        {result.results.partial ? ` of ${result.results.requestedIterations.toLocaleString()}` : ''} iterations × {overrides.horizon} months
                        {' | '}{(overrides.accountsPerMonth * overrides.horizon).toLocaleString()} customers ({overrides.accountsPerMonth}/mo)
                        {' | '}Engine: {result.engine ?? 'per_account_v1'}
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

                {/* Engine indicators row */}
                <div className="flex flex-wrap items-center gap-2 mt-4 pt-4 border-t border-muted">
                  {result.results.partial && (
                    <Badge variant="destructive" className="gap-1">
                      <Clock className="h-3 w-3" /> Partial: {result.results.completedIterations}/{result.results.requestedIterations} iterations (timeout)
                    </Badge>
                  )}
                  {result.scaling && (
                    <Badge variant="secondary" className="gap-1">
                      ⚡ Auto-scaled: {result.scaling.actual} iterations
                    </Badge>
                  )}
                  {result.cross_check && (
                    <Badge
                      variant="outline"
                      className={
                        result.cross_check.trust === 'high' ? 'border-success/50 text-success gap-1' :
                        result.cross_check.trust === 'medium' ? 'border-warning/50 text-warning gap-1' :
                        'border-destructive/50 text-destructive gap-1'
                      }
                    >
                      {result.cross_check.trust === 'high' ? <ShieldCheck className="h-3 w-3" /> : <ShieldAlert className="h-3 w-3" />}
                      Cross-check: {result.cross_check.trust}
                    </Badge>
                  )}
                  <Badge variant="outline" className="text-muted-foreground">
                    Engine: per-account (high fidelity)
                  </Badge>
                </div>
              </CardContent>
            </Card>

            {/* Breaker Validation (hostile presets only) */}
            {activePreset && (assertionResults || breakerValidation) && (
              <BreakerValidationPanel
                assertionResults={assertionResults}
                breakerValidation={breakerValidation}
              />
            )}

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
                        <h4 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Payout Metrics (per passed account)</h4>
                        {[
                          ['Avg Payout $ / Passed Account', result.results.diagnostics.avgPayoutDollarsPerPassedAccount != null ? fmt(result.results.diagnostics.avgPayoutDollarsPerPassedAccount) : result.results.diagnostics.avgPayoutsPerAccount.toFixed(3)],
                          ['Avg Payout Count / Passed Account', result.results.diagnostics.avgPayoutCountPerPassedAccount?.toFixed(3) ?? 'n/a'],
                          ['Total Payout Requests', result.results.diagnostics.totalPayoutRequests?.toLocaleString() ?? 'n/a'],
                        ].map(([label, value]) => (
                          <div key={label} className="flex justify-between border-b pb-2 last:border-0">
                            <span className="text-muted-foreground">{label}</span>
                            <span className="font-medium">{value}</span>
                          </div>
                        ))}

                        <h4 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mt-4">Cap Metrics (split)</h4>
                        {[
                          ['Cap Completions (exhausted)', result.results.diagnostics.capCompletions?.toLocaleString() ?? 'n/a'],
                          ['Cap Clips (payout trimmed)', result.results.diagnostics.capClips?.toLocaleString() ?? 'n/a'],
                          ['Cap Rejections (headroom ≤ 0)', result.results.diagnostics.capRejections?.toLocaleString() ?? 'n/a'],
                          ['Completions / Passed Account', result.results.diagnostics.capCompletionsPerPassedAccount?.toFixed(4) ?? pct(result.results.diagnostics.lifetimeCapHitRate)],
                          ['Clips / Passed Account', result.results.diagnostics.capClipsPerPassedAccount?.toFixed(4) ?? 'n/a'],
                          ['Rejections / Payout Request', result.results.diagnostics.capRejectionsPerPayoutRequest != null ? pct(result.results.diagnostics.capRejectionsPerPayoutRequest) : 'n/a'],
                        ].map(([label, value]) => (
                          <div key={label} className="flex justify-between border-b pb-2 last:border-0">
                            <span className="text-muted-foreground">{label}</span>
                            <span className="font-medium">{value}</span>
                          </div>
                        ))}

                        <h4 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mt-4">Risk Tail</h4>
                        {[
                          ['Peak Eligible Pool', result.results.cohortBands ? Math.max(...result.results.cohortBands.map(b => b.eligible)).toLocaleString() : 'n/a'],
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

                {/* Cross-check results */}
                {result.cross_check && (
                  <Card className="mt-4">
                    <CardHeader>
                      <CardTitle className="flex items-center gap-2">
                        {result.cross_check.trust === 'high' ? <ShieldCheck className="h-5 w-5 text-success" /> : <ShieldAlert className="h-5 w-5 text-warning" />}
                        Shadow Cross-Check ({result.cross_check.shadow_iterations} iterations)
                      </CardTitle>
                      <CardDescription>
                        Per-account engine vs legacy cohort-aggregate engine delta (shared macro randomness).
                        Trust: <strong>{result.cross_check.trust}</strong>
                        {result.cross_check.note && <> — {result.cross_check.note}</>}
                      </CardDescription>
                    </CardHeader>
                    <CardContent>
                      <div className="space-y-3">
                        {[
                          ['Profit Mean Delta', fmt(result.cross_check.profit_mean_delta), result.cross_check.profit_mean_delta > 5000],
                          ['Reserve Breach Delta', pct(result.cross_check.reserve_breach_delta), result.cross_check.reserve_breach_delta > 0.03],
                          ['Annual Loss Prob Delta', pct(result.cross_check.annual_loss_prob_delta), result.cross_check.annual_loss_prob_delta > 0.05],
                          ['Worst Month Delta', fmt(result.cross_check.worst_month_delta), result.cross_check.worst_month_delta > 10000],
                        ].map(([label, value, isHigh]) => (
                          <div key={label as string} className="flex justify-between border-b pb-2 last:border-0">
                            <span className="text-muted-foreground">{label as string}</span>
                            <span className={`font-medium ${isHigh ? 'text-destructive' : 'text-success'}`}>{value as string}</span>
                          </div>
                        ))}
                      </div>
                    </CardContent>
                  </Card>
                )}

                <div className="mt-4 flex items-start gap-2 rounded-lg border border-muted bg-muted/30 p-4 text-sm text-muted-foreground">
                  <Info className="mt-0.5 h-4 w-4 shrink-0" />
                  <div>
                    <strong>Note on Max Drawdown:</strong> The {fmt(result.results.risk.maxDrawdown)} figure is the worst
                    cumulative peak-to-trough across all {result.results.completedIterations.toLocaleString()} iterations — a statistical tail extreme,
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
