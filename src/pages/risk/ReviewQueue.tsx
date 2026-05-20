import { useState, useEffect, useRef, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { DashboardLayout, riskNavItems, adminNavItems } from '@/components/layout/DashboardLayout';
import { useAuth } from '@/contexts/AuthContext';
import { ReviewQueueCard } from '@/components/risk/ReviewQueueCard';
import { ReviewBrief } from '@/components/risk/ReviewBrief';
import { AccountReviewActions } from '@/components/risk/AccountReviewActions';
import { RuleSnapshotCard } from '@/components/trader/RuleSnapshotCard';
import { AccountTimeline } from '@/components/trader/AccountTimeline';
import { BreachExplainer } from '@/components/trader/BreachExplainer';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Input } from '@/components/ui/input';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { ScrollArea } from '@/components/ui/scroll-area';
import { AlertTriangle, Clock, DollarSign, RefreshCw, Users, Keyboard, Search, X } from 'lucide-react';
import { Info } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { Violation } from '@/lib/types';
import { sortByPriority, calculatePriorityScore, getPriorityLabel } from '@/lib/queue-priority';
import { useKeyboardNavigation } from '@/hooks/use-keyboard-navigation';

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

interface QueueAccount {
  id: string;
  account_number: string;
  status: string;
  current_balance: number;
  starting_balance: number;
  highest_balance: number;
  total_pnl: number;
  daily_pnl: number;
  trading_days_count: number;
  created_at: string;
  updated_at: string;
  user_id: string;
  rule_snapshot: RuleSnapshot | null;
  last_trade_at: string | null;
  last_event_at?: string | null;
  priority_score?: number;
}

const statusFilters = [
  { value: 'all', label: 'All Pending', icon: Users },
  { value: 'breached_detected', label: 'Breaches', icon: AlertTriangle },
  { value: 'under_review', label: 'Under Review', icon: Clock },
  { value: 'payout_requested', label: 'Payouts', icon: DollarSign },
];

const tabContext: Record<string, { title: string; what: string; why: string; action: string }> = {
  all: {
    title: 'All Pending Reviews',
    what: 'Every account currently waiting on a human decision — breaches, manual reviews, and payout requests combined.',
    why: 'A single triage view so nothing falls through the cracks. Sorted by priority score (severity + age).',
    action: 'Work top-down. Highest-priority items render first.',
  },
  breached_detected: {
    title: 'Breaches — Detected by the System',
    what: 'Accounts the rule engine flagged as having violated a hard rule (daily loss, total drawdown, position size, etc.).',
    why: 'The system has paused trading but is waiting on you to confirm the breach or override it (e.g. bad market data, platform glitch). Money does not move until you decide.',
    action: 'Open each card → review the Breach Explainer and Rule Snapshot → Confirm Breach or Reverse.',
  },
  under_review: {
    title: 'Under Manual Review',
    what: 'Accounts a human (you, support, or risk) placed on hold — usually for suspicious activity, fraud signals, or KYC follow-up.',
    why: 'Trading is paused while you investigate. These do not auto-resolve; they sit here until you act.',
    action: 'Review the timeline + flags → either clear the account back to active or escalate to a breach.',
  },
  payout_requested: {
    title: 'Payout Requests',
    what: 'Traders who have submitted a withdrawal and are waiting for approval. Includes both newly requested and already-under-review payouts.',
    why: 'Every payout needs a clean-payout check (rule compliance, reserve gate, breaker level, fraud signals) before money leaves. The system pre-screens; you give the final yes/no.',
    action: 'Open each → verify the trader\'s rule snapshot, recent activity, and any flags → Approve or Deny.',
  },
};

export default function ReviewQueue() {
  const { roles } = useAuth();
  const isAdmin = roles.includes('admin');
  const navItems = isAdmin ? adminNavItems : riskNavItems;
  const navigate = useNavigate();
  const [statusFilter, setStatusFilter] = useState('all');
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const gridRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Fetch accounts needing review
  const { data: accounts, isLoading, refetch } = useQuery({
    queryKey: ['review-queue', statusFilter],
    queryFn: async () => {
      let query = supabase
        .from('accounts')
        .select('*')
        .order('updated_at', { ascending: false });

      if (statusFilter === 'all') {
        query = query.in('status', ['breached_detected', 'under_review', 'payout_requested', 'payout_under_review'] as const);
      } else {
        query = query.eq('status', statusFilter as 'breached_detected' | 'under_review' | 'payout_requested' | 'payout_under_review');
      }

      const { data, error } = await query.limit(50);
      if (error) throw error;

      // Get profiles and counts for each account
      const accountIds = data.map(a => a.id);
      const userIds = [...new Set(data.map(a => a.user_id))];

      const [profilesRes, flagsRes, violationsRes, lastEventsRes, payoutsRes] = await Promise.all([
        supabase.from('profiles').select('user_id, full_name, email').in('user_id', userIds),
        // Include flag id for single-flag close action
        supabase.from('flags').select('id, account_id').in('account_id', accountIds).eq('status', 'pending'),
        supabase.from('violations').select('account_id, rule_type, actual_value, rule_threshold').in('account_id', accountIds).is('confirmed_at', null),
        // Use the view for efficient last_event lookup (1 row per account)
        supabase.from('account_last_event').select('account_id, last_event_at').in('account_id', accountIds),
        // Fetch pending payout amounts for inline summaries
        supabase.from('payouts').select('account_id, amount').in('account_id', accountIds).in('status', ['pending', 'under_review']),
      ]);

      const profilesMap = new Map(profilesRes.data?.map(p => [p.user_id, p]) || []);
      const flagsCounts = new Map<string, number>();
      // Map single flag id when count is exactly 1
      const singleFlagIdMap = new Map<string, string>();
      const flagsByAccount = new Map<string, Array<{ id: string; account_id: string }>>();
      const violationsCounts = new Map<string, number>();
      const violationsMap = new Map<string, typeof violationsRes.data>();

      flagsRes.data?.forEach(f => {
        flagsCounts.set(f.account_id, (flagsCounts.get(f.account_id) || 0) + 1);
        const existing = flagsByAccount.get(f.account_id) || [];
        existing.push(f);
        flagsByAccount.set(f.account_id, existing);
      });
      // Set single flag id for accounts with exactly 1 pending flag
      flagsByAccount.forEach((flags, accountId) => {
        if (flags.length === 1) {
          singleFlagIdMap.set(accountId, flags[0].id);
        }
      });
      
      violationsRes.data?.forEach(v => {
        violationsCounts.set(v.account_id, (violationsCounts.get(v.account_id) || 0) + 1);
        const existing = violationsMap.get(v.account_id) || [];
        existing.push(v);
        violationsMap.set(v.account_id, existing);
      });

      // Get last event time per account from the view (already aggregated)
      const lastEventMap = new Map<string, string>();
      lastEventsRes.data?.forEach(e => {
        if (e.last_event_at) {
          lastEventMap.set(e.account_id, e.last_event_at);
        }
      });

      // Get payout amounts for inline summaries
      const payoutAmountMap = new Map<string, number>();
      payoutsRes.data?.forEach(p => {
        payoutAmountMap.set(p.account_id, p.amount);
      });

      const enrichedAccounts = data.map(account => ({
        ...account,
        rule_snapshot: account.rule_snapshot as unknown as RuleSnapshot | null,
        profile: profilesMap.get(account.user_id),
        flags_count: flagsCounts.get(account.id) || 0,
        single_flag_id: singleFlagIdMap.get(account.id) || null,
        violations_count: violationsCounts.get(account.id) || 0,
        violations: violationsMap.get(account.id) || [],
        last_event_at: lastEventMap.get(account.id) || null,
        payout_amount: payoutAmountMap.get(account.id),
      }));

      // Calculate priority scores and sort
      const withPriority = enrichedAccounts.map(account => ({
        ...account,
        priority_score: calculatePriorityScore(account, violationsMap.get(account.id)),
      }));

      return sortByPriority(withPriority, violationsMap as unknown as Map<string, { rule_type: string; actual_value: number | null; rule_threshold: number | null }[]>);
    },
  });

  // Client-side search filter
  const filteredAccounts = useMemo(() => {
    if (!accounts || !searchQuery.trim()) return accounts || [];
    
    const query = searchQuery.toLowerCase().trim();
    return accounts.filter(account => 
      account.account_number.toLowerCase().includes(query) ||
      account.profile?.full_name?.toLowerCase().includes(query) ||
      account.profile?.email?.toLowerCase().includes(query)
    );
  }, [accounts, searchQuery]);

  const clearSearch = () => {
    setSearchQuery('');
    setSelectedIndex(-1); // Reset selection when clearing search
  };

  // Keyboard navigation
  const { selectedIndex, setSelectedIndex } = useKeyboardNavigation({
    items: filteredAccounts,
    onSelect: (account) => handleViewDetails(account.id),
    enabled: selectedAccountId === null, // Disable when sheet is open
    searchInputRef,
    onSearchClear: clearSearch,
    hasSearchText: searchQuery.length > 0,
  });

  // Scroll selected card into view
  useEffect(() => {
    if (selectedIndex >= 0 && gridRef.current) {
      const cards = gridRef.current.querySelectorAll('[data-queue-card]');
      cards[selectedIndex]?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [selectedIndex]);

  // Fetch selected account details
  const { data: selectedAccount } = useQuery({
    queryKey: ['review-account-details', selectedAccountId],
    queryFn: async () => {
      if (!selectedAccountId) return null;

      const [accountRes, violationsRes, lastEventRes] = await Promise.all([
        supabase.from('accounts').select('*').eq('id', selectedAccountId).single(),
        supabase.from('violations').select('*').eq('account_id', selectedAccountId).order('detected_at', { ascending: false }),
        supabase.from('account_events').select('created_at').eq('account_id', selectedAccountId).order('created_at', { ascending: false }).limit(1),
      ]);

      if (accountRes.error) throw accountRes.error;

      // Get profile
      const { data: profile } = await supabase
        .from('profiles')
        .select('full_name, email')
        .eq('user_id', accountRes.data.user_id)
        .single();

      // Get flags count
      const { count: flagsCount } = await supabase
        .from('flags')
        .select('id', { count: 'exact', head: true })
        .eq('account_id', selectedAccountId)
        .eq('status', 'pending');

      return {
        ...accountRes.data,
        rule_snapshot: accountRes.data.rule_snapshot as unknown as RuleSnapshot | null,
        violations: violationsRes.data as Violation[],
        profile,
        flags_count: flagsCount || 0,
        last_event_at: lastEventRes.data?.[0]?.created_at || null,
      };
    },
    enabled: !!selectedAccountId,
  });

  const handleViewDetails = (accountId: string) => {
    setSelectedAccountId(accountId);
  };

  const handleCloseSheet = () => {
    setSelectedAccountId(null);
  };

  const queueCounts = {
    all: accounts?.length || 0,
    breached_detected: accounts?.filter(a => a.status === 'breached_detected').length || 0,
    under_review: accounts?.filter(a => a.status === 'under_review').length || 0,
    payout_requested: accounts?.filter(a => ['payout_requested', 'payout_under_review'].includes(a.status)).length || 0,
  };

  return (
    <DashboardLayout title="Review Queue" navItems={navItems}>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-2xl font-bold tracking-tight">Review Queue</h2>
            <p className="text-muted-foreground">
              Accounts requiring human review. Sorted by severity.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {/* Search input */}
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                ref={searchInputRef}
                type="text"
                placeholder="Search... (press /)"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9 pr-8 h-9 w-48 md:w-64"
              />
              {searchQuery && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="absolute right-1 top-1/2 -translate-y-1/2 h-6 w-6"
                  onClick={clearSearch}
                >
                  <X className="h-3 w-3" />
                </Button>
              )}
            </div>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" className="h-8 w-8">
                  <Keyboard className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs">
                <p className="font-medium mb-1">Keyboard shortcuts</p>
                <p>/ — Focus search</p>
                <p>J/↓ — Next account</p>
                <p>K/↑ — Previous account</p>
                <p>Enter — Open selected</p>
                <p>Esc — Clear search/selection</p>
              </TooltipContent>
            </Tooltip>
            <Button variant="outline" size="sm" onClick={() => refetch()}>
              <RefreshCw className="h-4 w-4 mr-2" />
              Refresh
            </Button>
          </div>
        </div>

        {/* Filter tabs */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <Tabs value={statusFilter} onValueChange={setStatusFilter}>
            <TabsList>
              {statusFilters.map((filter) => (
                <TabsTrigger key={filter.value} value={filter.value} className="gap-2">
                  <filter.icon className="h-4 w-4" />
                  {filter.label}
                  <Badge variant="secondary" className="ml-1 text-xs">
                    {queueCounts[filter.value as keyof typeof queueCounts] || 0}
                  </Badge>
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          
          {/* Search results indicator */}
          {searchQuery && (
            <p className="text-sm text-muted-foreground">
              Showing {filteredAccounts.length} of {accounts?.length || 0} accounts
            </p>
          )}
        </div>

        {/* Per-tab context: what am I reviewing and why */}
        {tabContext[statusFilter] && (
          <Card className="border-l-4 border-l-primary/60 bg-muted/30">
            <CardHeader className="py-4">
              <div className="flex items-start gap-3">
                <Info className="h-5 w-5 text-primary mt-0.5 shrink-0" />
                <div className="space-y-2">
                  <CardTitle className="text-base">{tabContext[statusFilter].title}</CardTitle>
                  <div className="grid gap-2 sm:grid-cols-3 text-sm">
                    <div>
                      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-1">What</p>
                      <p className="text-foreground/90">{tabContext[statusFilter].what}</p>
                    </div>
                    <div>
                      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-1">Why review</p>
                      <p className="text-foreground/90">{tabContext[statusFilter].why}</p>
                    </div>
                    <div>
                      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-1">How to act</p>
                      <p className="text-foreground/90">{tabContext[statusFilter].action}</p>
                    </div>
                  </div>
                </div>
              </div>
            </CardHeader>
          </Card>
        )}

        {/* Queue list */}
        {isLoading ? (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-48" />
            ))}
          </div>
        ) : filteredAccounts.length > 0 ? (
          <div ref={gridRef} className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {filteredAccounts.map((account, index) => (
              <ReviewQueueCard
                key={account.id}
                account={account}
                onViewDetails={handleViewDetails}
                onActionComplete={() => {
                  setSelectedIndex(-1); // Reset selection to avoid jump after resort
                  refetch();
                }}
                isSelected={index === selectedIndex}
                priorityScore={account.priority_score}
              />
            ))}
          </div>
        ) : searchQuery ? (
          <Card>
            <CardHeader>
              <CardTitle>No Matches</CardTitle>
              <CardDescription>
                No accounts match "{searchQuery}". Try a different search term.
              </CardDescription>
            </CardHeader>
          </Card>
        ) : (
          <Card>
            <CardHeader>
              <CardTitle>Queue Empty</CardTitle>
              <CardDescription>
                No accounts currently require review. All systems operational.
              </CardDescription>
            </CardHeader>
          </Card>
        )}

        {/* Account Review Sheet */}
        <Sheet open={selectedAccountId !== null} onOpenChange={(open) => !open && handleCloseSheet()}>
          <SheetContent className="w-full sm:max-w-2xl overflow-y-auto">
            <SheetHeader>
              <SheetTitle className="flex items-center gap-2">
                Account Review
                {selectedAccount && (
                  <Badge variant="outline">#{selectedAccount.account_number}</Badge>
                )}
              </SheetTitle>
              <SheetDescription>
                {selectedAccount?.profile?.full_name || 'Unknown'} • {selectedAccount?.profile?.email}
              </SheetDescription>
            </SheetHeader>

            {selectedAccount && (
              <ScrollArea className="h-[calc(100vh-120px)] pr-4">
                <div className="space-y-6 py-6">
                  {/* Actions */}
                  <div className="p-4 bg-muted/50 rounded-lg space-y-3">
                    <p className="text-sm font-medium">Available Actions</p>
                    <AccountReviewActions
                      accountId={selectedAccount.id}
                      accountNumber={selectedAccount.account_number}
                      accountStatus={selectedAccount.status}
                      onActionComplete={() => {
                        refetch();
                        handleCloseSheet();
                      }}
                    />
                  </div>

                  {/* Review Brief */}
                  <ReviewBrief
                    account={{
                      ...selectedAccount,
                      rule_snapshot: selectedAccount.rule_snapshot,
                    }}
                    violations={selectedAccount.violations || []}
                    flagsCount={selectedAccount.flags_count}
                    lastEventAt={selectedAccount.last_event_at}
                  />

                  {/* Breach Explainer */}
                  {selectedAccount.violations && selectedAccount.violations.length > 0 && (
                    <BreachExplainer
                      violations={selectedAccount.violations}
                      accountStatus={selectedAccount.status}
                    />
                  )}

                  {/* Rule Snapshot */}
                  <RuleSnapshotCard ruleSnapshot={selectedAccount.rule_snapshot} />

                  {/* Timeline */}
                  <AccountTimeline accountId={selectedAccount.id} maxHeight="300px" />
                </div>
              </ScrollArea>
            )}
          </SheetContent>
        </Sheet>
      </div>
    </DashboardLayout>
  );
}
