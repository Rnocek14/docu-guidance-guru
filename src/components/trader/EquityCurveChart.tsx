import { useMemo } from 'react';
import { Area, AreaChart, CartesianGrid, ReferenceLine, XAxis, YAxis, Tooltip } from 'recharts';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ChartContainer } from '@/components/ui/chart';
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

interface TradePoint {
  date: string;
  balance: number;
  symbol?: string;
  side?: string;
  pnl?: number;
  quantity?: number;
}

interface EquityCurveChartProps {
  accountId: string;
  startingBalance: number;
}

function CustomTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload: TradePoint }> }) {
  if (!active || !payload?.length) return null;
  const point = payload[0].payload;

  return (
    <div className="rounded-lg border border-border/50 bg-background px-3 py-2 text-xs shadow-xl">
      <div className="font-medium text-foreground">${point.balance.toLocaleString()}</div>
      {point.pnl !== undefined && (
        <div className={`font-mono ${point.pnl >= 0 ? 'text-success' : 'text-destructive'}`}>
          {point.pnl >= 0 ? '+' : ''}{point.pnl.toLocaleString()} P&L
        </div>
      )}
      {point.symbol && (
        <div className="text-muted-foreground mt-0.5">
          {point.symbol} {point.side} × {point.quantity}
        </div>
      )}
      <div className="text-muted-foreground/60">{point.date}</div>
    </div>
  );
}

export function EquityCurveChart({ accountId, startingBalance }: EquityCurveChartProps) {
  const { data: trades } = useQuery({
    queryKey: ['equity-curve-trades', accountId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('trades')
        .select('pnl, closed_at, symbol, side, quantity')
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

    const points: TradePoint[] = [{ date: 'Start', balance: startingBalance }];
    let cumulative = startingBalance;

    trades.forEach((trade) => {
      const pnl = Number(trade.pnl);
      cumulative += pnl;
      points.push({
        date: format(new Date(trade.closed_at!), 'MMM d'),
        balance: Math.round(cumulative * 100) / 100,
        symbol: trade.symbol,
        side: trade.side === 'buy' ? 'Long' : 'Short',
        pnl,
        quantity: Number(trade.quantity),
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
            <CardDescription>Cumulative balance — hover for trade details</CardDescription>
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
            <Tooltip content={<CustomTooltip />} />
            <ReferenceLine
              y={startingBalance}
              stroke="hsl(var(--muted-foreground))"
              strokeDasharray="4 4"
              strokeOpacity={0.5}
              label={{ value: 'Start', position: 'left', fill: 'hsl(var(--muted-foreground))', fontSize: 11 }}
            />
            <Area
              type="monotone"
              dataKey="balance"
              stroke="hsl(var(--primary))"
              strokeWidth={2}
              fill="url(#equityGradient)"
              dot={false}
              activeDot={{ r: 4, strokeWidth: 2, stroke: 'hsl(var(--primary))', fill: 'hsl(var(--background))' }}
            />
          </AreaChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}
