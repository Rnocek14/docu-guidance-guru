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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ArrowLeft, DollarSign } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import type { Account, Violation } from '@/lib/types';

interface RuleSnapshot {
  cohort_id: string;
  cohort_name: string;
  cohort_version: number;
  max_daily_loss_percent: number;
  max_total_drawdown_percent: number;
  profit_target_percent: number;
  min_trading_days: number;
  max_position_size_percent: number;
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

  // Fetch consistency rules (only for active eval/verification accounts that have consistency config)
  const cohortPhase = (ruleSnapshot as any)?.cohort_phase;
  const hasConsistencyRules = ruleSnapshot && (
    (ruleSnapshot as any).max_daily_profit_cap_percent != null ||
    ((ruleSnapshot as any).min_profitable_days ?? 0) > 0
  );
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
    enabled: !!id && account?.status === 'active' && cohortPhase !== 'performance' && !!hasConsistencyRules,
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

        {/* Rule Snapshot */}
        <RuleSnapshotCard ruleSnapshot={ruleSnapshot} />

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

        {/* Account Timeline */}
        <AccountTimeline accountId={account.id} maxHeight="500px" />

        {/* Reconciliation History (staff only, no pop-in) */}
        {canShowRecon ? <ReconciliationHistory accountId={id!} /> : null}
      </div>
    </DashboardLayout>
  );
}
