import { useMemo } from 'react';
import { Area, AreaChart, CartesianGrid, ReferenceLine, XAxis, YAxis } from 'recharts';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart';
import { TrendingUp } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useQuery } from '@tanstack/react-query';
import { format } from 'date-fns';

const chartConfig = {
  balance: {
    label: 'Balance',
    color: 'hsl(var(--primary))',
  },
};

interface EquityCurveChartProps {
  accountId: string;
  startingBalance: number;
}

export function EquityCurveChart({ accountId, startingBalance }: EquityCurveChartProps) {
  const { data: trades } = useQuery({
    queryKey: ['equity-curve-trades', accountId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('trades')
        .select('pnl, closed_at')
        .eq('account_id', accountId)
        .eq('status', 'closed')
        .not('closed_at', 'is', null)
        .not('pnl', 'is', null)
        .order('closed_at', { ascending: true });

      if (error) throw error;
      return data;
    },
    enabled: !!accountId,
  });

  const chartData = useMemo(() => {
    if (!trades?.length) return [];

    // Start with starting balance point
    const points = [{ date: 'Start', balance: startingBalance }];
    let cumulative = startingBalance;

    trades.forEach((trade) => {
      cumulative += Number(trade.pnl);
      points.push({
        date: format(new Date(trade.closed_at!), 'MMM d'),
        balance: Math.round(cumulative * 100) / 100,
      });
    });

    return points;
  }, [trades, startingBalance]);

  if (!chartData.length) return null;

  const currentBalance = chartData[chartData.length - 1]?.balance ?? startingBalance;
  const totalReturn = ((currentBalance - startingBalance) / startingBalance) * 100;

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2 text-lg">
              <TrendingUp className="h-5 w-5 text-primary" />
              Equity Curve
            </CardTitle>
            <CardDescription>Cumulative balance over time</CardDescription>
          </div>
          <div className="text-right">
            <div className="text-2xl font-bold">${currentBalance.toLocaleString()}</div>
            <div className={`text-sm font-medium ${totalReturn >= 0 ? 'text-success' : 'text-destructive'}`}>
              {totalReturn >= 0 ? '+' : ''}{totalReturn.toFixed(2)}%
            </div>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <ChartContainer config={chartConfig} className="aspect-[16/6] w-full">
          <AreaChart data={chartData} margin={{ top: 10, right: 10, left: 10, bottom: 0 }}>
            <defs>
              <linearGradient id="equityGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.3} />
                <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" className="stroke-border/50" />
            <XAxis
              dataKey="date"
              tickLine={false}
              axisLine={false}
              tick={{ fontSize: 12 }}
              interval="preserveStartEnd"
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              tick={{ fontSize: 12 }}
              tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`}
              domain={['dataMin - 500', 'dataMax + 500']}
            />
            <ChartTooltip
              content={
                <ChartTooltipContent
                  formatter={(value) => [`$${Number(value).toLocaleString()}`, 'Balance']}
                />
              }
            />
            <ReferenceLine
              y={startingBalance}
              stroke="hsl(var(--muted-foreground))"
              strokeDasharray="4 4"
              strokeOpacity={0.5}
            />
            <Area
              type="monotone"
              dataKey="balance"
              stroke="hsl(var(--primary))"
              strokeWidth={2}
              fill="url(#equityGradient)"
            />
          </AreaChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}
