import { useState } from 'react';
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
import { AccountFilter } from '@/components/trader/AccountFilter';
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from '@/components/ui/pagination';

const PAGE_SIZE = 50;

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
  account_id: string;
  account: {
    account_number: string;
  };
}

export default function TraderTrades() {
  const { user } = useAuth();
  const [filterAccountId, setFilterAccountId] = useState('all');
  const [page, setPage] = useState(0);

  // Fetch accounts for the filter
  const { data: accounts } = useQuery({
    queryKey: ['trader-accounts-filter', user?.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('accounts')
        .select('id, account_number, status, cohort:cohorts(cohort_phase)')
        .eq('user_id', user?.id)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return (data || []).map((a: any) => ({
        id: a.id,
        account_number: a.account_number,
        status: a.status,
        cohort_phase: a.cohort?.cohort_phase,
      }));
    },
    enabled: !!user?.id,
  });

  const { data: tradesData, isLoading } = useQuery({
    queryKey: ['trader-trades', user?.id, filterAccountId, page],
    queryFn: async () => {
      const { data: accts } = await supabase
        .from('accounts')
        .select('id, account_number')
        .eq('user_id', user?.id);

      if (!accts?.length) return { trades: [] as Trade[], total: 0 };

      const accountIds = filterAccountId === 'all'
        ? accts.map((a) => a.id)
        : [filterAccountId];
      const accountMap = Object.fromEntries(accts.map((a) => [a.id, a.account_number]));

      const from = page * PAGE_SIZE;
      const to = from + PAGE_SIZE - 1;

      const { data, error, count } = await supabase
        .from('trades')
        .select('*', { count: 'exact' })
        .in('account_id', accountIds)
        .order('opened_at', { ascending: false })
        .range(from, to);

      if (error) throw error;

      const trades = (data || []).map((t) => ({
        ...t,
        account: { account_number: accountMap[t.account_id] || 'Unknown' },
      })) as Trade[];

      return { trades, total: count || 0 };
    },
    enabled: !!user?.id,
  });

  const trades = tradesData?.trades;
  const totalPages = Math.ceil((tradesData?.total || 0) / PAGE_SIZE);

  const handleFilterChange = (val: string) => {
    setFilterAccountId(val);
    setPage(0);
  };

  return (
    <DashboardLayout title="My Trades" navItems={traderNavItems}>
      <div className="space-y-6">
        <div className="flex items-center justify-between flex-wrap gap-4">
          <div>
            <h2 className="text-2xl font-bold tracking-tight">Trade History</h2>
            <p className="text-muted-foreground">
              View all trades across your accounts.
            </p>
          </div>
          <AccountFilter
            accounts={accounts || []}
            value={filterAccountId}
            onChange={handleFilterChange}
          />
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Trade History</CardTitle>
            <CardDescription>
              {tradesData?.total ? `${tradesData.total} trades · Page ${page + 1} of ${totalPages}` : 'No trades found'}
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
              <>
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
                {totalPages > 1 && (
                  <Pagination className="mt-4">
                    <PaginationContent>
                      <PaginationItem>
                        <PaginationPrevious
                          onClick={() => setPage((p) => Math.max(0, p - 1))}
                          className={page === 0 ? 'pointer-events-none opacity-50' : 'cursor-pointer'}
                        />
                      </PaginationItem>
                      {Array.from({ length: Math.min(totalPages, 5) }, (_, i) => {
                        const start = Math.max(0, Math.min(page - 2, totalPages - 5));
                        const pageNum = start + i;
                        if (pageNum >= totalPages) return null;
                        return (
                          <PaginationItem key={pageNum}>
                            <PaginationLink
                              isActive={pageNum === page}
                              onClick={() => setPage(pageNum)}
                              className="cursor-pointer"
                            >
                              {pageNum + 1}
                            </PaginationLink>
                          </PaginationItem>
                        );
                      })}
                      <PaginationItem>
                        <PaginationNext
                          onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                          className={page >= totalPages - 1 ? 'pointer-events-none opacity-50' : 'cursor-pointer'}
                        />
                      </PaginationItem>
                    </PaginationContent>
                  </Pagination>
                )}
              </>
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
