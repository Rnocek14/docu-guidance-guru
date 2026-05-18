import { Link } from 'react-router-dom';
import { DashboardLayout, traderNavItems } from '@/components/layout/DashboardLayout';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/integrations/supabase/client';
import { useQuery } from '@tanstack/react-query';
import { Eye, TrendingUp, TrendingDown, Calendar, Loader2, AlertTriangle } from 'lucide-react';
import type { Account, Cohort } from '@/lib/types';
import { useRealtimeAccounts } from '@/hooks/use-realtime-accounts';

export default function TraderAccounts() {
  const { user } = useAuth();
  useRealtimeAccounts(user?.id);

  const { data: accounts, isLoading } = useQuery({
    queryKey: ['trader-accounts', user?.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('accounts')
        .select(`
          *,
          cohort:cohorts(*)
        `)
        .eq('user_id', user?.id)
        .order('created_at', { ascending: false });

      if (error) throw error;
      return data as (Account & { cohort: Cohort })[];
    },
    enabled: !!user?.id,
  });

  const getStatusBadge = (status: string) => {
    const variants: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
      active: 'default',
      passed: 'secondary',
      breached_detected: 'destructive',
      under_review: 'outline',
      failed_confirmed: 'destructive',
      payout_requested: 'outline',
      payout_approved: 'secondary',
      closed: 'secondary',
    };
    return (
      <Badge variant={variants[status] || 'secondary'}>
        {status.replace(/_/g, ' ')}
      </Badge>
    );
  };

  return (
    <DashboardLayout title="My Accounts" navItems={traderNavItems}>
      <div className="space-y-6">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Trading Accounts</h2>
          <p className="text-muted-foreground">
            View and manage all your trading challenge accounts.
          </p>
        </div>

        {isLoading ? (
          <div className="grid gap-4 md:grid-cols-2">
            {[1, 2].map((i) => (
              <Card key={i}>
                <CardHeader>
                  <div className="h-6 w-32 bg-muted animate-pulse rounded" />
                </CardHeader>
                <CardContent>
                  <div className="h-20 bg-muted animate-pulse rounded" />
                </CardContent>
              </Card>
            ))}
          </div>
        ) : accounts?.length ? (
          <div className="grid gap-4 md:grid-cols-2">
            {accounts.map((account) => (
              <Card key={account.id}>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <div>
                      <CardTitle className="text-lg">
                        Account #{account.account_number}
                      </CardTitle>
                      <CardDescription>
                        {account.cohort?.name} v{account.cohort?.version}
                      </CardDescription>
                    </div>
                    {getStatusBadge(account.status)}
                  </div>
                  <ProvisioningBadge account={account} />
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div className="flex items-center gap-2">
                      {account.total_pnl >= 0 ? (
                        <TrendingUp className="h-4 w-4 text-success" />
                      ) : (
                        <TrendingDown className="h-4 w-4 text-destructive" />
                      )}
                      <span>
                        P&L:{' '}
                        <span className={account.total_pnl >= 0 ? 'text-success' : 'text-destructive'}>
                          {account.total_pnl >= 0 ? '+' : ''}${account.total_pnl.toLocaleString()}
                        </span>
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Calendar className="h-4 w-4 text-muted-foreground" />
                      <span>{account.trading_days_count} trading days</span>
                    </div>
                  </div>
                  <div className="flex justify-between items-center pt-2 border-t">
                    <span className="text-sm text-muted-foreground">
                      Balance: ${account.current_balance.toLocaleString()}
                    </span>
                    <Button asChild size="sm" variant="outline">
                      <Link to={`/trader/accounts/${account.id}`}>
                        <Eye className="h-4 w-4 mr-2" />
                        View Details
                      </Link>
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        ) : (
          <Card className="border-dashed">
            <CardHeader className="text-center pb-2">
              <TrendingUp className="h-12 w-12 text-muted-foreground mx-auto mb-3" />
              <CardTitle className="text-xl">No Accounts Yet</CardTitle>
              <CardDescription className="max-w-md mx-auto">
                Start a simulated trading evaluation. Choose your account size, trade within the rules,
                and earn performance-based rewards.
              </CardDescription>
            </CardHeader>
            <CardContent className="text-center pt-4">
              <Button asChild size="lg" className="gap-2">
                <Link to="/checkout">
                  Start Your Evaluation <Eye className="h-4 w-4" />
                </Link>
              </Button>
            </CardContent>
          </Card>
        )}
      </div>
    </DashboardLayout>
  );
}
