import { Link } from 'react-router-dom';
import { DashboardLayout, traderNavItems } from '@/components/layout/DashboardLayout';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/integrations/supabase/client';
import { useQuery } from '@tanstack/react-query';
import { TrendingUp, TrendingDown, AlertTriangle, Target, Calendar, DollarSign, Eye } from 'lucide-react';
import type { Account, Cohort, PayoutEligibility } from '@/lib/types';
import { AccountPhaseIndicator } from '@/components/trader/AccountPhaseIndicator';
import { PayoutReadinessCard } from '@/components/trader/PayoutReadinessCard';
import { EquityCurveChart } from '@/components/trader/EquityCurveChart';
import { RuleHealthCard } from '@/components/trader/RuleHealthCard';
import { WhatsNextCard } from '@/components/trader/WhatsNextCard';

export default function TraderDashboard() {
  const { user } = useAuth();

  // Fetch trader's accounts with cohort info
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

  const activeAccount = accounts?.find((a) => 
    a.status === 'active' || a.status === 'passed' || a.status.startsWith('payout_')
  );
  
  const isPerformanceAccount = activeAccount && 
    (activeAccount.status === 'passed' || activeAccount.status.startsWith('payout_'));

  // Fetch payout eligibility for PA-phase accounts
  const { data: eligibility } = useQuery({
    queryKey: ['payout-eligibility', activeAccount?.id],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('calculate_payout_eligibility', {
        _account_id: activeAccount!.id,
      });
      if (error) throw error;
      return data as unknown as PayoutEligibility;
    },
    enabled: !!activeAccount?.id && isPerformanceAccount,
  });

  const getStatusBadge = (status: string) => {
    const variants: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
      active: 'default',
      passed: 'secondary',
      breached_detected: 'destructive',
      under_review: 'outline',
      failed_confirmed: 'destructive',
    };
    return (
      <Badge variant={variants[status] || 'secondary'}>
        {status.replace('_', ' ')}
      </Badge>
    );
  };

  const calculateDrawdown = (account: Account) => {
    if (!account) return 0;
    const drawdown = ((account.highest_balance - account.current_balance) / account.highest_balance) * 100;
    return Math.max(0, drawdown);
  };

  const calculateProgress = (account: Account & { cohort: Cohort }) => {
    if (!account?.cohort) return 0;
    const profitPercent = (account.total_pnl / account.starting_balance) * 100;
    return Math.min(100, (profitPercent / account.cohort.profit_target_percent) * 100);
  };

  return (
    <DashboardLayout title="Trader Dashboard" navItems={traderNavItems}>
      <div className="space-y-6">
        {/* Welcome section */}
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Welcome back</h2>
          <p className="text-muted-foreground">
            Here's an overview of your trading challenge progress.
          </p>
        </div>

        {isLoading ? (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            {[1, 2, 3, 4].map((i) => (
              <Card key={i}>
                <CardHeader className="pb-2">
                  <div className="h-4 w-24 bg-muted animate-pulse rounded" />
                </CardHeader>
                <CardContent>
                  <div className="h-8 w-32 bg-muted animate-pulse rounded" />
                </CardContent>
              </Card>
            ))}
          </div>
        ) : activeAccount ? (
          <>
            {/* Phase Indicator */}
            <AccountPhaseIndicator 
              status={activeAccount.status} 
              profitTargetPercent={activeAccount.cohort?.profit_target_percent || 10}
              payoutWindowOpened={eligibility?.payout_window_opened !== false}
              daysRemaining={eligibility?.days_remaining}
              windowOpensAt={eligibility?.payout_window_opens_at}
            />

            {/* PA-only: Payout Readiness */}
            {isPerformanceAccount && (
              <PayoutReadinessCard
                eligibility={eligibility}
                accountId={activeAccount.id}
              />
            )}

            {/* Stats grid */}
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">Current Balance</CardTitle>
                  <DollarSign className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">
                    ${activeAccount.current_balance.toLocaleString()}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Started at ${activeAccount.starting_balance.toLocaleString()}
                  </p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">Total P&L</CardTitle>
                  {activeAccount.total_pnl >= 0 ? (
                    <TrendingUp className="h-4 w-4 text-success" />
                  ) : (
                    <TrendingDown className="h-4 w-4 text-destructive" />
                  )}
                </CardHeader>
                <CardContent>
                  <div
                    className={`text-2xl font-bold ${
                      activeAccount.total_pnl >= 0 ? 'text-success' : 'text-destructive'
                    }`}
                  >
                    {activeAccount.total_pnl >= 0 ? '+' : ''}
                    ${activeAccount.total_pnl.toLocaleString()}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {((activeAccount.total_pnl / activeAccount.starting_balance) * 100).toFixed(2)}% simulated return
                  </p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">Current Drawdown</CardTitle>
                  <AlertTriangle className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">
                    {calculateDrawdown(activeAccount).toFixed(2)}%
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Max allowed: {activeAccount.cohort?.max_total_drawdown_percent}%
                  </p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">Trading Days</CardTitle>
                  <Calendar className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{activeAccount.trading_days_count}</div>
                  <p className="text-xs text-muted-foreground">
                    Minimum: {activeAccount.cohort?.min_trading_days} days
                  </p>
                </CardContent>
              </Card>
            </div>

            {/* Equity Curve */}
            <EquityCurveChart
              accountId={activeAccount.id}
              startingBalance={activeAccount.starting_balance}
            />

            {/* Rule Health + What's Next */}
            <div className="grid gap-4 md:grid-cols-2">
              <RuleHealthCard account={activeAccount} />
              <WhatsNextCard account={activeAccount} />
            </div>

            {/* Progress section */}
            <div className="grid gap-4 md:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Target className="h-5 w-5" />
                    Performance Target Progress
                  </CardTitle>
                  <CardDescription>
                    Target: {activeAccount.cohort?.profit_target_percent}% profit
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <Progress value={calculateProgress(activeAccount)} className="h-3" />
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">
                      Current: {((activeAccount.total_pnl / activeAccount.starting_balance) * 100).toFixed(2)}%
                    </span>
                    <span className="font-medium">
                      {calculateProgress(activeAccount).toFixed(0)}% complete
                    </span>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <AlertTriangle className="h-5 w-5" />
                    Drawdown Monitor
                  </CardTitle>
                  <CardDescription>
                    Maximum allowed: {activeAccount.cohort?.max_total_drawdown_percent}%
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="relative">
                    <Progress
                      value={(calculateDrawdown(activeAccount) / (activeAccount.cohort?.max_total_drawdown_percent || 10)) * 100}
                      className="h-3"
                    />
                    {/* Warning threshold line at 80% */}
                    <div
                      className="absolute top-0 h-3 w-0.5 bg-warning"
                      style={{ left: '80%' }}
                    />
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">
                      Current: {calculateDrawdown(activeAccount).toFixed(2)}%
                    </span>
                    {calculateDrawdown(activeAccount) > (activeAccount.cohort?.max_total_drawdown_percent || 10) * 0.8 && (
                      <span className="text-warning font-medium">⚠️ Approaching limit</span>
                    )}
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* Account status */}
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle>Account Status</CardTitle>
                    <CardDescription>
                      Account #{activeAccount.account_number}
                    </CardDescription>
                  </div>
                  <Button asChild size="sm" variant="outline">
                    <Link to={`/trader/accounts/${activeAccount.id}`}>
                      <Eye className="h-4 w-4 mr-2" />
                      View Details
                    </Link>
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                <div className="flex items-center gap-4">
                  {getStatusBadge(activeAccount.status)}
                  <span className="text-muted-foreground">
                    Cohort: {activeAccount.cohort?.name} v{activeAccount.cohort?.version}
                  </span>
                </div>
              </CardContent>
            </Card>
          </>
        ) : (
          <Card className="border-dashed">
            <CardHeader className="text-center pb-2">
              <Target className="h-12 w-12 text-muted-foreground mx-auto mb-3" />
              <CardTitle className="text-xl">Start Your First Evaluation</CardTitle>
              <CardDescription className="max-w-md mx-auto">
                Choose a simulated account size, pass the evaluation by trading within the rules, and
                earn performance-based rewards.
              </CardDescription>
            </CardHeader>
            <CardContent className="text-center pt-4">
              <Button asChild size="lg" className="gap-2">
                <Link to="/checkout">
                  Choose a Plan <TrendingUp className="h-4 w-4" />
                </Link>
              </Button>
            </CardContent>
          </Card>
        )}
      </div>
    </DashboardLayout>
  );
}
