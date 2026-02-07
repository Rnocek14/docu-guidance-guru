import { useMemo } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, ResponsiveContainer, ReferenceLine, Cell,
} from 'recharts';
import { ChartContainer, ChartTooltip, ChartTooltipContent, ChartConfig } from '@/components/ui/chart';
import { AlertTriangle, TrendingUp, Clock, Target } from 'lucide-react';
import type { SimOverrides } from './SimulationControls';

interface SimResults {
  profit: { mean: number; p5: number; p50: number; p95: number; stdDev: number };
  risk: { probabilityOfLoss: number; maxDrawdown: number; worstMonth: number; bestMonth: number; consecutiveLossMonths: number };
  reserve: { breachProbability: number; threshold: number };
  annual: { p5: number; p50: number; p95: number; lossProb: number; mean: number };
  monthlyBands: { p5: number; p50: number; p95: number; mean: number }[];
  histogram: { bucket: number; count: number }[];
  diagnostics: { avgPayoutsPerAccount: number; lifetimeCapHitRate: number };
}

const waterfallConfig: ChartConfig = {
  value: { label: 'Amount', color: 'hsl(var(--chart-1))' },
};

interface Props {
  results: SimResults;
  overrides: SimOverrides;
}

export function RiskReportTab({ results, overrides }: Props) {
  const fmt = (v: number) => '$' + v.toLocaleString(undefined, { maximumFractionDigits: 0 });

  const metrics = useMemo(() => {
    const { monthlyBands } = results;
    const months = monthlyBands.length;

    // Breakeven: accounts/mo needed at current cost structure
    // Revenue per account = entryFee, net cost = fixedCosts + variable
    // Simplified: breakeven where revenue covers costs + avg payouts
    const avgMonthlyPayout = results.annual.mean < 0
      ? Math.abs(results.profit.mean) + overrides.fixedMonthlyCosts
      : overrides.fixedMonthlyCosts;
    const revenuePerAccount = overrides.entryFee;
    const breakeven = Math.ceil(avgMonthlyPayout / Math.max(1, revenuePerAccount));

    // Months to insolvency at P5
    const p5Last = monthlyBands[months - 1]?.p5 ?? 0;
    const monthsToInsolvency = p5Last < 0
      ? Math.max(1, Math.ceil(overrides.reserveThreshold / Math.abs(p5Last)))
      : Infinity;

    // Steady-state month: first month where P50 cumulative < 0
    let cumulativeP50 = 0;
    let steadyStateMonth: number | null = null;
    for (let i = 0; i < months; i++) {
      cumulativeP50 += monthlyBands[i].p50;
      if (cumulativeP50 < 0 && steadyStateMonth === null) {
        steadyStateMonth = i + 1;
      }
    }

    // Waterfall P&L approximation
    const totalRevenue = overrides.accountsPerMonth * overrides.entryFee * months;
    const totalCosts = overrides.fixedMonthlyCosts * months;
    const totalNetProfit = results.annual.mean;
    const totalPayoutsAndFraud = totalRevenue - totalCosts - totalNetProfit;
    // Split payouts vs fraud estimate (fraud ~5-10% of payouts based on sim rates)
    const estFraudShare = 0.08;
    const estFraud = totalPayoutsAndFraud * estFraudShare;
    const estPayouts = totalPayoutsAndFraud * (1 - estFraudShare);

    const waterfall = [
      { name: 'Revenue', value: totalRevenue, color: 'hsl(var(--chart-3))' },
      { name: 'Costs', value: -totalCosts, color: 'hsl(var(--destructive))' },
      { name: 'Payouts', value: -estPayouts, color: 'hsl(var(--chart-4))' },
      { name: 'Fraud/CB', value: -estFraud, color: 'hsl(var(--destructive))' },
      { name: 'Net', value: totalNetProfit, color: totalNetProfit >= 0 ? 'hsl(var(--chart-3))' : 'hsl(var(--destructive))' },
    ];

    return { breakeven, monthsToInsolvency, steadyStateMonth, waterfall };
  }, [results, overrides]);

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {/* Key Risk Metrics */}
      <Card>
        <CardHeader>
          <CardTitle>Risk Metrics</CardTitle>
          <CardDescription>Derived from simulation results at your current parameters</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <MetricRow
            icon={<Target className="h-4 w-4 text-primary" />}
            label="Breakeven Accounts / Month"
            value={metrics.breakeven.toLocaleString()}
            badge={
              overrides.accountsPerMonth >= metrics.breakeven
                ? <Badge className="bg-success text-success-foreground">Above</Badge>
                : <Badge variant="destructive">Below</Badge>
            }
            detail={`You're running ${overrides.accountsPerMonth}/mo — ${overrides.accountsPerMonth >= metrics.breakeven ? 'above' : 'below'} breakeven`}
          />
          <MetricRow
            icon={<Clock className="h-4 w-4 text-warning" />}
            label="Months to Insolvency (P5)"
            value={metrics.monthsToInsolvency === Infinity ? '∞' : `${metrics.monthsToInsolvency} mo`}
            badge={
              metrics.monthsToInsolvency > 12
                ? <Badge className="bg-success text-success-foreground">Safe</Badge>
                : metrics.monthsToInsolvency > 6
                  ? <Badge variant="secondary">Watch</Badge>
                  : <Badge variant="destructive">Danger</Badge>
            }
            detail="How long reserve lasts at worst-case (P5) monthly losses"
          />
          <MetricRow
            icon={<TrendingUp className="h-4 w-4 text-chart-1" />}
            label="Margin Compression Month"
            value={metrics.steadyStateMonth ? `Month ${metrics.steadyStateMonth}` : 'None'}
            badge={
              metrics.steadyStateMonth === null
                ? <Badge className="bg-success text-success-foreground">Stable</Badge>
                : <Badge variant="destructive">Compresses</Badge>
            }
            detail="First month where cumulative P50 goes negative"
          />
          <MetricRow
            icon={<AlertTriangle className="h-4 w-4 text-destructive" />}
            label="Consecutive Loss Months"
            value={results.risk.consecutiveLossMonths.toString()}
            badge={
              results.risk.consecutiveLossMonths <= 2
                ? <Badge className="bg-success text-success-foreground">Low</Badge>
                : <Badge variant="destructive">High</Badge>
            }
            detail="Longest consecutive losing streak across all iterations"
          />
        </CardContent>
      </Card>

      {/* Waterfall */}
      <Card>
        <CardHeader>
          <CardTitle>Cumulative P&L Waterfall</CardTitle>
          <CardDescription>
            Revenue vs Costs vs Payouts over {overrides.horizon} months
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ChartContainer config={waterfallConfig} className="h-[280px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={metrics.waterfall}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis dataKey="name" className="text-xs" />
                <YAxis tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`} className="text-xs" />
                <ChartTooltip
                  content={<ChartTooltipContent />}
                  formatter={(value) => [fmt(Number(value)), '']}
                />
                <ReferenceLine y={0} stroke="hsl(var(--muted-foreground))" strokeDasharray="5 5" />
                <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                  {metrics.waterfall.map((entry, i) => (
                    <Cell key={i} fill={entry.color} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </ChartContainer>
        </CardContent>
      </Card>
    </div>
  );
}

function MetricRow({ icon, label, value, badge, detail }: {
  icon: React.ReactNode; label: string; value: string; badge: React.ReactNode; detail: string;
}) {
  return (
    <div className="flex items-start gap-3 border-b pb-3 last:border-0 last:pb-0">
      <div className="mt-0.5">{icon}</div>
      <div className="flex-1">
        <div className="flex items-center justify-between">
          <span className="font-medium">{label}</span>
          <div className="flex items-center gap-2">
            <span className="text-lg font-bold">{value}</span>
            {badge}
          </div>
        </div>
        <p className="text-xs text-muted-foreground">{detail}</p>
      </div>
    </div>
  );
}
