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
import { DollarSign, Clock, CheckCircle, XCircle, Loader2 } from 'lucide-react';
import { isTerminalPaid } from '@/lib/types';

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

  const { data: payouts, isLoading } = useQuery({
    queryKey: ['trader-payouts', user?.id],
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
        .from('payouts')
        .select('*')
        .in('account_id', accountIds)
        .order('requested_at', { ascending: false });

      if (error) throw error;

      return (data || []).map((p) => ({
        ...p,
        account: { account_number: accountMap[p.account_id] || 'Unknown' },
      })) as Payout[];
    },
    enabled: !!user?.id,
  });

  const getStatusBadge = (status: string) => {
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
        {status.replace(/_/g, ' ')}
      </Badge>
    );
  };

  const totalPaid = payouts?.filter((p) => isTerminalPaid(p.status)).reduce((sum, p) => sum + p.amount, 0) || 0;
  const pendingAmount = payouts?.filter((p) => ['pending', 'under_review', 'approved'].includes(p.status)).reduce((sum, p) => sum + p.amount, 0) || 0;

  return (
    <DashboardLayout title="My Payouts" navItems={traderNavItems}>
      <div className="space-y-6">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Payout History</h2>
          <p className="text-muted-foreground">
            Track your payout requests and payment status.
          </p>
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
                    {payouts.map((payout) => (
                      <TableRow key={payout.id}>
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
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <p className="text-muted-foreground text-center py-8">
                No payout requests yet. Complete a challenge to request a payout.
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}
