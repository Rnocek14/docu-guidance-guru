import { DashboardLayout, traderNavItems } from '@/components/layout/DashboardLayout';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/integrations/supabase/client';
import { useQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import { TrendingUp, TrendingDown } from 'lucide-react';

interface Trade {
  id: string;
  symbol: string;
  side: string;
  quantity: number;
  entry_price: number;
  exit_price: number | null;
  pnl: number | null;
  opened_at: string;
  closed_at: string | null;
  status: string;
  account: {
    account_number: string;
  };
}

export default function TraderTrades() {
  const { user } = useAuth();

  const { data: trades, isLoading } = useQuery({
    queryKey: ['trader-trades', user?.id],
    queryFn: async () => {
      // First get user's account IDs
      const { data: accounts } = await supabase
        .from('accounts')
        .select('id, account_number')
        .eq('user_id', user?.id);

      if (!accounts?.length) return [];

      const accountIds = accounts.map((a) => a.id);
      const accountMap = Object.fromEntries(accounts.map((a) => [a.id, a.account_number]));

      const { data, error } = await supabase
        .from('trades')
        .select('*')
        .in('account_id', accountIds)
        .order('opened_at', { ascending: false })
        .limit(100);

      if (error) throw error;

      return (data || []).map((t) => ({
        ...t,
        account: { account_number: accountMap[t.account_id] || 'Unknown' },
      })) as Trade[];
    },
    enabled: !!user?.id,
  });

  return (
    <DashboardLayout title="My Trades" navItems={traderNavItems}>
      <div className="space-y-6">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Trade History</h2>
          <p className="text-muted-foreground">
            View all trades across your accounts.
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Recent Trades</CardTitle>
            <CardDescription>
              Showing up to 100 most recent trades
            </CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="space-y-2">
                {[1, 2, 3, 4, 5].map((i) => (
                  <div key={i} className="h-12 bg-muted animate-pulse rounded" />
                ))}
              </div>
            ) : trades?.length ? (
              <div className="rounded-md border overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Account</TableHead>
                      <TableHead>Symbol</TableHead>
                      <TableHead>Side</TableHead>
                      <TableHead className="text-right">Qty</TableHead>
                      <TableHead className="text-right">Entry</TableHead>
                      <TableHead className="text-right">Exit</TableHead>
                      <TableHead className="text-right">P&L</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Opened</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {trades.map((trade) => (
                      <TableRow key={trade.id}>
                        <TableCell className="font-mono text-xs">
                          #{trade.account.account_number}
                        </TableCell>
                        <TableCell className="font-medium">{trade.symbol}</TableCell>
                        <TableCell>
                          <Badge variant={trade.side === 'buy' ? 'default' : 'secondary'}>
                            {trade.side.toUpperCase()}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right">{trade.quantity}</TableCell>
                        <TableCell className="text-right">
                          ${Number(trade.entry_price).toFixed(2)}
                        </TableCell>
                        <TableCell className="text-right">
                          {trade.exit_price ? `$${Number(trade.exit_price).toFixed(2)}` : '-'}
                        </TableCell>
                        <TableCell className="text-right">
                          {trade.pnl !== null ? (
                            <span className={`flex items-center justify-end gap-1 ${trade.pnl >= 0 ? 'text-success' : 'text-destructive'}`}>
                              {trade.pnl >= 0 ? (
                                <TrendingUp className="h-3 w-3" />
                              ) : (
                                <TrendingDown className="h-3 w-3" />
                              )}
                              {trade.pnl >= 0 ? '+' : ''}${Number(trade.pnl).toFixed(2)}
                            </span>
                          ) : (
                            '-'
                          )}
                        </TableCell>
                        <TableCell>
                          <Badge variant={trade.status === 'closed' ? 'secondary' : 'outline'}>
                            {trade.status}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-muted-foreground text-xs">
                          {format(new Date(trade.opened_at), 'MMM d, HH:mm')}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <p className="text-muted-foreground text-center py-8">
                No trades yet. Start trading to see your history here.
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}
