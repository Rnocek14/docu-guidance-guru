import { useMemo } from 'react';
import { useTierUpDetection } from '@/hooks/use-tier-up-detection';
import { TierUpCelebrationModal } from '@/components/trader/TierUpCelebrationModal';
import { Link, useSearchParams } from 'react-router-dom';
import { DashboardLayout, traderNavItems } from '@/components/layout/DashboardLayout';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/integrations/supabase/client';
import { useQuery } from '@tanstack/react-query';
import { TrendingUp, Target } from 'lucide-react';
import type { Account, Cohort, PayoutEligibility } from '@/lib/types';
import { isTerminalPaid } from '@/lib/types';
import { calculateLadderProgress } from '@/lib/ladder-spec';
import { AccountPhaseIndicator } from '@/components/trader/AccountPhaseIndicator';
import { PayoutReadinessCard } from '@/components/trader/PayoutReadinessCard';
import { EquityCurveChart } from '@/components/trader/EquityCurveChart';
import { RuleHealthCard } from '@/components/trader/RuleHealthCard';
import { WhatsNextCard } from '@/components/trader/WhatsNextCard';
import { SafeDayPanel } from '@/components/trader/SafeDayPanel';
import { ConsistencyPreviewCard } from '@/components/trader/ConsistencyPreviewCard';
import { PortfolioOverview } from '@/components/trader/PortfolioOverview';
import { AccountSwitcher, sortAccounts } from '@/components/trader/AccountSwitcher';
import { SmartGreeting } from '@/components/trader/SmartGreeting';
import { TierStatusCard } from '@/components/trader/TierStatusCard';
import { CleanPayoutChecklist } from '@/components/trader/CleanPayoutChecklist';
import { RecentPayoutsTable } from '@/components/trader/RecentPayoutsTable';
import { ResetHistoryStrip } from '@/components/trader/ResetHistoryStrip';
import { PayoutTrackerBar } from '@/components/trader/PayoutTrackerBar';
import { RulesAtAGlanceCard } from '@/components/trader/RulesAtAGlanceCard';
import { LivePayoutTicker } from '@/components/trader/LivePayoutTicker';
import { useRealtimeAccounts } from '@/hooks/use-realtime-accounts';

export default function TraderDashboard() {
  const { user } = useAuth();
  useRealtimeAccounts(user?.id);
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedAccountId = searchParams.get('account');

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

  // Fetch total paid out across all accounts
  const { data: totalPaidOut } = useQuery({
    queryKey: ['trader-total-paid', user?.id],
    queryFn: async () => {
      const { data: accts } = await supabase
        .from('accounts')
        .select('id')
        .eq('user_id', user?.id);
      if (!accts?.length) return 0;
      const { data: payouts } = await supabase
        .from('payouts')
        .select('amount, status')
        .in('account_id', accts.map((a) => a.id));
      return (payouts || [])
        .filter((p) => isTerminalPaid(p.status))
        .reduce((sum, p) => sum + p.amount, 0);
    },
    enabled: !!user?.id,
  });

  const sorted = useMemo(() => sortAccounts(accounts ?? []), [accounts]);

  const activeAccount = useMemo(() => {
    if (!sorted.length) return undefined;
    if (selectedAccountId) {
      return sorted.find((a) => a.id === selectedAccountId) || sorted[0];
    }
    return sorted[0];
  }, [sorted, selectedAccountId]);

  const handleSelectAccount = (id: string) => {
    setSearchParams({ account: id }, { replace: true });
  };

  const isPerformanceAccount = activeAccount && 
    activeAccount.cohort?.cohort_phase === 'performance';

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

  // Fetch clean payout count for ladder progression (per account lineage)
  const { data: cleanPayoutCount } = useQuery({
    queryKey: ['clean-payout-count', activeAccount?.id, activeAccount?.root_account_id],
    queryFn: async () => {
      // Get all accounts in the lineage (same root_account_id or the account itself)
      const lineageRoot = activeAccount!.root_account_id ?? activeAccount!.id;
      const { data: lineageAccounts } = await supabase
        .from('accounts')
        .select('id')
        .or(`root_account_id.eq.${lineageRoot},id.eq.${lineageRoot}`)
        .eq('user_id', user!.id);

      if (!lineageAccounts?.length) return 0;

      const { count, error } = await supabase
        .from('payouts')
        .select('id', { count: 'exact', head: true })
        .in('account_id', lineageAccounts.map((a) => a.id))
        .eq('is_clean_payout', true)
        .in('status', ['paid', 'paid_confirmed']);

      if (error) throw error;
      return count ?? 0;
    },
    enabled: !!activeAccount?.id && !!isPerformanceAccount,
  });

  const ladderProgress = useMemo(
    () => calculateLadderProgress(cleanPayoutCount ?? 0),
    [cleanPayoutCount],
  );

  const lineageRoot = activeAccount?.root_account_id ?? activeAccount?.id;
  const { tierUpEvent, dismissTierUp } = useTierUpDetection(
    isPerformanceAccount ? cleanPayoutCount ?? undefined : undefined,
    lineageRoot,
  );

  return (
    <DashboardLayout title="Trader Dashboard" navItems={traderNavItems}>
      {/* Tier-Up Celebration Modal */}
      {tierUpEvent && (
        <TierUpCelebrationModal
          open
          onClose={dismissTierUp}
          fromTier={tierUpEvent.fromTier}
          toTier={tierUpEvent.toTier}
          cleanPayoutNumber={tierUpEvent.cleanPayoutNumber}
        />
      )}
      <div className="space-y-6">
        {/* Smart greeting */}
        <SmartGreeting accounts={accounts ?? []} />

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
        ) : accounts?.length ? (
          <>
            {/* Portfolio Overview */}
            <PortfolioOverview
              accounts={accounts}
              totalPaidOut={totalPaidOut ?? 0}
              activeAccountHeadroomPct={
                eligibility?.lifetime_cap_amount && eligibility.lifetime_cap_amount > 0
                  ? ((eligibility.lifetime_paid_total ?? 0) / eligibility.lifetime_cap_amount) * 100
                  : null
              }
            />

            {/* Payout tracker bar — paid → first cap → lifetime cap */}
            {activeAccount && (
              <PayoutTrackerBar
                paidTotal={totalPaidOut ?? 0}
                firstPayoutCap={activeAccount.cohort?.first_payout_cap_amount ?? 500}
                lifetimeCap={eligibility?.lifetime_cap_amount ?? 1490}
              />
            )}

            {/* Account Switcher */}
            <AccountSwitcher
              accounts={accounts}
              selectedAccountId={activeAccount?.id ?? null}
              onSelect={handleSelectAccount}
            />

            {activeAccount && (
              <>
                {/* Rules at a glance — dismissible per account */}
                <RulesAtAGlanceCard account={activeAccount} />

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

                {/* PA-only: Ladder Progression */}
                {isPerformanceAccount && (
                  <>
                    <div className="grid gap-4 md:grid-cols-2">
                      <TierStatusCard progress={ladderProgress} />
                      <CleanPayoutChecklist />
                    </div>
                    <RecentPayoutsTable accountId={activeAccount.id} highlightTierUp={!!tierUpEvent} />
                    <ResetHistoryStrip />
                  </>
                )}

                {/* Primary zone: Equity Curve + Rule Health side-by-side */}
                <div className="grid gap-4 lg:grid-cols-5">
                  <div className="lg:col-span-3">
                    <EquityCurveChart
                      accountId={activeAccount.id}
                      startingBalance={activeAccount.starting_balance}
                      currentBalance={activeAccount.current_balance}
                      maxDrawdownPct={activeAccount.cohort?.max_total_drawdown_percent ?? 10}
                      profitTargetPct={activeAccount.cohort?.profit_target_percent ?? 10}
                      minTradingDays={activeAccount.cohort?.min_trading_days ?? 5}
                    />
                  </div>
                  <div className="lg:col-span-2">
                    <RuleHealthCard account={activeAccount} />
                  </div>
                </div>

                {/* Guidance zone: What's Next + Safe Day side-by-side */}
                <div className="grid gap-4 md:grid-cols-2">
                  <WhatsNextCard account={activeAccount} />
                  <SafeDayPanel account={activeAccount} />
                </div>

                {/* Consistency Preview (Challenge phase only) */}
                <ConsistencyPreviewCard account={activeAccount} />
              </>
            )}
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

        {/* Live payout ticker — social proof inside the product */}
        <LivePayoutTicker />
      </div>
    </DashboardLayout>
  );
}
