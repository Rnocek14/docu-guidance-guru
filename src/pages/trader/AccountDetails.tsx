import { useParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { DashboardLayout, traderNavItems } from '@/components/layout/DashboardLayout';
import { RuleSnapshotCard } from '@/components/trader/RuleSnapshotCard';
import { AccountTimeline } from '@/components/trader/AccountTimeline';
import { ProgressGauges } from '@/components/trader/ProgressGauges';
import { BreachExplainer } from '@/components/trader/BreachExplainer';
import { ConsistencyBestDayCard } from '@/components/trader/ConsistencyBestDayCard';
import { ConsistencyProfitableDaysCard } from '@/components/trader/ConsistencyProfitableDaysCard';
import { ReconciliationHistory } from '@/components/risk/ReconciliationHistory';
import { EquityCurveChart } from '@/components/trader/EquityCurveChart';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ArrowLeft, DollarSign, CheckCircle2, XCircle, Download } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import type { Account, Violation } from '@/lib/types';
import { format } from 'date-fns';

interface RuleSnapshot {
  cohort_id: string;
  cohort_name: string;
  cohort_version: number;
  cohort_phase?: string;
  max_daily_loss_percent: number;
  max_total_drawdown_percent: number;
  profit_target_percent: number;
  min_trading_days: number;
  max_position_size_percent: number;
  max_daily_profit_cap_percent?: number | null;
  min_profitable_days?: number;
  frozen_at: string;
}

const statusLabels: Record<string, { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }> = {
  active: { label: 'Active', variant: 'default' },
  breached_detected: { label: 'Breach Detected', variant: 'destructive' },
  under_review: { label: 'Under Review', variant: 'outline' },
  failed_confirmed: { label: 'Failed', variant: 'destructive' },
  passed: { label: 'Passed', variant: 'secondary' },
  payout_requested: { label: 'Payout Requested', variant: 'outline' },
  payout_under_review: { label: 'Payout Under Review', variant: 'outline' },
  payout_approved: { label: 'Payout Approved', variant: 'secondary' },
  closed: { label: 'Closed', variant: 'secondary' },
};

export default function AccountDetails() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();

  // Fetch account details
  const { data: account, isLoading: accountLoading, error: accountError } = useQuery({
    queryKey: ['account-details', id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('accounts')
        .select('*')
        .eq('id', id)
        .eq('user_id', user?.id)
        .single();

      if (error) throw error;
      // Cast rule_snapshot from Json to our RuleSnapshot type
      return {
        ...data,
        rule_snapshot: data.rule_snapshot as unknown as RuleSnapshot | null,
      };
    },
    enabled: !!id && !!user?.id,
  });

  // Fetch violations for this account
  const { data: violations } = useQuery({
    queryKey: ['account-violations', id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('violations')
        .select('*')
        .eq('account_id', id)
        .order('detected_at', { ascending: false });

      if (error) throw error;
      return data as Violation[];
    },
    enabled: !!id,
  });

  // Fetch daily stats for day-by-day breakdown
  const { data: dailyStats } = useQuery({
    queryKey: ['account-daily-stats', id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('account_daily_stats')
        .select('*')
        .eq('account_id', id)
        .order('trading_day', { ascending: false });

      if (error) throw error;
      return data;
    },
    enabled: !!id,
  });

  // Check if current user is staff (risk_officer, support, or admin) using RPC for RLS safety
  const { data: isStaff, isLoading: isStaffLoading } = useQuery({
    queryKey: ['user-is-staff', user?.id],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_user_roles', { _user_id: user?.id });
      if (error) throw error;
      const roles = (data as string[]) ?? [];
      return roles.some(r => ['risk_officer', 'support', 'admin'].includes(r));
    },
    enabled: !!user?.id,
  });

  const ruleSnapshot = account?.rule_snapshot as RuleSnapshot | null;

  const cohortPhase = ruleSnapshot?.cohort_phase ?? 'evaluation';
  const hasConsistencyRules =
    (ruleSnapshot?.max_daily_profit_cap_percent ?? null) !== null ||
    (ruleSnapshot?.min_profitable_days ?? 0) > 0;

  const shouldFetchConsistency =
    !!id &&
    account?.status === 'active' &&
    cohortPhase !== 'performance' &&
    hasConsistencyRules;

  const { data: consistency } = useQuery({
    queryKey: ['account-consistency', id],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('check_consistency_rules', { _account_id: id! });
      if (error) throw error;
      return data as {
        best_day_pnl: number;
        best_day_pct_of_target: number;
        max_daily_profit_cap_percent: number | null;
        best_day_cap_met: boolean;
        profitable_days: number;
        min_profitable_days: number;
        profitable_days_met: boolean;
        all_consistency_met: boolean;
      };
    },
    enabled: shouldFetchConsistency,
  });
  const status = statusLabels[account?.status || 'active'] || statusLabels.active;
  const showPayoutButton = account?.status === 'passed';
  
  // Staff visibility guards (bulletproof: handles undefined, disabled query, falsy id)
  const staff = !!isStaff;
  const canShowRecon = !isStaffLoading && staff && !!id;

  if (accountLoading) {
    return (
      <DashboardLayout title="Account Details" navItems={traderNavItems}>
        <div className="space-y-6">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-64 w-full" />
          <div className="grid gap-4 md:grid-cols-2">
            <Skeleton className="h-40" />
            <Skeleton className="h-40" />
          </div>
        </div>
      </DashboardLayout>
    );
  }

  if (accountError || !account) {
    return (
      <DashboardLayout title="Account Details" navItems={traderNavItems}>
        <div className="space-y-6">
          <Link to="/trader" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
            <ArrowLeft className="h-4 w-4" />
            Back to Dashboard
          </Link>
          <Card>
            <CardHeader>
              <CardTitle>Account Not Found</CardTitle>
              <CardDescription>
                The account you're looking for doesn't exist or you don't have access to it.
              </CardDescription>
            </CardHeader>
          </Card>
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout title="Account Details" navItems={traderNavItems}>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1">
            <Link to="/trader" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground mb-2">
              <ArrowLeft className="h-4 w-4" />
              Back to Dashboard
            </Link>
            <h2 className="text-2xl font-bold tracking-tight flex items-center gap-3">
              Account #{account.account_number}
              <Badge variant={status.variant}>{status.label}</Badge>
            </h2>
            <p className="text-muted-foreground">
              Balance: ${account.current_balance.toLocaleString()} | 
              Total P&L: {account.total_pnl >= 0 ? '+' : ''}${account.total_pnl.toLocaleString()}
            </p>
          </div>
          {showPayoutButton && (
            <Button asChild>
              <Link to={`/trader/accounts/${id}/payout`}>
                <DollarSign className="h-4 w-4 mr-2" />
                Request Payout
              </Link>
            </Button>
          )}
        </div>

        {/* Breach Explainer (if violations exist) */}
        {violations && violations.length > 0 && (
          <BreachExplainer violations={violations} accountStatus={account.status} />
        )}

        {/* Equity Curve */}
        {ruleSnapshot && (
          <EquityCurveChart
            accountId={account.id}
            startingBalance={account.starting_balance}
            maxDrawdownPct={ruleSnapshot.max_total_drawdown_percent}
            profitTargetPct={ruleSnapshot.profit_target_percent}
            minTradingDays={ruleSnapshot.min_trading_days}
          />
        )}

        {/* Rule Snapshot */}
        <RuleSnapshotCard ruleSnapshot={ruleSnapshot} />

        {/* Compliance Snapshot */}
        {ruleSnapshot && (
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Compliance Snapshot</CardTitle>
              <CardDescription>Pass/fail status for each rule — as of now</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {[
                  {
                    label: `Profit Target (${ruleSnapshot.profit_target_percent}%)`,
                    met: ((account.total_pnl / account.starting_balance) * 100) >= ruleSnapshot.profit_target_percent,
                  },
                  {
                    label: `Min Trading Days (${ruleSnapshot.min_trading_days})`,
                    met: account.trading_days_count >= ruleSnapshot.min_trading_days,
                  },
                  {
                    label: `Max Drawdown (${ruleSnapshot.max_total_drawdown_percent}%)`,
                    met: account.highest_balance > 0
                      ? ((account.highest_balance - account.current_balance) / account.highest_balance * 100) <= ruleSnapshot.max_total_drawdown_percent
                      : true,
                  },
                  {
                    label: `Daily Loss Limit (${ruleSnapshot.max_daily_loss_percent}%)`,
                    met: !(violations?.some(v => v.rule_type === 'max_daily_loss')),
                  },
                ].map((rule) => (
                  <div key={rule.label} className="flex items-center gap-2 text-sm rounded-lg border border-border p-3">
                    {rule.met ? (
                      <CheckCircle2 className="h-4 w-4 text-success shrink-0" />
                    ) : (
                      <XCircle className="h-4 w-4 text-destructive shrink-0" />
                    )}
                    <span className={rule.met ? 'text-foreground' : 'text-destructive font-medium'}>{rule.label}</span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Progress Gauges */}
        {ruleSnapshot && (
          <ProgressGauges
            currentBalance={account.current_balance}
            startingBalance={account.starting_balance}
            highestBalance={account.highest_balance}
            dailyPnl={account.daily_pnl}
            totalPnl={account.total_pnl}
            tradingDaysCount={account.trading_days_count}
            ruleSnapshot={ruleSnapshot}
          />
        )}

        {/* Consistency Rules (active accounts) */}
        {consistency && account.status === 'active' && (
          <div className="grid gap-4 md:grid-cols-2">
            {consistency.max_daily_profit_cap_percent != null && (
              <ConsistencyBestDayCard
                bestDayPnl={consistency.best_day_pnl}
                bestDayPctOfTarget={consistency.best_day_pct_of_target}
                maxCapPercent={consistency.max_daily_profit_cap_percent}
                isMet={consistency.best_day_cap_met}
              />
            )}
            {consistency.min_profitable_days > 0 && (
              <ConsistencyProfitableDaysCard
                profitableDays={consistency.profitable_days}
                minRequired={consistency.min_profitable_days}
                isMet={consistency.profitable_days_met}
              />
            )}
          </div>
        )}

        {/* Day-by-Day Summary */}
        {dailyStats && dailyStats.length > 0 && (
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-lg">Day-by-Day Summary</CardTitle>
                  <CardDescription>Daily P&L breakdown from account_daily_stats</CardDescription>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-2"
                  onClick={() => {
                    const csv = [
                      'Date,Net P&L,Gross P&L,Commissions,Trades,Won,Lost,Winning Day',
                      ...dailyStats.map(d =>
                        `${d.trading_day},${d.net_pnl},${d.gross_pnl},${d.commissions},${d.trade_count},${d.winning_trades},${d.losing_trades},${d.is_winning_day}`
                      ),
                    ].join('\n');
                    const blob = new Blob([csv], { type: 'text/csv' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = `account-${account.account_number}-daily-stats.csv`;
                    a.click();
                    URL.revokeObjectURL(url);
                  }}
                >
                  <Download className="h-3.5 w-3.5" />
                  Export CSV
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              <div className="max-h-[400px] overflow-auto rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead className="text-right">Net P&L</TableHead>
                      <TableHead className="text-right">Trades</TableHead>
                      <TableHead className="text-right">Won</TableHead>
                      <TableHead className="text-right">Lost</TableHead>
                      <TableHead className="text-center">Result</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {dailyStats.map((day) => (
                      <TableRow key={day.id}>
                        <TableCell className="font-mono text-sm">
                          {format(new Date(day.trading_day + 'T00:00:00'), 'MMM d, yyyy')}
                        </TableCell>
                        <TableCell className={`text-right font-mono ${Number(day.net_pnl) >= 0 ? 'text-success' : 'text-destructive'}`}>
                          {Number(day.net_pnl) >= 0 ? '+' : ''}${Number(day.net_pnl).toLocaleString()}
                        </TableCell>
                        <TableCell className="text-right">{day.trade_count}</TableCell>
                        <TableCell className="text-right text-success">{day.winning_trades}</TableCell>
                        <TableCell className="text-right text-destructive">{day.losing_trades}</TableCell>
                        <TableCell className="text-center">
                          {day.is_winning_day ? (
                            <Badge variant="secondary" className="text-success">Win</Badge>
                          ) : (
                            <Badge variant="outline" className="text-destructive">Loss</Badge>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Account Timeline */}
        <AccountTimeline accountId={account.id} maxHeight="500px" />

        {/* Reconciliation History (staff only, no pop-in) */}
        {canShowRecon ? <ReconciliationHistory accountId={id!} /> : null}
      </div>
    </DashboardLayout>
  );
}
