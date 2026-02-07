import { useMemo } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, ResponsiveContainer, Line,
} from 'recharts';
import { ChartContainer, ChartTooltip, ChartTooltipContent, ChartConfig } from '@/components/ui/chart';
import { Users, UserCheck, UserX, TrendingUp } from 'lucide-react';

interface CohortBand {
  totalAccounts: number;
  eligible: number;
  firstPayout: number;
  capHits: number;
}

interface CustomerGrowthTabProps {
  cohortBands: CohortBand[];
  accountsPerMonth: number;
  horizon: number;
}

const chartConfig: ChartConfig = {
  totalAccounts: { label: 'Total Signups', color: 'hsl(var(--chart-1))' },
  eligible: { label: 'Eligible (Funded)', color: 'hsl(var(--chart-3))' },
  firstPayout: { label: 'Pending First Payout', color: 'hsl(var(--chart-4))' },
  capHits: { label: 'Cap-Hit (Cumulative)', color: 'hsl(var(--destructive))' },
};

export function CustomerGrowthTab({ cohortBands, accountsPerMonth, horizon }: CustomerGrowthTabProps) {
  const chartData = useMemo(() =>
    cohortBands.map((b, i) => ({ month: i + 1, ...b })),
    [cohortBands],
  );

  const totalCustomers = accountsPerMonth * horizon;
  const peakEligible = Math.max(...cohortBands.map(b => b.eligible));
  const finalCapHits = cohortBands[cohortBands.length - 1]?.capHits ?? 0;
  const capHitRate = totalCustomers > 0 ? finalCapHits / totalCustomers : 0;
  const finalEligible = cohortBands[cohortBands.length - 1]?.eligible ?? 0;
  const avgLifetime = peakEligible > 0
    ? cohortBands.reduce((s, b) => s + b.eligible, 0) / totalCustomers
    : 0;

  const stats = [
    { label: 'Total Customers', value: totalCustomers.toLocaleString(), icon: Users, desc: `${accountsPerMonth}/mo × ${horizon} months` },
    { label: 'Peak Eligible Pool', value: peakEligible.toLocaleString(), icon: UserCheck, desc: 'Max funded accounts in any month' },
    { label: 'Cap-Hit Rate', value: `${(capHitRate * 100).toFixed(1)}%`, icon: UserX, desc: `${finalCapHits.toLocaleString()} accounts hit lifetime cap` },
    { label: 'Avg Active Months', value: avgLifetime.toFixed(1), icon: TrendingUp, desc: 'Avg months an account stays eligible' },
  ];

  return (
    <div className="space-y-4">
      {/* Key stats */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {stats.map(({ label, value, icon: Icon, desc }) => (
          <Card key={label}>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">{label}</CardTitle>
              <Icon className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{value}</div>
              <p className="text-xs text-muted-foreground">{desc}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Stacked area chart */}
      <Card>
        <CardHeader>
          <CardTitle>Customer Growth (Median Across Iterations)</CardTitle>
          <CardDescription>
            Monthly pool sizes showing the lifecycle from signup → eligible → cap-hit
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ChartContainer config={chartConfig} className="h-[400px]">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis dataKey="month" tickFormatter={(v) => `M${v}`} className="text-xs" />
                <YAxis className="text-xs" />
                <ChartTooltip content={<ChartTooltipContent />} formatter={(value) => [Number(value).toLocaleString(), '']} />
                <Area type="monotone" dataKey="totalAccounts" stackId="1" stroke="hsl(var(--chart-1))" fill="hsl(var(--chart-1))" fillOpacity={0.15} />
                <Area type="monotone" dataKey="eligible" stackId="2" stroke="hsl(var(--chart-3))" fill="hsl(var(--chart-3))" fillOpacity={0.25} />
                <Area type="monotone" dataKey="firstPayout" stackId="3" stroke="hsl(var(--chart-4))" fill="hsl(var(--chart-4))" fillOpacity={0.2} />
                <Line type="monotone" dataKey="capHits" stroke="hsl(var(--destructive))" strokeWidth={2} dot={false} />
              </AreaChart>
            </ResponsiveContainer>
          </ChartContainer>
        </CardContent>
      </Card>
    </div>
  );
}
