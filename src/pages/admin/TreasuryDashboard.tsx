import { useState } from 'react';
import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { missionControlNavItems } from '@/components/layout/AdminNav';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, ResponsiveContainer, ReferenceLine,
  AreaChart, Area, BarChart, Bar, Tooltip, Legend,
} from 'recharts';
import { Gauge, AlertTriangle, ShieldCheck, ShieldAlert, Play, TrendingUp, Loader2 } from 'lucide-react';
import { supabase, SUPABASE_FUNCTIONS_URL } from '@/integrations/supabase/client';
import { toast } from 'sonner';

interface ProjectionResponse {
  ok: boolean;
  projectionId: string;
  verdict: {
    safeGrowthCeilingPct: number;
    summary: string;
    lines: string[];
    insolventInBase: boolean;
    survivalRate: number;
  };
  monthlyAggregates: Array<{
    month: number;
    reserve_p5: number; reserve_p50: number; reserve_p95: number;
    funded_p50: number;
    payoutsPaid_p50: number; payoutsPaid_p95: number;
    queue_p50: number; queue_p95: number;
  }>;
  medianResult: {
    insolventMonth: number | null;
    months: Array<{
      month: number; totalFunded: number; reserveEnd: number; payRevRatio: number;
      breakerLevel: 'normal' | 'l1' | 'l2'; payoutsPaid: number; payoutsDeferred: number;
      netRevenue: number;
    }>;
  };
  scalingCheckpoints_p50: Record<string, { month: number; reserveEnd: number; reached_pct: number } | null>;
  velocitySweep: Array<{
    growthRateMoM: number; survivalRate: number; reserve_stress_trough: number;
    avg_l2_months: number; pct_runs_with_l2: number;
  }>;
  sensitivity: {
    passRates: number[]; resetRates: number[];
    grid: Array<{ passRate: number; resetRate: number; survivalRate: number; trough: number }>;
  };
  survivalRate: number;
  breaker: { avg_l1_months: number; avg_l2_months: number; pct_runs_with_l2: number };
  reserve: {
    recommended_trough: number; stress_trough_p5: number; catastrophic_trough: number;
    required_additional_recommended: number; required_additional_stress: number; required_additional_catastrophic: number;
  };
}

const SCENARIOS: Record<string, { label: string; growthRateMoM: number; startingReserve: number; newSignupsMonth1: number; successParadoxEnabled: boolean; behavior?: Record<string, number> }> = {
  baseline: { label: 'Baseline', growthRateMoM: 0.15, startingReserve: 25_000, newSignupsMonth1: 50, successParadoxEnabled: false },
  stress:   { label: 'Stress', growthRateMoM: 0.30, startingReserve: 25_000, newSignupsMonth1: 50, successParadoxEnabled: false, behavior: { passRate: 0.18, resetRateAnnual: 0.10 } },
  catastrophic: { label: 'Catastrophic', growthRateMoM: 0.40, startingReserve: 25_000, newSignupsMonth1: 80, successParadoxEnabled: false, behavior: { passRate: 0.22, resetRateAnnual: 0.06, chargebackRate: 0.04 } },
  success_paradox: { label: 'Success Paradox', growthRateMoM: 0.20, startingReserve: 25_000, newSignupsMonth1: 60, successParadoxEnabled: true },
  viral: { label: 'Viral Surge', growthRateMoM: 0.20, startingReserve: 25_000, newSignupsMonth1: 50, successParadoxEnabled: false },
};

function fmtUSD(n: number) {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${n < 0 ? '-' : ''}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${n < 0 ? '-' : ''}$${(abs / 1_000).toFixed(1)}k`;
  return `${n < 0 ? '-' : ''}$${abs.toFixed(0)}`;
}

function pct(n: number, digits = 0) { return `${(n * 100).toFixed(digits)}%`; }

export default function TreasuryDashboard() {
  const [scenarioKey, setScenarioKey] = useState<keyof typeof SCENARIOS>('baseline');
  const [startingReserve, setStartingReserve] = useState(25_000);
  const [startingTraders, setStartingTraders] = useState(0);
  const [newSignupsMonth1, setNewSignupsMonth1] = useState(50);
  const [growthRateMoM, setGrowthRateMoM] = useState(0.15);
  const [horizonMonths, setHorizonMonths] = useState(24);
  const [trials, setTrials] = useState(100);
  const [successParadoxEnabled, setSuccessParadoxEnabled] = useState(false);
  const [affiliateSurgeMonth, setAffiliateSurgeMonth] = useState<number | null>(null);
  const [affiliateSurgeMultiplier, setAffiliateSurgeMultiplier] = useState(3);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ProjectionResponse | null>(null);

  function applyScenario(key: keyof typeof SCENARIOS) {
    const s = SCENARIOS[key];
    setScenarioKey(key);
    setGrowthRateMoM(s.growthRateMoM);
    setStartingReserve(s.startingReserve);
    setNewSignupsMonth1(s.newSignupsMonth1);
    setSuccessParadoxEnabled(s.successParadoxEnabled);
    if (key === 'viral') { setAffiliateSurgeMonth(4); setAffiliateSurgeMultiplier(5); }
    else { setAffiliateSurgeMonth(null); setAffiliateSurgeMultiplier(3); }
  }

  async function runProjection() {
    setLoading(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch(`${SUPABASE_FUNCTIONS_URL}/run-treasury-projection`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session?.access_token ?? ''}`,
        },
        body: JSON.stringify({
          scenarioKey, label: SCENARIOS[scenarioKey].label,
          startingReserve, startingTraders, newSignupsMonth1,
          growthRateMoM, horizonMonths, trials,
          successParadoxEnabled,
          affiliateSurgeMonth, affiliateSurgeMultiplier: affiliateSurgeMultiplier,
          behavior: SCENARIOS[scenarioKey].behavior ?? {},
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        toast.error(json.error ?? 'Projection failed');
      } else {
        setResult(json);
        toast.success('Projection complete');
      }
    } catch (e) {
      console.error(e);
      toast.error('Projection failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <DashboardLayout navItems={missionControlNavItems} title="Treasury / Scaling Velocity">
      <div className="space-y-6 p-6">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight flex items-center gap-3">
              <Gauge className="h-8 w-8 text-primary" />
              Treasury Risk & Scaling Velocity
            </h1>
            <p className="text-muted-foreground mt-2 max-w-3xl">
              Multi-cohort operational treasury simulator. Optimizes for <strong>survivability, not growth</strong>.
              Answers: how fast can Meridian onboard before reserves run dry or the breaker becomes load-bearing?
            </p>
          </div>
        </div>

        {/* Scenario Picker */}
        <Card>
          <CardHeader>
            <CardTitle>Scenario</CardTitle>
            <CardDescription>Pick a preset or tune inputs below, then run.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-2 mb-6">
              {(Object.keys(SCENARIOS) as Array<keyof typeof SCENARIOS>).map((k) => (
                <Button
                  key={k}
                  variant={scenarioKey === k ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => applyScenario(k)}
                >
                  {SCENARIOS[k].label}
                </Button>
              ))}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <Label>Starting reserve (USD)</Label>
                <Input type="number" value={startingReserve} onChange={(e) => setStartingReserve(Number(e.target.value))} />
              </div>
              <div>
                <Label>Starting funded traders</Label>
                <Input type="number" value={startingTraders} onChange={(e) => setStartingTraders(Number(e.target.value))} />
              </div>
              <div>
                <Label>Month-1 signups</Label>
                <Input type="number" value={newSignupsMonth1} onChange={(e) => setNewSignupsMonth1(Number(e.target.value))} />
              </div>
              <div>
                <Label>MoM growth rate ({pct(growthRateMoM)})</Label>
                <Input type="number" step="0.01" value={growthRateMoM} onChange={(e) => setGrowthRateMoM(Number(e.target.value))} />
              </div>
              <div>
                <Label>Horizon (months)</Label>
                <Input type="number" value={horizonMonths} min={6} max={36} onChange={(e) => setHorizonMonths(Number(e.target.value))} />
              </div>
              <div>
                <Label>Trials (Monte Carlo)</Label>
                <Input type="number" value={trials} min={20} max={300} onChange={(e) => setTrials(Number(e.target.value))} />
              </div>
              <div className="flex items-center gap-3 pt-6">
                <Switch checked={successParadoxEnabled} onCheckedChange={setSuccessParadoxEnabled} id="paradox" />
                <Label htmlFor="paradox" className="cursor-pointer">Success-paradox drift</Label>
              </div>
              <div>
                <Label>Affiliate surge month (or blank)</Label>
                <Input type="number" value={affiliateSurgeMonth ?? ''} onChange={(e) => setAffiliateSurgeMonth(e.target.value === '' ? null : Number(e.target.value))} />
              </div>
              <div>
                <Label>Surge multiplier ({affiliateSurgeMultiplier}×)</Label>
                <Input type="number" step="0.5" value={affiliateSurgeMultiplier} onChange={(e) => setAffiliateSurgeMultiplier(Number(e.target.value))} />
              </div>
            </div>

            <div className="mt-6 flex gap-3">
              <Button onClick={runProjection} disabled={loading} size="lg">
                {loading ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Play className="h-4 w-4 mr-2" />}
                Run projection
              </Button>
            </div>
          </CardContent>
        </Card>

        {result && (
          <>
            {/* Verdict */}
            <Card className={result.verdict.insolventInBase ? 'border-destructive' : 'border-primary'}>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  {result.verdict.insolventInBase
                    ? <ShieldAlert className="h-5 w-5 text-destructive" />
                    : <ShieldCheck className="h-5 w-5 text-primary" />}
                  Operational Verdict
                </CardTitle>
                <CardDescription>
                  Survival rate {pct(result.survivalRate, 1)} across {trials} trials
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                {result.verdict.lines.map((l, i) => (
                  <p key={i} className="text-sm">{l}</p>
                ))}
                <Separator className="my-3" />
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-center">
                  <Stat label="Safe MoM ceiling" value={pct(result.verdict.safeGrowthCeilingPct)} />
                  <Stat label="Recommended reserve" value={fmtUSD(Math.max(startingReserve, startingReserve - result.reserve.recommended_trough))} />
                  <Stat label="Stress reserve (P5)" value={fmtUSD(Math.max(startingReserve, startingReserve - result.reserve.stress_trough_p5))} danger={result.reserve.required_additional_stress > 0} />
                  <Stat label="Catastrophic reserve" value={fmtUSD(Math.max(startingReserve, startingReserve - result.reserve.catastrophic_trough))} danger={result.reserve.required_additional_catastrophic > 0} />
                </div>
              </CardContent>
            </Card>

            <Tabs defaultValue="liquidity">
              <TabsList className="grid grid-cols-5 w-full">
                <TabsTrigger value="liquidity">Liquidity Curve</TabsTrigger>
                <TabsTrigger value="velocity">Growth Ceiling</TabsTrigger>
                <TabsTrigger value="scaling">Scaling Tiers</TabsTrigger>
                <TabsTrigger value="breaker">Breaker Forecast</TabsTrigger>
                <TabsTrigger value="sensitivity">Sensitivity</TabsTrigger>
              </TabsList>

              <TabsContent value="liquidity">
                <Card>
                  <CardHeader>
                    <CardTitle>Reserve trajectory (24 months)</CardTitle>
                    <CardDescription>P5 / P50 / P95 envelope across trials. Watch the P5 trough — that's your stress reserve.</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <ResponsiveContainer width="100%" height={360}>
                      <AreaChart data={result.monthlyAggregates}>
                        <CartesianGrid strokeDasharray="3 3" className="opacity-30" />
                        <XAxis dataKey="month" />
                        <YAxis tickFormatter={(v) => fmtUSD(v)} />
                        <Tooltip formatter={(v: number) => fmtUSD(v)} />
                        <Legend />
                        <ReferenceLine y={0} stroke="hsl(var(--destructive))" strokeDasharray="3 3" label="Insolvency" />
                        <Area type="monotone" dataKey="reserve_p95" stroke="hsl(var(--primary))" fillOpacity={0.1} fill="hsl(var(--primary))" name="P95 reserve" />
                        <Area type="monotone" dataKey="reserve_p50" stroke="hsl(var(--primary))" fillOpacity={0.3} fill="hsl(var(--primary))" name="P50 reserve" />
                        <Area type="monotone" dataKey="reserve_p5" stroke="hsl(var(--destructive))" fillOpacity={0.2} fill="hsl(var(--destructive))" name="P5 reserve (stress)" />
                      </AreaChart>
                    </ResponsiveContainer>
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="velocity">
                <Card>
                  <CardHeader>
                    <CardTitle>Growth Velocity Ceiling</CardTitle>
                    <CardDescription>Survival rate and L2-freeze probability vs MoM growth rate. The cliff is where survival drops.</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <ResponsiveContainer width="100%" height={360}>
                      <LineChart data={result.velocitySweep}>
                        <CartesianGrid strokeDasharray="3 3" className="opacity-30" />
                        <XAxis dataKey="growthRateMoM" tickFormatter={(v) => pct(v)} label={{ value: 'MoM growth rate', position: 'insideBottom', offset: -5 }} />
                        <YAxis yAxisId="left" tickFormatter={(v) => pct(v)} domain={[0, 1]} />
                        <YAxis yAxisId="right" orientation="right" />
                        <Tooltip formatter={(v: number, name: string) => name.includes('rate') || name.includes('pct') ? pct(v, 1) : v.toFixed(1)} />
                        <Legend />
                        <ReferenceLine yAxisId="left" y={0.95} stroke="hsl(var(--primary))" strokeDasharray="3 3" label="95% survival" />
                        <Line yAxisId="left" type="monotone" dataKey="survivalRate" stroke="hsl(var(--primary))" name="Survival rate" strokeWidth={2} />
                        <Line yAxisId="left" type="monotone" dataKey="pct_runs_with_l2" stroke="hsl(var(--destructive))" name="L2-freeze probability" strokeWidth={2} />
                        <Line yAxisId="right" type="monotone" dataKey="avg_l2_months" stroke="hsl(var(--warning, var(--muted-foreground)))" name="Avg L2 months" strokeDasharray="3 3" />
                      </LineChart>
                    </ResponsiveContainer>
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="scaling">
                <Card>
                  <CardHeader>
                    <CardTitle>Trader-count milestones</CardTitle>
                    <CardDescription>When the median trial reaches each tier, and the reserve at that moment.</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                      {['100', '500', '1000', '5000'].map((t) => {
                        const cp = result.scalingCheckpoints_p50[t];
                        return (
                          <Card key={t} className={cp ? '' : 'opacity-60'}>
                            <CardHeader>
                              <CardTitle className="text-base">{t} funded traders</CardTitle>
                            </CardHeader>
                            <CardContent className="space-y-1">
                              {cp ? (
                                <>
                                  <p className="text-sm text-muted-foreground">Reached month</p>
                                  <p className="text-2xl font-bold">{cp.month}</p>
                                  <Separator className="my-2" />
                                  <p className="text-sm text-muted-foreground">Reserve at milestone</p>
                                  <p className={`text-xl font-semibold ${cp.reserveEnd < 0 ? 'text-destructive' : ''}`}>{fmtUSD(cp.reserveEnd)}</p>
                                  <p className="text-xs text-muted-foreground mt-2">{pct(cp.reached_pct, 0)} of trials reach this tier in horizon</p>
                                </>
                              ) : (
                                <p className="text-sm text-muted-foreground">Not reached in {horizonMonths} mo</p>
                              )}
                            </CardContent>
                          </Card>
                        );
                      })}
                    </div>
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="breaker">
                <Card>
                  <CardHeader>
                    <CardTitle>Breaker Forecast</CardTitle>
                    <CardDescription>Median trial — rolling Pay/Rev and breaker state per month.</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="grid grid-cols-3 gap-4 mb-6">
                      <Stat label="Avg L1 months" value={result.breaker.avg_l1_months.toFixed(1)} />
                      <Stat label="Avg L2 months" value={result.breaker.avg_l2_months.toFixed(1)} danger={result.breaker.avg_l2_months > 2} />
                      <Stat label="Runs hitting L2" value={pct(result.breaker.pct_runs_with_l2)} danger={result.breaker.pct_runs_with_l2 > 0.1} />
                    </div>
                    <ResponsiveContainer width="100%" height={300}>
                      <BarChart data={result.medianResult.months}>
                        <CartesianGrid strokeDasharray="3 3" className="opacity-30" />
                        <XAxis dataKey="month" />
                        <YAxis tickFormatter={(v) => pct(v, 0)} />
                        <Tooltip formatter={(v: number) => pct(v, 1)} />
                        <ReferenceLine y={0.30} stroke="hsl(var(--warning, var(--muted-foreground)))" strokeDasharray="3 3" label="L1 30%" />
                        <ReferenceLine y={0.45} stroke="hsl(var(--destructive))" strokeDasharray="3 3" label="L2 45%" />
                        <Bar dataKey="payRevRatio" fill="hsl(var(--primary))" name="Pay/Rev" />
                      </BarChart>
                    </ResponsiveContainer>
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="sensitivity">
                <Card>
                  <CardHeader>
                    <CardTitle>Pass-rate × Reset-rate sensitivity</CardTitle>
                    <CardDescription>Survival rate at each combination. Green = safe, red = high failure risk.</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <SensitivityHeatmap data={result.sensitivity} />
                  </CardContent>
                </Card>
              </TabsContent>
            </Tabs>
          </>
        )}
      </div>
    </DashboardLayout>
  );
}

function Stat({ label, value, danger }: { label: string; value: string; danger?: boolean }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={`text-2xl font-bold ${danger ? 'text-destructive' : ''}`}>{value}</p>
    </div>
  );
}

function SensitivityHeatmap({ data }: { data: { passRates: number[]; resetRates: number[]; grid: Array<{ passRate: number; resetRate: number; survivalRate: number; trough: number }> } }) {
  const cellColor = (s: number) => {
    if (s >= 0.95) return 'bg-primary/30 text-foreground';
    if (s >= 0.80) return 'bg-primary/15 text-foreground';
    if (s >= 0.60) return 'bg-muted text-foreground';
    if (s >= 0.30) return 'bg-destructive/20 text-foreground';
    return 'bg-destructive/50 text-destructive-foreground';
  };
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr>
            <th className="text-left p-2 text-muted-foreground">Pass ↓ / Reset →</th>
            {data.resetRates.map((r) => <th key={r} className="p-2 text-center">{(r * 100).toFixed(0)}%</th>)}
          </tr>
        </thead>
        <tbody>
          {data.passRates.map((pr) => (
            <tr key={pr}>
              <td className="p-2 font-mono text-muted-foreground">{(pr * 100).toFixed(0)}%</td>
              {data.resetRates.map((rr) => {
                const cell = data.grid.find((g) => g.passRate === pr && g.resetRate === rr);
                if (!cell) return <td key={rr} className="p-2" />;
                return (
                  <td key={rr} className={`p-3 text-center font-mono ${cellColor(cell.survivalRate)}`}>
                    <div className="font-semibold">{(cell.survivalRate * 100).toFixed(0)}%</div>
                    <div className="text-xs opacity-70">{cell.trough < 0 ? '↓' : ''}{fmtUSDCompact(cell.trough)}</div>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-xs text-muted-foreground mt-3">
        Top number: 24-month survival. Bottom: reserve trough (negative = needs more capital).
      </p>
    </div>
  );
}

function fmtUSDCompact(n: number) {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `$${(abs / 1_000).toFixed(0)}k`;
  return `$${abs.toFixed(0)}`;
}