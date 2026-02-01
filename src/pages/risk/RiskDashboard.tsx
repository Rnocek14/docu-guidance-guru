import { DashboardLayout, riskNavItems } from '@/components/layout/DashboardLayout';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { supabase } from '@/integrations/supabase/client';
import { useQuery } from '@tanstack/react-query';
import { Users, Flag, AlertTriangle, Activity } from 'lucide-react';

export default function RiskDashboard() {
  // Fetch summary stats
  const { data: stats } = useQuery({
    queryKey: ['risk-stats'],
    queryFn: async () => {
      const [accountsRes, flagsRes, violationsRes] = await Promise.all([
        supabase.from('accounts').select('status', { count: 'exact' }),
        supabase.from('flags').select('status', { count: 'exact' }).eq('status', 'pending'),
        supabase.from('violations').select('id', { count: 'exact' }).is('confirmed_at', null),
      ]);

      return {
        totalAccounts: accountsRes.count || 0,
        pendingFlags: flagsRes.count || 0,
        unconfirmedViolations: violationsRes.count || 0,
      };
    },
  });

  // Fetch recent flags
  const { data: recentFlags } = useQuery({
    queryKey: ['recent-flags'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('flags')
        .select('*')
        .eq('status', 'pending')
        .order('created_at', { ascending: false })
        .limit(5);

      if (error) throw error;
      return data;
    },
  });

  const getSeverityBadge = (severity: string) => {
    const variants: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
      low: 'secondary',
      medium: 'default',
      high: 'destructive',
      critical: 'destructive',
    };
    return <Badge variant={variants[severity] || 'secondary'}>{severity}</Badge>;
  };

  return (
    <DashboardLayout title="Risk Console" navItems={riskNavItems}>
      <div className="space-y-6">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Risk Overview</h2>
          <p className="text-muted-foreground">
            Monitor accounts, review flags, and manage risk decisions.
          </p>
        </div>

        {/* Stats grid */}
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Accounts</CardTitle>
              <Users className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats?.totalAccounts || 0}</div>
              <p className="text-xs text-muted-foreground">Across all cohorts</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Pending Flags</CardTitle>
              <Flag className="h-4 w-4 text-warning" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats?.pendingFlags || 0}</div>
              <p className="text-xs text-muted-foreground">Awaiting review</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Unconfirmed Violations</CardTitle>
              <AlertTriangle className="h-4 w-4 text-destructive" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats?.unconfirmedViolations || 0}</div>
              <p className="text-xs text-muted-foreground">Detected breaches pending review</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">System Status</CardTitle>
              <Activity className="h-4 w-4 text-success" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-success">Operational</div>
              <p className="text-xs text-muted-foreground">All systems normal</p>
            </CardContent>
          </Card>
        </div>

        {/* Recent flags */}
        <Card>
          <CardHeader>
            <CardTitle>Recent Flags</CardTitle>
            <CardDescription>Accounts requiring human review</CardDescription>
          </CardHeader>
          <CardContent>
            {recentFlags && recentFlags.length > 0 ? (
              <div className="space-y-4">
                {recentFlags.map((flag) => (
                  <div
                    key={flag.id}
                    className="flex items-center justify-between p-4 rounded-lg border"
                  >
                    <div className="space-y-1">
                      <p className="font-medium">{flag.flag_type}</p>
                      <p className="text-sm text-muted-foreground">{flag.reason}</p>
                    </div>
                    <div className="flex items-center gap-4">
                      {getSeverityBadge(flag.severity)}
                      <span className="text-sm text-muted-foreground">
                        {new Date(flag.created_at).toLocaleDateString()}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-muted-foreground text-center py-8">
                No pending flags. All accounts clear.
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}
