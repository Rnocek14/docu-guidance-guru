import { DashboardLayout, adminNavItems } from '@/components/layout/DashboardLayout';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Separator } from '@/components/ui/separator';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { useQuery } from '@tanstack/react-query';
import { supabase, SUPABASE_FUNCTIONS_URL } from '@/integrations/supabase/client';
import { format, subDays } from 'date-fns';
import { useState } from 'react';
import { toast } from 'sonner';
import { useAuth } from '@/contexts/AuthContext';
import {
  Shield,
  AlertTriangle,
  CheckCircle,
  XCircle,
  DollarSign,
  Users,
  TrendingUp,
  Activity,
  Lock,
  Unlock,
  Clock,
  FileText,
  Flag,
  BarChart3,
  AlertOctagon,
  Loader2,
  RefreshCw,
  Play,
} from 'lucide-react';

interface SystemStats {
  accounts: {
    total: number;
    active: number;
    breached_detected: number;
    under_review: number;
    passed: number;
    failed_confirmed: number;
    payout_requested: number;
    payout_under_review: number;
    payout_approved: number;
    closed: number;
  };
  violations: {
    total: number;
    unconfirmed: number;
    byType: Record<string, number>;
  };
  flags: {
    total: number;
    pending: number;
    escalated: number;
  };
  payouts: {
    pending_count: number;
    pending_amount: number;
    under_review_count: number;
    under_review_amount: number;
    approved_count: number;
    approved_amount: number;
    paid_last_30_days: number;
    rejected_last_30_days: number;
  };
  cohorts: {
    total: number;
    active: number;
    intake_active: number;
  };
  exposure: {
    total_current_balance: number;
    total_pnl: number;
    highest_single_account: number;
  };
  activity: {
    trades_today: number;
    trades_last_7_days: number;
    audit_logs_today: number;
    last_trade_at: string | null;
  };
}

export default function SystemOverview() {
  const { hasAnyRole } = useAuth();
  const canRunSnapshot = hasAnyRole(['admin', 'risk_officer']);
  
  // Fetch all system stats
  const [snapshotRunning, setSnapshotRunning] = useState(false);

  const runRiskSnapshot = async () => {
    setSnapshotRunning(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) {
        toast.error('No active session — please log in first');
        return;
      }

      // SUPABASE_FUNCTIONS_URL = https://<project>.supabase.co/functions/v1
      const res = await fetch(`${SUPABASE_FUNCTIONS_URL}/daily-risk-snapshot`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      });

      const json = await res.json();
      console.log('daily-risk-snapshot response:', res.status, json);

      if (res.ok) {
        // Extract proof fields explicitly
        const triggeredBy = json.triggered_by ?? '(missing)';
        const alarmsCount = json.alarms_count ?? 0;
        const econStatus = json.econ_gate?.status ?? '(n/a)';
        const autoTightenAttempted = json.summary?.auto_tightening_attempted 
          ?? (json.auto_tightening !== null ? 'see response' : 'false (JWT path)');
        const snapshotId = json.snapshot_id ?? '(no id)';

        console.log('PROOF FIELDS:', {
          snapshot_id: snapshotId,
          triggered_by: triggeredBy,
          econ_gate_status: econStatus,
          auto_tightening_attempted: autoTightenAttempted,
          alarms_count: alarmsCount,
        });

        toast.success(
          `Snapshot ${snapshotId} created. triggered_by=${triggeredBy}, econ=${econStatus}, auto_tighten=${autoTightenAttempted}`
        );
      } else {
        toast.error(`Snapshot failed: ${res.status} — ${json.error || JSON.stringify(json)}`);
      }
    } catch (err) {
      console.error('Risk snapshot error:', err);
      toast.error(`Snapshot error: ${(err as Error).message}`);
    } finally {
      setSnapshotRunning(false);
    }
  };

  const { data: stats, isLoading, refetch, isRefetching } = useQuery({
    queryKey: ['admin-system-stats'],
    queryFn: async (): Promise<SystemStats> => {
      const now = new Date();
      const today = format(now, 'yyyy-MM-dd');
      const sevenDaysAgo = format(subDays(now, 7), 'yyyy-MM-dd');
      const thirtyDaysAgo = format(subDays(now, 30), 'yyyy-MM-dd');

      // Parallel queries for efficiency
      const [
        accountsRes,
        violationsRes,
        unconfirmedViolationsRes,
        flagsRes,
        pendingFlagsRes,
        payoutsRes,
        cohortsRes,
        tradesRes,
        auditRes,
        lastTradeRes,
      ] = await Promise.all([
        // Accounts by status
        supabase.from('accounts').select('status'),
        // All violations
        supabase.from('violations').select('rule_type'),
        // Unconfirmed violations
        supabase.from('violations').select('id', { count: 'exact', head: true }).is('confirmed_at', null),
        // All flags
        supabase.from('flags').select('status'),
        // Pending flags
        supabase.from('flags').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
        // Payouts
        supabase.from('payouts').select('status, amount, paid_at, reviewed_at'),
        // Cohorts
        supabase.from('cohorts').select('is_active, intake_active'),
        // Recent trades
        supabase.from('trades').select('opened_at'),
        // Audit logs today
        supabase.from('audit_logs').select('id', { count: 'exact', head: true }).gte('created_at', today),
        // Last trade
        supabase.from('trades').select('opened_at').order('opened_at', { ascending: false }).limit(1),
      ]);

      // Process accounts
      const accountsByStatus: Record<string, number> = {};
      let totalBalance = 0;
      let totalPnl = 0;
      let highestBalance = 0;

      // Get balance data separately (select all fields)
      const { data: accountBalances } = await supabase.from('accounts').select('current_balance, total_pnl');
      
      (accountsRes.data || []).forEach((a: { status: string }) => {
        accountsByStatus[a.status] = (accountsByStatus[a.status] || 0) + 1;
      });

      (accountBalances || []).forEach((a: { current_balance: number; total_pnl: number }) => {
        const bal = Number(a.current_balance) || 0;
        totalBalance += bal;
        totalPnl += Number(a.total_pnl) || 0;
        if (bal > highestBalance) highestBalance = bal;
      });

      // Process violations by type
      const violationsByType: Record<string, number> = {};
      (violationsRes.data || []).forEach((v: { rule_type: string }) => {
        violationsByType[v.rule_type] = (violationsByType[v.rule_type] || 0) + 1;
      });

      // Process flags
      const flagsByStatus: Record<string, number> = {};
      (flagsRes.data || []).forEach((f: { status: string }) => {
        flagsByStatus[f.status] = (flagsByStatus[f.status] || 0) + 1;
      });

      // Process payouts
      let pendingCount = 0, pendingAmount = 0;
      let underReviewCount = 0, underReviewAmount = 0;
      let approvedCount = 0, approvedAmount = 0;
      let paidLast30 = 0, rejectedLast30 = 0;

      (payoutsRes.data || []).forEach((p: { status: string; amount: number; paid_at: string | null; reviewed_at: string | null }) => {
        const amt = Number(p.amount) || 0;
        if (p.status === 'pending') { pendingCount++; pendingAmount += amt; }
        if (p.status === 'under_review') { underReviewCount++; underReviewAmount += amt; }
        if (p.status === 'approved') { approvedCount++; approvedAmount += amt; }
        if (p.status === 'paid' && p.paid_at && p.paid_at >= thirtyDaysAgo) { paidLast30 += amt; }
        if (p.status === 'rejected' && p.reviewed_at && p.reviewed_at >= thirtyDaysAgo) { rejectedLast30++; }
      });

      // Process cohorts
      const activeCohorts = (cohortsRes.data || []).filter((c: { is_active: boolean }) => c.is_active).length;
      const intakeActive = (cohortsRes.data || []).filter((c: { intake_active: boolean }) => c.intake_active).length;

      // Process trades
      const tradesToday = (tradesRes.data || []).filter((t: { opened_at: string }) => t.opened_at >= today).length;
      const tradesLast7 = (tradesRes.data || []).filter((t: { opened_at: string }) => t.opened_at >= sevenDaysAgo).length;

      return {
        accounts: {
          total: (accountsRes.data || []).length,
          active: accountsByStatus['active'] || 0,
          breached_detected: accountsByStatus['breached_detected'] || 0,
          under_review: accountsByStatus['under_review'] || 0,
          passed: accountsByStatus['passed'] || 0,
          failed_confirmed: accountsByStatus['failed_confirmed'] || 0,
          payout_requested: accountsByStatus['payout_requested'] || 0,
          payout_under_review: accountsByStatus['payout_under_review'] || 0,
          payout_approved: accountsByStatus['payout_approved'] || 0,
          closed: accountsByStatus['closed'] || 0,
        },
        violations: {
          total: (violationsRes.data || []).length,
          unconfirmed: unconfirmedViolationsRes.count || 0,
          byType: violationsByType,
        },
        flags: {
          total: (flagsRes.data || []).length,
          pending: pendingFlagsRes.count || 0,
          escalated: flagsByStatus['escalated'] || 0,
        },
        payouts: {
          pending_count: pendingCount,
          pending_amount: pendingAmount,
          under_review_count: underReviewCount,
          under_review_amount: underReviewAmount,
          approved_count: approvedCount,
          approved_amount: approvedAmount,
          paid_last_30_days: paidLast30,
          rejected_last_30_days: rejectedLast30,
        },
        cohorts: {
          total: (cohortsRes.data || []).length,
          active: activeCohorts,
          intake_active: intakeActive,
        },
        exposure: {
          total_current_balance: totalBalance,
          total_pnl: totalPnl,
          highest_single_account: highestBalance,
        },
        activity: {
          trades_today: tradesToday,
          trades_last_7_days: tradesLast7,
          audit_logs_today: auditRes.count || 0,
          last_trade_at: lastTradeRes.data?.[0]?.opened_at || null,
        },
      };
    },
    refetchInterval: 30000, // Auto-refresh every 30 seconds
  });

  // Calculate risk level based on stats
  const getRiskLevel = () => {
    if (!stats) return { level: 'unknown', color: 'secondary' };
    
    const criticalConditions = [
      stats.violations.unconfirmed > 5,
      stats.flags.pending > 3,
      stats.payouts.pending_amount > 50000,
      stats.accounts.breached_detected > 3,
    ];
    
    const warningConditions = [
      stats.violations.unconfirmed > 0,
      stats.flags.pending > 0,
      stats.payouts.pending_amount > 10000,
      stats.accounts.breached_detected > 0,
    ];

    const criticalCount = criticalConditions.filter(Boolean).length;
    const warningCount = warningConditions.filter(Boolean).length;

    if (criticalCount >= 2) return { level: 'Critical', color: 'destructive' };
    if (criticalCount >= 1 || warningCount >= 3) return { level: 'Warning', color: 'warning' };
    if (warningCount > 0) return { level: 'Elevated', color: 'outline' };
    return { level: 'Normal', color: 'secondary' };
  };

  const riskLevel = getRiskLevel();

  if (isLoading) {
    return (
      <DashboardLayout title="System Overview" navItems={adminNavItems}>
        <div className="flex items-center justify-center h-64">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout title="System Overview" navItems={adminNavItems}>
      <div className="space-y-6">
        {/* Header with refresh */}
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-bold tracking-tight">System Command Center</h2>
            <p className="text-muted-foreground">
              Real-time visibility into platform health, rules, and safeguards
            </p>
          </div>
          <div className="flex items-center gap-4">
            <Badge variant={riskLevel.color as 'default' | 'secondary' | 'destructive' | 'outline'} className="text-sm px-3 py-1">
              {riskLevel.level === 'Critical' && <AlertOctagon className="h-4 w-4 mr-1" />}
              {riskLevel.level === 'Warning' && <AlertTriangle className="h-4 w-4 mr-1" />}
              {riskLevel.level === 'Normal' && <CheckCircle className="h-4 w-4 mr-1" />}
              Risk: {riskLevel.level}
            </Badge>
            {canRunSnapshot && (
              <Button
                variant="outline"
                size="sm"
                onClick={runRiskSnapshot}
                disabled={snapshotRunning}
                className="gap-2"
              >
                {snapshotRunning ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                Run Risk Snapshot
              </Button>
            )}
            <button
              onClick={() => refetch()}
              className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
              disabled={isRefetching}
            >
              <RefreshCw className={`h-4 w-4 ${isRefetching ? 'animate-spin' : ''}`} />
              Refresh
            </button>
          </div>
        </div>

        {/* Critical Alerts */}
        {stats && (stats.violations.unconfirmed > 0 || stats.flags.pending > 0 || stats.accounts.breached_detected > 0) && (
          <div className="space-y-3">
            {stats.violations.unconfirmed > 0 && (
              <Alert variant="destructive">
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle>Unconfirmed Violations</AlertTitle>
                <AlertDescription>
                  {stats.violations.unconfirmed} violation(s) require human review before accounts can be marked as failed or passed.
                </AlertDescription>
              </Alert>
            )}
            {stats.flags.pending > 0 && (
              <Alert>
                <Flag className="h-4 w-4" />
                <AlertTitle>Pending Flags</AlertTitle>
                <AlertDescription>
                  {stats.flags.pending} flag(s) require attention. These block auto-pass and may indicate abuse.
                </AlertDescription>
              </Alert>
            )}
            {stats.accounts.breached_detected > 0 && (
              <Alert variant="destructive">
                <AlertOctagon className="h-4 w-4" />
                <AlertTitle>Breaches Detected</AlertTitle>
                <AlertDescription>
                  {stats.accounts.breached_detected} account(s) have breaches detected awaiting confirmation or clearing.
                </AlertDescription>
              </Alert>
            )}
          </div>
        )}

        {/* Account State Distribution */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Users className="h-5 w-5" />
              Account State Machine
            </CardTitle>
            <CardDescription>
              Current distribution of all {stats?.accounts.total || 0} accounts across lifecycle states
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
              <div className="text-center p-3 bg-success/10 rounded-lg">
                <div className="text-2xl font-bold text-success">{stats?.accounts.active || 0}</div>
                <div className="text-xs text-muted-foreground">Active</div>
              </div>
              <div className="text-center p-3 bg-destructive/10 rounded-lg">
                <div className="text-2xl font-bold text-destructive">{stats?.accounts.breached_detected || 0}</div>
                <div className="text-xs text-muted-foreground">Breached</div>
              </div>
              <div className="text-center p-3 bg-warning/10 rounded-lg">
                <div className="text-2xl font-bold text-warning">{stats?.accounts.under_review || 0}</div>
                <div className="text-xs text-muted-foreground">Under Review</div>
              </div>
              <div className="text-center p-3 bg-primary/10 rounded-lg">
                <div className="text-2xl font-bold text-primary">{stats?.accounts.passed || 0}</div>
                <div className="text-xs text-muted-foreground">Passed</div>
              </div>
              <div className="text-center p-3 bg-muted rounded-lg">
                <div className="text-2xl font-bold">{stats?.accounts.failed_confirmed || 0}</div>
                <div className="text-xs text-muted-foreground">Failed</div>
              </div>
            </div>
            <Separator className="my-4" />
            <div className="grid grid-cols-4 gap-4 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Payout Requested</span>
                <Badge variant="outline">{stats?.accounts.payout_requested || 0}</Badge>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Payout Review</span>
                <Badge variant="outline">{stats?.accounts.payout_under_review || 0}</Badge>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Payout Approved</span>
                <Badge variant="outline">{stats?.accounts.payout_approved || 0}</Badge>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Closed</span>
                <Badge variant="secondary">{stats?.accounts.closed || 0}</Badge>
              </div>
            </div>
          </CardContent>
        </Card>

        <div className="grid gap-6 md:grid-cols-2">
          {/* Financial Exposure */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <DollarSign className="h-5 w-5" />
                Financial Exposure
              </CardTitle>
              <CardDescription>
                Current platform liability and payout pipeline
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <div className="text-sm text-muted-foreground">Total Active Balances</div>
                  <div className="text-2xl font-bold">${(stats?.exposure.total_current_balance || 0).toLocaleString()}</div>
                </div>
                <div>
                  <div className="text-sm text-muted-foreground">Total P&L (all accounts)</div>
                  <div className={`text-2xl font-bold ${(stats?.exposure.total_pnl || 0) >= 0 ? 'text-success' : 'text-destructive'}`}>
                    {(stats?.exposure.total_pnl || 0) >= 0 ? '+' : ''}${(stats?.exposure.total_pnl || 0).toLocaleString()}
                  </div>
                </div>
              </div>
              <Separator />
              <div className="space-y-3">
                <div className="flex justify-between items-center">
                  <span className="text-sm">Pending Payouts</span>
                  <span className="font-medium">{stats?.payouts.pending_count || 0} (${(stats?.payouts.pending_amount || 0).toLocaleString()})</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-sm">Under Review</span>
                  <span className="font-medium">{stats?.payouts.under_review_count || 0} (${(stats?.payouts.under_review_amount || 0).toLocaleString()})</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-sm">Approved (awaiting payment)</span>
                  <span className="font-medium text-warning">{stats?.payouts.approved_count || 0} (${(stats?.payouts.approved_amount || 0).toLocaleString()})</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-sm">Paid (last 30 days)</span>
                  <span className="font-medium text-success">${(stats?.payouts.paid_last_30_days || 0).toLocaleString()}</span>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Rule Enforcement & Safeguards */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Shield className="h-5 w-5" />
                Safeguards & Controls
              </CardTitle>
              <CardDescription>
                Active protections and enforcement status
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="flex items-center gap-2 p-3 bg-muted rounded-lg">
                  {(stats?.cohorts.intake_active || 0) > 0 ? (
                    <Unlock className="h-5 w-5 text-success" />
                  ) : (
                    <Lock className="h-5 w-5 text-destructive" />
                  )}
                  <div>
                    <div className="font-medium">Intake Status</div>
                    <div className="text-xs text-muted-foreground">
                      {(stats?.cohorts.intake_active || 0) > 0 ? 'Active' : 'Paused'}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2 p-3 bg-muted rounded-lg">
                  <BarChart3 className="h-5 w-5 text-primary" />
                  <div>
                    <div className="font-medium">{stats?.cohorts.active || 0} Cohorts</div>
                    <div className="text-xs text-muted-foreground">Active rule sets</div>
                  </div>
                </div>
              </div>
              <Separator />
              <div className="space-y-2">
                <div className="text-sm font-medium">Protection Layers</div>
                <div className="space-y-2 text-sm">
                  <div className="flex items-center gap-2">
                    <CheckCircle className="h-4 w-4 text-success" />
                    <span>Rule snapshots frozen at account creation</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <CheckCircle className="h-4 w-4 text-success" />
                    <span>Breach detection requires human confirmation</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <CheckCircle className="h-4 w-4 text-success" />
                    <span>Trade ingestion is idempotent (deduplicated)</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <CheckCircle className="h-4 w-4 text-success" />
                    <span>Payouts require admin approval</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <CheckCircle className="h-4 w-4 text-success" />
                    <span>DST-safe daily reset (5PM ET boundary)</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <CheckCircle className="h-4 w-4 text-success" />
                    <span>Evidence pack export with SHA-256 integrity</span>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Violations by Type */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <AlertTriangle className="h-5 w-5" />
                Violations Breakdown
              </CardTitle>
              <CardDescription>
                {stats?.violations.total || 0} total, {stats?.violations.unconfirmed || 0} unconfirmed
              </CardDescription>
            </CardHeader>
            <CardContent>
              {stats?.violations.total === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  No violations recorded yet
                </div>
              ) : (
                <div className="space-y-3">
                  {Object.entries(stats?.violations.byType || {}).map(([type, count]) => (
                    <div key={type} className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Badge variant={type.includes('daily') ? 'destructive' : 'outline'}>
                          {type.replace(/_/g, ' ')}
                        </Badge>
                      </div>
                      <div className="flex items-center gap-2">
                        <Progress value={(count / (stats?.violations.total || 1)) * 100} className="w-24 h-2" />
                        <span className="text-sm font-medium w-8 text-right">{count}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Activity Monitor */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Activity className="h-5 w-5" />
                Activity Monitor
              </CardTitle>
              <CardDescription>
                Trade ingestion and audit activity
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="text-center p-3 bg-muted rounded-lg">
                  <div className="text-2xl font-bold">{stats?.activity.trades_today || 0}</div>
                  <div className="text-xs text-muted-foreground">Trades Today</div>
                </div>
                <div className="text-center p-3 bg-muted rounded-lg">
                  <div className="text-2xl font-bold">{stats?.activity.trades_last_7_days || 0}</div>
                  <div className="text-xs text-muted-foreground">Trades (7 days)</div>
                </div>
              </div>
              <Separator />
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Audit entries today</span>
                  <span className="font-medium">{stats?.activity.audit_logs_today || 0}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Last trade received</span>
                  <span className="font-medium">
                    {stats?.activity.last_trade_at
                      ? format(new Date(stats.activity.last_trade_at), 'MMM d, HH:mm')
                      : 'Never'}
                  </span>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Quick Reference: Rule Thresholds */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FileText className="h-5 w-5" />
              Active Cohort Rules (Quick Reference)
            </CardTitle>
            <CardDescription>
              Current evaluation rules across all active cohorts
            </CardDescription>
          </CardHeader>
          <CardContent>
            <CohortRulesTable />
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}

// Separate component for cohort rules to avoid prop drilling
function CohortRulesTable() {
  const { data: cohorts, isLoading } = useQuery({
    queryKey: ['admin-cohorts-overview'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('cohorts')
        .select('*')
        .eq('is_active', true)
        .order('name');
      if (error) throw error;
      return data;
    },
  });

  if (isLoading) {
    return <div className="h-20 flex items-center justify-center text-muted-foreground">Loading cohorts...</div>;
  }

  if (!cohorts?.length) {
    return <div className="text-center py-4 text-muted-foreground">No active cohorts configured</div>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b">
            <th className="text-left py-2 font-medium">Cohort</th>
            <th className="text-right py-2 font-medium">Profit Target</th>
            <th className="text-right py-2 font-medium">Max Daily Loss</th>
            <th className="text-right py-2 font-medium">Max Drawdown</th>
            <th className="text-right py-2 font-medium">Min Days</th>
            <th className="text-center py-2 font-medium">Intake</th>
          </tr>
        </thead>
        <tbody>
          {cohorts.map((cohort) => (
            <tr key={cohort.id} className="border-b last:border-0">
              <td className="py-2">
                <div className="font-medium">{cohort.name}</div>
                <div className="text-xs text-muted-foreground">v{cohort.version}</div>
              </td>
              <td className="text-right py-2">{cohort.profit_target_percent}%</td>
              <td className="text-right py-2 text-destructive">{cohort.max_daily_loss_percent}%</td>
              <td className="text-right py-2 text-warning">{cohort.max_total_drawdown_percent}%</td>
              <td className="text-right py-2">{cohort.min_trading_days}</td>
              <td className="text-center py-2">
                {cohort.intake_active ? (
                  <Badge variant="default" className="text-xs">Open</Badge>
                ) : (
                  <Badge variant="secondary" className="text-xs">Closed</Badge>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
