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
  fullDate: string;
  iso: string;
  balance: number;
  symbol?: string;
  side?: string;
  pnl?: number;
  quantity?: number;
  // Rule event markers
  event?: string;
}

interface EquityCurveChartProps {
  accountId: string;
  startingBalance: number;
  maxDrawdownPct?: number;
  profitTargetPct?: number;
  minTradingDays?: number;
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
          {point.symbol} · {point.side} · {point.quantity} ct{Number(point.quantity) !== 1 ? 's' : ''}
        </div>
      )}
      {point.event && (
        <div className="text-primary font-medium mt-1 border-t border-border/50 pt-1">
          ⚡ {point.event}
        </div>
      )}
      <div className="text-muted-foreground/60 mt-0.5" title={point.iso}>
        {point.fullDate || point.date}
      </div>
    </div>
  );
}

// Custom dot renderer for rule events
function EventDot(props: Record<string, unknown>) {
  const { cx, cy, payload } = props as { cx: number; cy: number; payload: TradePoint };
  if (!payload?.event) return null;
  return (
    <g>
      <circle cx={cx} cy={cy} r={6} fill="hsl(var(--primary))" fillOpacity={0.2} stroke="hsl(var(--primary))" strokeWidth={1.5} />
      <circle cx={cx} cy={cy} r={2.5} fill="hsl(var(--primary))" />
    </g>
  );
}

export function EquityCurveChart({ accountId, startingBalance, maxDrawdownPct = 10, profitTargetPct = 10, minTradingDays = 5 }: EquityCurveChartProps) {
  const { data: trades, dataUpdatedAt } = useQuery({
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

    const points: TradePoint[] = [{ date: 'Start', fullDate: '', iso: '', balance: startingBalance }];
    let cumulative = startingBalance;
    let peakBalance = startingBalance;
    let drawdown50Fired = false;
    let drawdown70Fired = false;
    let targetWithin1Fired = false;
    let targetReachedFired = false;
    let minDaysFired = false;

    // Track unique trading days for min-days event
    const tradingDays = new Set<string>();

    trades.forEach((trade) => {
      const pnl = Number(trade.pnl);
      cumulative += pnl;
      peakBalance = Math.max(peakBalance, cumulative);
      const closedDate = new Date(trade.closed_at!);
      const dayKey = format(closedDate, 'yyyy-MM-dd');
      tradingDays.add(dayKey);

      // Compute rule events
      const events: string[] = [];
      const drawdownPct = peakBalance > 0 ? ((peakBalance - cumulative) / peakBalance) * 100 : 0;
      const drawdownUsage = (drawdownPct / maxDrawdownPct) * 100;
      const returnPct = ((cumulative - startingBalance) / startingBalance) * 100;

      if (!drawdown50Fired && drawdownUsage >= 50) {
        events.push('Drawdown at 50% of limit');
        drawdown50Fired = true;
      }
      if (!drawdown70Fired && drawdownUsage >= 70) {
        events.push('Drawdown at 70% of limit');
        drawdown70Fired = true;
      }
      if (!minDaysFired && tradingDays.size >= minTradingDays) {
        events.push(`${minTradingDays} trading days reached`);
        minDaysFired = true;
      }
      if (!targetWithin1Fired && returnPct >= profitTargetPct - 1 && returnPct < profitTargetPct) {
        events.push('Within 1% of profit target');
        targetWithin1Fired = true;
      }
      if (!targetReachedFired && returnPct >= profitTargetPct) {
        events.push('Profit target reached');
        targetReachedFired = true;
      }

      points.push({
        date: format(closedDate, 'MMM d'),
        fullDate: format(closedDate, 'MMM d, h:mma'),
        iso: trade.closed_at!,
        balance: Math.round(cumulative * 100) / 100,
        symbol: trade.symbol,
        side: trade.side === 'buy' ? 'Buy' : 'Sell',
        pnl,
        quantity: Number(trade.quantity),
        event: events.length > 0 ? events.join(' · ') : undefined,
      });
    });

    return points;
  }, [trades, startingBalance, maxDrawdownPct, profitTargetPct, minTradingDays]);

  if (!chartData.length) return null;

  const currentBalance = chartData[chartData.length - 1]?.balance ?? startingBalance;
  const totalReturn = ((currentBalance - startingBalance) / startingBalance) * 100;

  const lastUpdatedLabel = dataUpdatedAt
    ? (() => {
        const diffMs = Date.now() - dataUpdatedAt;
        if (diffMs < 60_000) return 'Checked just now';
        const mins = Math.floor(diffMs / 60_000);
        return `Checked ${mins}m ago`;
      })()
    : null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2 text-lg">
              <TrendingUp className="h-5 w-5 text-primary" />
              Equity Curve
            </CardTitle>
            <CardDescription>Cumulative balance — each point is a closed trade</CardDescription>
          </div>
          <div className="text-right">
            <div className="text-2xl font-bold">${currentBalance.toLocaleString()}</div>
            <div className={`text-sm font-medium ${totalReturn >= 0 ? 'text-success' : 'text-destructive'}`}>
              {totalReturn >= 0 ? '+' : ''}{totalReturn.toFixed(2)}%
            </div>
            {lastUpdatedLabel && (
              <div className="text-[10px] text-muted-foreground/50 mt-0.5">{lastUpdatedLabel}</div>
            )}
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
              domain={[
                (min: number) => min - 500,
                (max: number) => max + 500,
              ]}
            />
            <Tooltip
              content={<CustomTooltip />}
              cursor={{ stroke: 'hsl(var(--muted-foreground))', strokeWidth: 1, strokeDasharray: '4 4' }}
            />
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
              dot={<EventDot />}
              activeDot={{ r: 4, strokeWidth: 2, stroke: 'hsl(var(--primary))', fill: 'hsl(var(--background))' }}
            />
          </AreaChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}
