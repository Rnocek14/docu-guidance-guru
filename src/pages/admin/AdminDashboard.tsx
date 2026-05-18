import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { missionControlNavItems } from '@/components/layout/AdminNav';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { supabase, SUPABASE_FUNCTIONS_URL } from '@/integrations/supabase/client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Users, CreditCard, Shield, Settings, AlertTriangle, TrendingUp, TrendingDown, DollarSign, Banknote } from 'lucide-react';
import { toast } from 'sonner';
import { DisputeRateCard } from '@/components/admin/DisputeRateCard';
import { RiskThrottlePanel } from '@/components/admin/RiskThrottlePanel';
import { QaApprovePanel } from '@/components/admin/QaApprovePanel';

export default function AdminDashboard() {
  const queryClient = useQueryClient();

  // Fetch summary stats
  const { data: stats } = useQuery({
    queryKey: ['admin-stats'],
    queryFn: async () => {
      const [usersRes, accountsRes, payoutsRes, evalAccountsRes, paidPayoutsRes, pendingPayoutsAmtRes, resetRevenueRes] = await Promise.all([
        supabase.from('profiles').select('id', { count: 'exact' }),
        supabase.from('accounts').select('status', { count: 'exact' }),
        supabase.from('payouts').select('status', { count: 'exact' }).eq('status', 'pending'),
        // Revenue: count eval accounts × their cohort entry_fee
        supabase.from('accounts').select('id, cohorts!inner(entry_fee, cohort_phase)').not('cohorts.entry_fee', 'is', null),
        supabase.from('payouts').select('amount').in('status', ['paid', 'paid_confirmed']),
        supabase.from('payouts').select('amount').eq('status', 'pending'),
        // Reset fees — accounting SSOT: totalRevenue = entry_fees + reset_fees
        supabase.from('payment_transactions').select('amount').eq('purpose', 'reset_fee').eq('status', 'completed'),
      ]);

      // Revenue = entry fees + reset fees (matches simulation accounting)
      const entryRevenue = (evalAccountsRes.data || []).reduce((sum, a) => {
        const fee = Number((a.cohorts as any)?.entry_fee || 0);
        return sum + fee;
      }, 0);
      const resetRevenue = (resetRevenueRes.data || []).reduce(
        (sum, t) => sum + Number(t.amount || 0),
        0
      );
      const totalRevenue = entryRevenue + resetRevenue;
      const totalPaid = (paidPayoutsRes.data || []).reduce((sum, p) => sum + Number(p.amount || 0), 0);
      const totalPendingAmt = (pendingPayoutsAmtRes.data || []).reduce((sum, p) => sum + Number(p.amount || 0), 0);

      return {
        totalUsers: usersRes.count || 0,
        totalAccounts: accountsRes.count || 0,
        pendingPayouts: payoutsRes.count || 0,
        totalRevenue,
        entryRevenue,
        resetRevenue,
        totalPaid,
        totalPendingAmt,
      };
    },
  });

  // Fetch intake setting
  const { data: intakeSetting } = useQuery({
    queryKey: ['intake-setting'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('system_settings')
        .select('*')
        .eq('key', 'global_intake_active')
        .single();

      if (error) throw error;
      return data;
    },
  });

  // Toggle intake mutation - calls Edge Function (server-side audit logging)
  const toggleIntake = useMutation({
    mutationFn: async (newValue: boolean) => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Not authenticated');

      const response = await fetch(
        `${SUPABASE_FUNCTIONS_URL}/admin-actions`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({
            action: 'toggle_intake',
            value: newValue,
          }),
        }
      );

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to toggle intake');
      }

      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['intake-setting'] });
      toast.success('Intake setting updated');
    },
    onError: (error: Error) => {
      toast.error(error.message || 'Failed to update intake setting');
    },
  });

  const isIntakeActive = intakeSetting?.value === true || intakeSetting?.value === 'true';

  return (
    <DashboardLayout title="Admin Panel" navItems={missionControlNavItems}>
      <div className="space-y-6">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">System Overview</h2>
          <p className="text-muted-foreground">
            Manage users, payouts, and system configuration.
          </p>
        </div>

        {/* Critical control: Intake switch */}
        <Card className="border-primary">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Shield className="h-5 w-5" />
              Global Intake Control
            </CardTitle>
            <CardDescription>
              Master switch for new account creation. This is the PRIMARY risk control mechanism.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between">
              <div className="space-y-1">
                <p className="font-medium">
                  New Account Registration: {isIntakeActive ? 'Open' : 'Paused'}
                </p>
                <p className="text-sm text-muted-foreground">
                  {isIntakeActive
                    ? 'New traders can create accounts'
                    : 'New account creation is disabled'}
                </p>
              </div>
              <div className="flex items-center gap-4">
                <Badge variant={isIntakeActive ? 'default' : 'destructive'}>
                  {isIntakeActive ? 'ACTIVE' : 'PAUSED'}
                </Badge>
                <Switch
                  checked={isIntakeActive}
                  onCheckedChange={(checked) => toggleIntake.mutate(checked)}
                  disabled={toggleIntake.isPending}
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Dispute Rate Monitor — processor threshold defense */}
        <DisputeRateCard />

        {/* Pass-Rate Throttle — automated liquidity control */}
        <RiskThrottlePanel />

        {/* Stats grid */}
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Users</CardTitle>
              <Users className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats?.totalUsers || 0}</div>
              <p className="text-xs text-muted-foreground">Registered traders</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Accounts</CardTitle>
              <Settings className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats?.totalAccounts || 0}</div>
              <p className="text-xs text-muted-foreground">Trading accounts</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Revenue</CardTitle>
              <DollarSign className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                ${(stats?.totalRevenue ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </div>
              <p className="text-xs text-muted-foreground">Entry + reset fees collected</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Paid Out</CardTitle>
              <Banknote className="h-4 w-4 text-destructive" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-destructive">
                −${(stats?.totalPaid ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </div>
              <p className="text-xs text-muted-foreground">Confirmed payouts</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Pending Payouts</CardTitle>
              <CreditCard className="h-4 w-4 text-warning" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats?.pendingPayouts || 0}</div>
              <p className="text-xs text-muted-foreground">
                ${(stats?.totalPendingAmt ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} awaiting approval
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Net Profit</CardTitle>
              {(() => {
                const net = (stats?.totalRevenue ?? 0) - (stats?.totalPaid ?? 0);
                return net >= 0
                  ? <TrendingUp className="h-4 w-4 text-green-500" />
                  : <TrendingDown className="h-4 w-4 text-destructive" />;
              })()}
            </CardHeader>
            <CardContent>
              {(() => {
                const net = (stats?.totalRevenue ?? 0) - (stats?.totalPaid ?? 0);
                return (
                  <>
                    <div className={`text-2xl font-bold ${net >= 0 ? 'text-green-500' : 'text-destructive'}`}>
                      ${net.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </div>
                    <p className="text-xs text-muted-foreground">Revenue minus payouts</p>
                  </>
                );
              })()}
            </CardContent>
          </Card>
        </div>

        {/* QA Test Runner (SEEDV2/DEMO only) */}
        <QaApprovePanel />

        {/* Reminder card */}
        <Card className="border-warning/50 bg-warning/5">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-warning">
              <AlertTriangle className="h-5 w-5" />
              Human-in-the-Loop Reminder
            </CardTitle>
          </CardHeader>
          <CardContent className="text-muted-foreground">
            <ul className="list-disc list-inside space-y-2">
              <li>AI never denies earned payouts automatically</li>
              <li>All terminal account state changes require admin confirmation</li>
              <li>Cohort rules are immutable once assigned to an account</li>
              <li>Use intake throttling as the primary risk control, not punitive enforcement</li>
            </ul>
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}
