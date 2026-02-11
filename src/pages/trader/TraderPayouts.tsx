import { useState, useEffect, useRef } from 'react';
import { track } from '@/lib/track';
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
import { DollarSign, Clock, CheckCircle, XCircle, Loader2, ChevronDown, ChevronUp } from 'lucide-react';
import { isTerminalPaid, IN_PROGRESS_PAYOUT_STATUSES } from '@/lib/types';
import { getStatusCopy, getTimelineIndex } from '@/lib/payout-copy';
import { PayoutTimeline } from '@/components/trader/PayoutTimeline';
import { AccountFilter } from '@/components/trader/AccountFilter';
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from '@/components/ui/pagination';

const PAGE_SIZE = 20;

interface Payout {
  id: string;
  amount: number;
  status: string;
  requested_at: string;
  reviewed_at: string | null;
  paid_at: string | null;
  review_notes: string | null;
  payment_reference: string | null;
  account: {
    account_number: string;
  };
}

export default function TraderPayouts() {
  const { user } = useAuth();
  const [expandedPayoutId, setExpandedPayoutId] = useState<string | null>(null);
  const [filterAccountId, setFilterAccountId] = useState('all');
  const [page, setPage] = useState(0);
  const tracked = useRef(false);

  useEffect(() => {
    if (!tracked.current) { tracked.current = true; track('payouts_view'); }
  }, []);

  // Fetch accounts for the filter
  const { data: filterAccounts } = useQuery({
    queryKey: ['trader-accounts-filter-payouts', user?.id],
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

  const { data: payoutsData, isLoading } = useQuery({
    queryKey: ['trader-payouts', user?.id, filterAccountId, page],
    queryFn: async () => {
      const { data: accounts } = await supabase
        .from('accounts')
        .select('id, account_number')
        .eq('user_id', user?.id);

      if (!accounts?.length) return { payouts: [] as Payout[], total: 0 };

      const accountIds = filterAccountId === 'all'
        ? accounts.map((a) => a.id)
        : [filterAccountId];
      const accountMap = Object.fromEntries(accounts.map((a) => [a.id, a.account_number]));

      const from = page * PAGE_SIZE;
      const to = from + PAGE_SIZE - 1;

      const { data, error, count } = await supabase
        .from('payouts')
        .select('*', { count: 'exact' })
        .in('account_id', accountIds)
        .order('requested_at', { ascending: false })
        .range(from, to);

      if (error) throw error;

      const payouts = (data || []).map((p) => ({
        ...p,
        account: { account_number: accountMap[p.account_id] || 'Unknown' },
      })) as Payout[];

      return { payouts, total: count || 0 };
    },
    enabled: !!user?.id,
  });

  const payouts = payoutsData?.payouts;
  const totalPages = Math.ceil((payoutsData?.total || 0) / PAGE_SIZE);

  const handleFilterChange = (val: string) => {
    setFilterAccountId(val);
    setPage(0);
  };

  const getStatusBadge = (status: string) => {
    const statusCopy = getStatusCopy(status);
    const config: Record<string, { variant: 'default' | 'secondary' | 'destructive' | 'outline'; icon: React.ReactNode }> = {
      pending: { variant: 'outline', icon: <Clock className="h-3 w-3" /> },
      under_review: { variant: 'outline', icon: <Loader2 className="h-3 w-3 animate-spin" /> },
      approved: { variant: 'secondary', icon: <CheckCircle className="h-3 w-3" /> },
      paid: { variant: 'default', icon: <CheckCircle className="h-3 w-3" /> },
      paid_confirmed: { variant: 'default', icon: <CheckCircle className="h-3 w-3" /> },
      payment_initiated: { variant: 'outline', icon: <Loader2 className="h-3 w-3 animate-spin" /> },
      payment_failed: { variant: 'destructive', icon: <XCircle className="h-3 w-3" /> },
      rejected: { variant: 'destructive', icon: <XCircle className="h-3 w-3" /> },
    };
    const { variant, icon } = config[status] || { variant: 'secondary' as const, icon: null };
    return (
      <Badge variant={variant} className="flex items-center gap-1 w-fit">
        {icon}
        {statusCopy.label}
      </Badge>
    );
  };

  const totalPaid = payouts?.filter((p) => isTerminalPaid(p.status)).reduce((sum, p) => sum + p.amount, 0) || 0;
  const pendingAmount = payouts?.filter((p) => (IN_PROGRESS_PAYOUT_STATUSES as readonly string[]).includes(p.status)).reduce((sum, p) => sum + p.amount, 0) || 0;

  return (
    <DashboardLayout title="My Payouts" navItems={traderNavItems}>
      <div className="space-y-6">
        <div className="flex items-center justify-between flex-wrap gap-4">
          <div>
            <h2 className="text-2xl font-bold tracking-tight">Payout History</h2>
            <p className="text-muted-foreground">
              Track your payout requests and payment status.
            </p>
          </div>
          <AccountFilter
            accounts={filterAccounts || []}
            value={filterAccountId}
            onChange={handleFilterChange}
          />
        </div>

        {/* Summary cards */}
        <div className="grid gap-4 md:grid-cols-2">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Paid Out</CardTitle>
              <DollarSign className="h-4 w-4 text-success" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-success">
                ${totalPaid.toLocaleString()}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Pending / In Progress</CardTitle>
              <Clock className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                ${pendingAmount.toLocaleString()}
              </div>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Payout Requests</CardTitle>
            <CardDescription>
              All your payout requests and their current status
            </CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="space-y-2">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="h-12 bg-muted animate-pulse rounded" />
                ))}
              </div>
            ) : payouts?.length ? (
              <>
                <div className="rounded-md border overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Account</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Requested</TableHead>
                      <TableHead>Paid</TableHead>
                      <TableHead>Reference</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {payouts.map((payout) => {
                      const isExpanded = expandedPayoutId === payout.id;
                      const hasTimeline = getTimelineIndex(payout.status) >= 0;
                      return (
                        <>
                          <TableRow
                            key={payout.id}
                            className={hasTimeline ? "cursor-pointer hover:bg-muted/50" : ""}
                            onClick={() => hasTimeline && setExpandedPayoutId(isExpanded ? null : payout.id)}
                          >
                            <TableCell className="font-mono text-xs">
                              #{payout.account.account_number}
                            </TableCell>
                            <TableCell className="text-right font-medium">
                              ${payout.amount.toLocaleString()}
                            </TableCell>
                            <TableCell>{getStatusBadge(payout.status)}</TableCell>
                            <TableCell className="text-muted-foreground text-xs">
                              {format(new Date(payout.requested_at), 'MMM d, yyyy')}
                            </TableCell>
                            <TableCell className="text-muted-foreground text-xs">
                              {payout.paid_at
                                ? format(new Date(payout.paid_at), 'MMM d, yyyy')
                                : '-'}
                            </TableCell>
                            <TableCell className="font-mono text-xs">
                              {payout.payment_reference || '-'}
                            </TableCell>
                            {hasTimeline && (
                              <TableCell className="w-8">
                                {isExpanded ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
                              </TableCell>
                            )}
                          </TableRow>
                          {isExpanded && hasTimeline && (
                            <TableRow key={`${payout.id}-timeline`}>
                              <TableCell colSpan={7} className="bg-muted/30 py-4 px-6">
                                <PayoutTimeline status={payout.status} />
                              </TableCell>
                            </TableRow>
                          )}
                        </>
                      );
                    })}
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
                No payout requests yet. Once your account reaches the Performance phase, you can request payouts here.
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}
