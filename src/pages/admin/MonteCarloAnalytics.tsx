import { useState, useMemo, useCallback } from 'react';
import { DashboardLayout, adminNavItems } from '@/components/layout/DashboardLayout';
import { ServerSimulationPanel } from '@/components/admin/ServerSimulationPanel';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Slider } from '@/components/ui/slider';
import { Label } from '@/components/ui/label';
import { 
  BarChart, 
  Bar, 
  LineChart, 
  Line, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  ResponsiveContainer, 
  ReferenceLine,
  Area,
  AreaChart,
} from 'recharts';
import { ChartContainer, ChartTooltip, ChartTooltipContent, ChartConfig } from '@/components/ui/chart';
import { 
  Play, 
  RefreshCw, 
  TrendingUp, 
  TrendingDown, 
  AlertTriangle,
  CheckCircle,
  XCircle,
  Info,
  Zap,
  Target,
  Activity,
} from 'lucide-react';
import { runMonteCarlo, DEFAULT_ASSUMPTIONS, MonteCarloResult, MonteCarloConfig, MonteCarloAssumptions } from '@/lib/monte-carlo';

// Chart configs
const profitChartConfig: ChartConfig = {
  profit: { label: 'Monthly Profit', color: 'hsl(var(--chart-1))' },
  loss: { label: 'Monthly Loss', color: 'hsl(var(--destructive))' },
};

const cohortChartConfig: ChartConfig = {
  active: { label: 'Active Accounts', color: 'hsl(var(--chart-2))' },
  eligible: { label: 'Eligible for Payout', color: 'hsl(var(--chart-3))' },
};

const ratioChartConfig: ChartConfig = {
  ratio: { label: 'Payout/Revenue Ratio', color: 'hsl(var(--chart-4))' },
};

// Default config for quick simulations
const QUICK_CONFIG: MonteCarloConfig = {
  iterations: 100,
  monthsPerIteration: 12,
  seed: 42,
};

const FULL_CONFIG: MonteCarloConfig = {
  iterations: 500,
  monthsPerIteration: 36,
  seed: 42,
};

export default function MonteCarloAnalytics() {
  const [isRunning, setIsRunning] = useState(false);
  const [result, setResult] = useState<MonteCarloResult | null>(null);
  const [runType, setRunType] = useState<'quick' | 'full'>('quick');
  
  // Adjustable parameters
  const [passRate, setPassRate] = useState([12]);
  const [avgPayout, setAvgPayout] = useState([420]);
  const [resetRate, setResetRate] = useState([18]);
  const [lifetimeCapMultiple, setLifetimeCapMultiple] = useState([7]);

  const runSimulation = useCallback(() => {
    setIsRunning(true);
    
    // Use setTimeout to allow UI to update
    setTimeout(() => {
      try {
        const config = runType === 'quick' ? QUICK_CONFIG : FULL_CONFIG;
        
        // Build custom assumptions
        const customAssumptions: MonteCarloAssumptions = {
          ...DEFAULT_ASSUMPTIONS,
          passRate: {
            min: (passRate[0] - 2) / 100,
            mode: passRate[0] / 100,
            max: (passRate[0] + 3) / 100,
          },
          avgPayoutAmount: {
            mean: avgPayout[0],
            stdDev: avgPayout[0] * 0.3,
          },
          resetRate: resetRate[0] / 100,
          knobs: {
            ...DEFAULT_ASSUMPTIONS.knobs,
            lifetimeCapPerUser: lifetimeCapMultiple[0] > 0 
              ? DEFAULT_ASSUMPTIONS.pricePerAccount * lifetimeCapMultiple[0]
              : null,
          },
        };
        
        const simResult = runMonteCarlo(config, customAssumptions);
        setResult(simResult);
      } catch (error) {
        console.error('Simulation error:', error);
      } finally {
        setIsRunning(false);
      }
    }, 50);
  }, [runType, passRate, avgPayout, resetRate, lifetimeCapMultiple]);

  // Prepare chart data
  const profitDistributionData = useMemo(() => {
    if (!result || !result.rawSamples) return [];
    
    // Flatten all profits
    const allProfits = result.rawSamples.flat();
    
    // Create histogram buckets
    const buckets: Record<string, number> = {};
    const bucketSize = 5000;
    
    allProfits.forEach(profit => {
      const bucket = Math.floor(profit / bucketSize) * bucketSize;
      const key = bucket.toString();
      buckets[key] = (buckets[key] || 0) + 1;
    });
    
    return Object.entries(buckets)
      .map(([bucket, count]) => ({
        bucket: parseInt(bucket),
        count,
        isProfit: parseInt(bucket) >= 0,
      }))
      .sort((a, b) => a.bucket - b.bucket);
  }, [result]);

  const cohortTimeSeriesData = useMemo(() => {
    if (!result) return [];
    
    return result.cohortDiagnostics.activeCohortSizeByMonth.map((active, i) => ({
      month: i,
      active,
      eligible: result.cohortDiagnostics.eligibleCohortSizeByMonth[i] || 0,
    }));
  }, [result]);

  const payoutRatioData = useMemo(() => {
    if (!result) return [];
    
    return result.cohortDiagnostics.payoutToRevenueRatioByMonth.map((ratio, i) => ({
      month: i,
      ratio: ratio * 100,
    }));
  }, [result]);

  const getTrustScore = useCallback(() => {
    if (!result) return null;
    
    let score = 100;
    const issues: string[] = [];
    const passes: string[] = [];
    
    // Check profit margin
    if (result.profit.mean < 0) {
      score -= 30;
      issues.push('Negative expected profit');
    } else if (result.profit.mean > 0) {
      passes.push(`Positive margin: ${(result.diagnostics.effectiveMargin * 100).toFixed(1)}%`);
    }
    
    // Check losing month probability
    if (result.risk.probabilityOfLoss > 0.5) {
      score -= 25;
      issues.push(`High loss probability: ${(result.risk.probabilityOfLoss * 100).toFixed(0)}%`);
    } else {
      passes.push(`Loss probability: ${(result.risk.probabilityOfLoss * 100).toFixed(0)}%`);
    }
    
    // Check reset rate accuracy
    const resetError = Math.abs(result.cohortDiagnostics.resetRateErrorRatio - 1);
    if (resetError > 0.3) {
      score -= 15;
      issues.push('Reset model inaccurate');
    } else {
      passes.push(`Reset accuracy: ${((1 - resetError) * 100).toFixed(0)}%`);
    }
    
    // Check steady-state stability
    const last12 = result.cohortDiagnostics.payoutToRevenueRatioByMonth.slice(-12);
    if (last12.length >= 12) {
      const first6Avg = last12.slice(0, 6).reduce((a, b) => a + b, 0) / 6;
      const last6Avg = last12.slice(6).reduce((a, b) => a + b, 0) / 6;
      const drift = Math.abs(last6Avg - first6Avg) / (first6Avg || 1);
      
      if (drift > 0.25) {
        score -= 15;
        issues.push('Payout ratio unstable');
      } else {
        passes.push('Steady-state stable');
      }
    }
    
    // Check cap binding
    if (result.payoutDiagnostics.lifetimeCapBindingRate > 0) {
      passes.push(`Cap binding: ${(result.payoutDiagnostics.lifetimeCapBindingRate * 100).toFixed(1)}%`);
    }
    
    return { score: Math.max(0, score), issues, passes };
  }, [result]);

  const trustScore = getTrustScore();

  return (
    <DashboardLayout title="Monte Carlo Analytics" navItems={adminNavItems}>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="text-2xl font-bold tracking-tight">Economic Simulation</h2>
            <p className="text-muted-foreground">
              Run Monte Carlo simulations to validate platform economics and risk controls.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant={runType === 'quick' ? 'default' : 'secondary'}>
              {runType === 'quick' ? '100 iterations / 12mo' : '500 iterations / 36mo'}
            </Badge>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setRunType(runType === 'quick' ? 'full' : 'quick')}
            >
              {runType === 'quick' ? 'Full Run' : 'Quick Run'}
            </Button>
            <Button onClick={runSimulation} disabled={isRunning}>
              {isRunning ? (
                <>
                  <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                  Running...
                </>
              ) : (
                <>
                  <Play className="mr-2 h-4 w-4" />
                  Run Simulation
                </>
              )}
            </Button>
          </div>
        </div>

        {/* Parameter Controls */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Simulation Parameters</CardTitle>
            <CardDescription>Adjust assumptions to stress-test economics</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4">
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <Label>Pass Rate</Label>
                  <span className="text-sm font-medium">{passRate[0]}%</span>
                </div>
                <Slider
                  value={passRate}
                  onValueChange={setPassRate}
                  min={5}
                  max={30}
                  step={1}
                />
                <p className="text-xs text-muted-foreground">% of accounts that pass evaluation</p>
              </div>
              
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <Label>Avg Payout</Label>
                  <span className="text-sm font-medium">${avgPayout[0]}</span>
                </div>
                <Slider
                  value={avgPayout}
                  onValueChange={setAvgPayout}
                  min={100}
                  max={800}
                  step={20}
                />
                <p className="text-xs text-muted-foreground">Average payout amount per request</p>
              </div>
              
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <Label>Reset Rate</Label>
                  <span className="text-sm font-medium">{resetRate[0]}%</span>
                </div>
                <Slider
                  value={resetRate}
                  onValueChange={setResetRate}
                  min={5}
                  max={40}
                  step={1}
                />
                <p className="text-xs text-muted-foreground">Annual % of accounts that reset/churn</p>
              </div>
              
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <Label>Lifetime Cap</Label>
                  <span className="text-sm font-medium">
                    {lifetimeCapMultiple[0] > 0 ? `${lifetimeCapMultiple[0]}× ($${lifetimeCapMultiple[0] * 149})` : 'None'}
                  </span>
                </div>
                <Slider
                  value={lifetimeCapMultiple}
                  onValueChange={setLifetimeCapMultiple}
                  min={0}
                  max={15}
                  step={1}
                />
                <p className="text-xs text-muted-foreground">Multiple of entry fee (0 = unlimited)</p>
              </div>
            </div>
          </CardContent>
        </Card>

        {result ? (
          <>
            {/* Trust Score Card */}
            <Card className={
              trustScore && trustScore.score >= 80 
                ? 'border-success/50 bg-success/5' 
                : trustScore && trustScore.score >= 50 
                  ? 'border-warning/50 bg-warning/5'
                  : 'border-destructive/50 bg-destructive/5'
            }>
              <CardContent className="pt-6">
                <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                  <div className="flex items-center gap-4">
                    <div className={`flex h-16 w-16 items-center justify-center rounded-full ${
                      trustScore && trustScore.score >= 80 
                        ? 'bg-success/20 text-success' 
                        : trustScore && trustScore.score >= 50 
                          ? 'bg-warning/20 text-warning'
                          : 'bg-destructive/20 text-destructive'
                    }`}>
                      <span className="text-2xl font-bold">{trustScore?.score}</span>
                    </div>
                    <div>
                      <h3 className="text-lg font-semibold">Model Trust Score</h3>
                      <p className="text-sm text-muted-foreground">
                        Based on mechanical invariants and steady-state checks
                      </p>
                    </div>
                  </div>
                  
                  <div className="flex flex-wrap gap-2">
                    {trustScore?.passes.map((pass, i) => (
                      <Badge key={i} variant="outline" className="border-success/50 text-success">
                        <CheckCircle className="mr-1 h-3 w-3" />
                        {pass}
                      </Badge>
                    ))}
                    {trustScore?.issues.map((issue, i) => (
                      <Badge key={i} variant="outline" className="border-destructive/50 text-destructive">
                        <XCircle className="mr-1 h-3 w-3" />
                        {issue}
                      </Badge>
                    ))}
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Key Metrics Grid */}
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">Expected Monthly Profit</CardTitle>
                  {result.profit.mean >= 0 ? (
                    <TrendingUp className="h-4 w-4 text-success" />
                  ) : (
                    <TrendingDown className="h-4 w-4 text-destructive" />
                  )}
                </CardHeader>
                <CardContent>
                  <div className={`text-2xl font-bold ${result.profit.mean >= 0 ? 'text-success' : 'text-destructive'}`}>
                    ${result.profit.mean.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    P5: ${result.profit.p5.toLocaleString()} / P95: ${result.profit.p95.toLocaleString()}
                  </p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">Loss Probability</CardTitle>
                  <AlertTriangle className={`h-4 w-4 ${result.risk.probabilityOfLoss > 0.3 ? 'text-destructive' : 'text-muted-foreground'}`} />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">
                    {(result.risk.probabilityOfLoss * 100).toFixed(1)}%
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Chance of negative month
                  </p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">Cap Binding Rate</CardTitle>
                  <Target className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">
                    {(result.payoutDiagnostics.lifetimeCapBindingRate * 100).toFixed(1)}%
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Pressure: {result.payoutDiagnostics.capPressure !== null 
                      ? `${(result.payoutDiagnostics.capPressure * 100).toFixed(0)}%` 
                      : 'N/A'}
                  </p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">Reset Accuracy</CardTitle>
                  <Activity className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">
                    {((1 - Math.abs(result.cohortDiagnostics.resetRateErrorRatio - 1)) * 100).toFixed(0)}%
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Error ratio: {result.cohortDiagnostics.resetRateErrorRatio.toFixed(3)}
                  </p>
                </CardContent>
              </Card>
            </div>

            {/* Charts */}
            <Tabs defaultValue="server" className="space-y-4">
              <TabsList>
                <TabsTrigger value="server">Server Simulation</TabsTrigger>
                <TabsTrigger value="profit">Profit Distribution</TabsTrigger>
                <TabsTrigger value="cohort">Cohort Dynamics</TabsTrigger>
                <TabsTrigger value="ratio">Payout/Revenue</TabsTrigger>
                <TabsTrigger value="diagnostics">Diagnostics</TabsTrigger>
              </TabsList>
              
              <TabsContent value="server">
                <ServerSimulationPanel />
              </TabsContent>
              
              <TabsContent value="profit">
                <Card>
                  <CardHeader>
                    <CardTitle>Monthly Profit Distribution</CardTitle>
                    <CardDescription>
                      Histogram of simulated monthly profits across {result.config.iterations} iterations
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <ChartContainer config={profitChartConfig} className="h-[350px]">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={profitDistributionData}>
                          <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                          <XAxis 
                            dataKey="bucket" 
                            tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`}
                            className="text-xs"
                          />
                          <YAxis className="text-xs" />
                          <ChartTooltip 
                            content={<ChartTooltipContent />}
                            formatter={(value, name, props) => [
                              `${value} months`,
                              `$${props.payload.bucket.toLocaleString()}`
                            ]}
                          />
                          <ReferenceLine x={0} stroke="hsl(var(--muted-foreground))" strokeDasharray="5 5" />
                          <Bar 
                            dataKey="count" 
                            fill="hsl(var(--chart-1))"
                            radius={[4, 4, 0, 0]}
                          />
                        </BarChart>
                      </ResponsiveContainer>
                    </ChartContainer>
                    
                    <div className="mt-4 grid grid-cols-3 gap-4 text-center">
                      <div className="rounded-lg bg-muted p-3">
                        <div className="text-sm text-muted-foreground">P5 (Bad Month)</div>
                        <div className="text-lg font-semibold text-destructive">
                          ${result.profit.p5.toLocaleString()}
                        </div>
                      </div>
                      <div className="rounded-lg bg-muted p-3">
                        <div className="text-sm text-muted-foreground">P50 (Median)</div>
                        <div className="text-lg font-semibold">
                          ${result.profit.p50.toLocaleString()}
                        </div>
                      </div>
                      <div className="rounded-lg bg-muted p-3">
                        <div className="text-sm text-muted-foreground">P95 (Good Month)</div>
                        <div className="text-lg font-semibold text-success">
                          ${result.profit.p95.toLocaleString()}
                        </div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </TabsContent>
              
              <TabsContent value="cohort">
                <Card>
                  <CardHeader>
                    <CardTitle>Cohort Size Over Time</CardTitle>
                    <CardDescription>
                      Active vs eligible accounts showing steady-state convergence
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <ChartContainer config={cohortChartConfig} className="h-[350px]">
                      <ResponsiveContainer width="100%" height="100%">
                        <AreaChart data={cohortTimeSeriesData}>
                          <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                          <XAxis 
                            dataKey="month" 
                            tickFormatter={(v) => `M${v}`}
                            className="text-xs"
                          />
                          <YAxis className="text-xs" />
                          <ChartTooltip content={<ChartTooltipContent />} />
                          <Area 
                            type="monotone" 
                            dataKey="active" 
                            stackId="1"
                            stroke="hsl(var(--chart-2))" 
                            fill="hsl(var(--chart-2))"
                            fillOpacity={0.3}
                          />
                          <Area 
                            type="monotone" 
                            dataKey="eligible" 
                            stackId="2"
                            stroke="hsl(var(--chart-3))" 
                            fill="hsl(var(--chart-3))"
                            fillOpacity={0.5}
                          />
                        </AreaChart>
                      </ResponsiveContainer>
                    </ChartContainer>
                    
                    <div className="mt-4 grid grid-cols-2 gap-4 text-center">
                      <div className="rounded-lg bg-muted p-3">
                        <div className="text-sm text-muted-foreground">Avg Active Cohort</div>
                        <div className="text-lg font-semibold">
                          {result.cohortDiagnostics.avgActiveCohortSize.toFixed(0)} accounts
                        </div>
                      </div>
                      <div className="rounded-lg bg-muted p-3">
                        <div className="text-sm text-muted-foreground">Avg Eligible Cohort</div>
                        <div className="text-lg font-semibold">
                          {result.cohortDiagnostics.avgEligibleCohortSize.toFixed(0)} accounts
                        </div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </TabsContent>
              
              <TabsContent value="ratio">
                <Card>
                  <CardHeader>
                    <CardTitle>Payout-to-Revenue Ratio</CardTitle>
                    <CardDescription>
                      Key profitability indicator — should stabilize below 100%
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <ChartContainer config={ratioChartConfig} className="h-[350px]">
                      <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={payoutRatioData}>
                          <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                          <XAxis 
                            dataKey="month" 
                            tickFormatter={(v) => `M${v}`}
                            className="text-xs"
                          />
                          <YAxis 
                            domain={[0, 'auto']}
                            tickFormatter={(v) => `${v}%`}
                            className="text-xs"
                          />
                          <ChartTooltip 
                            content={<ChartTooltipContent />}
                            formatter={(value) => [`${Number(value).toFixed(1)}%`, 'Ratio']}
                          />
                          <ReferenceLine y={100} stroke="hsl(var(--destructive))" strokeDasharray="5 5" label="Break-even" />
                          <Line 
                            type="monotone" 
                            dataKey="ratio" 
                            stroke="hsl(var(--chart-4))" 
                            strokeWidth={2}
                            dot={false}
                          />
                        </LineChart>
                      </ResponsiveContainer>
                    </ChartContainer>
                    
                    <div className="mt-4 flex items-center justify-center gap-2 text-sm text-muted-foreground">
                      <Info className="h-4 w-4" />
                      Values above 100% indicate payout obligations exceed revenue
                    </div>
                  </CardContent>
                </Card>
              </TabsContent>
              
              <TabsContent value="diagnostics">
                <div className="grid gap-4 lg:grid-cols-2">
                  <Card>
                    <CardHeader>
                      <CardTitle>Payout Diagnostics</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <div className="space-y-4">
                        <div className="flex justify-between border-b pb-2">
                          <span className="text-muted-foreground">Avg Lifetime Paid</span>
                          <span className="font-medium">${result.payoutDiagnostics.avgLifetimePaidPerAccount.toFixed(2)}</span>
                        </div>
                        <div className="flex justify-between border-b pb-2">
                          <span className="text-muted-foreground">Lifetime Paid P95</span>
                          <span className="font-medium">${result.payoutDiagnostics.lifetimePaidP95.toFixed(2)}</span>
                        </div>
                        <div className="flex justify-between border-b pb-2">
                          <span className="text-muted-foreground">Payouts Clipped by Cap</span>
                          <span className="font-medium">{result.payoutDiagnostics.payoutsClippedByLifetimeCap}</span>
                        </div>
                        <div className="flex justify-between border-b pb-2">
                          <span className="text-muted-foreground">Avg Clipped Amount</span>
                          <span className="font-medium">${result.payoutDiagnostics.avgClippedAmount.toFixed(2)}</span>
                        </div>
                        <div className="flex justify-between border-b pb-2">
                          <span className="text-muted-foreground">Cap Pressure</span>
                          <span className="font-medium">
                            {result.payoutDiagnostics.capPressure !== null 
                              ? `${(result.payoutDiagnostics.capPressure * 100).toFixed(1)}%`
                              : 'N/A (no cap)'}
                          </span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">First Payout Cap Binding</span>
                          <span className="font-medium">{(result.payoutDiagnostics.firstPayoutCapBindingRate * 100).toFixed(1)}%</span>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                  
                  <Card>
                    <CardHeader>
                      <CardTitle>Model Accuracy</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <div className="space-y-4">
                        <div className="flex justify-between border-b pb-2">
                          <span className="text-muted-foreground">Reset Error Ratio</span>
                          <span className={`font-medium ${
                            Math.abs(result.cohortDiagnostics.resetRateErrorRatio - 1) < 0.1 
                              ? 'text-success' 
                              : 'text-warning'
                          }`}>
                            {result.cohortDiagnostics.resetRateErrorRatio.toFixed(4)}
                          </span>
                        </div>
                        <div className="flex justify-between border-b pb-2">
                          <span className="text-muted-foreground">Expected Resets (Run)</span>
                          <span className="font-medium">{result.cohortDiagnostics.expectedResetsThisRun.toFixed(0)}</span>
                        </div>
                        <div className="flex justify-between border-b pb-2">
                          <span className="text-muted-foreground">Observed Resets (Run)</span>
                          <span className="font-medium">{result.cohortDiagnostics.resetsThisRun}</span>
                        </div>
                        <div className="flex justify-between border-b pb-2">
                          <span className="text-muted-foreground">Zombie Accounts Completed</span>
                          <span className="font-medium">{result.cohortDiagnostics.zombieAccountsCompleted}</span>
                        </div>
                        <div className="flex justify-between border-b pb-2">
                          <span className="text-muted-foreground">Accounts Completed by Cap</span>
                          <span className="font-medium">{result.payoutDiagnostics.accountsCompletedByCap}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Cap-Hit Share of Completions</span>
                          <span className="font-medium">
                            {(result.cohortDiagnostics.capHitShareOfCompletions * 100).toFixed(1)}%
                          </span>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                </div>
              </TabsContent>
            </Tabs>

            {/* Scenario Comparison */}
            <Card>
              <CardHeader>
                <CardTitle>Quick Scenario Reference</CardTitle>
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
                        <th className="py-2 text-right font-medium">Binding Rate</th>
                        <th className="py-2 text-right font-medium">Risk Level</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr className="border-b">
                        <td className="py-2">No Cap (Baseline)</td>
                        <td className="py-2 text-right">Unlimited</td>
                        <td className="py-2 text-right text-destructive">-33%</td>
                        <td className="py-2 text-right">0%</td>
                        <td className="py-2 text-right"><Badge variant="destructive">Critical</Badge></td>
                      </tr>
                      <tr className="border-b">
                        <td className="py-2">8× Cap (Breakeven)</td>
                        <td className="py-2 text-right">$1,192</td>
                        <td className="py-2 text-right text-warning">~0%</td>
                        <td className="py-2 text-right">~45%</td>
                        <td className="py-2 text-right"><Badge variant="secondary">Neutral</Badge></td>
                      </tr>
                      <tr className="border-b bg-muted/50">
                        <td className="py-2 font-medium">7× Cap (Recommended)</td>
                        <td className="py-2 text-right font-medium">$1,043</td>
                        <td className="py-2 text-right font-medium text-success">+6.8%</td>
                        <td className="py-2 text-right font-medium">~54%</td>
                        <td className="py-2 text-right"><Badge className="bg-success text-success-foreground">Safe</Badge></td>
                      </tr>
                      <tr className="border-b">
                        <td className="py-2">5× Cap (Conservative)</td>
                        <td className="py-2 text-right">$745</td>
                        <td className="py-2 text-right text-success">+15%</td>
                        <td className="py-2 text-right">~70%</td>
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
                Run a simulation to see profit distributions, cohort dynamics, and trust metrics.
              </p>
              <Button onClick={runSimulation} disabled={isRunning}>
                <Play className="mr-2 h-4 w-4" />
                Run First Simulation
              </Button>
            </CardContent>
          </Card>
        )}
      </div>
    </DashboardLayout>
  );
}
