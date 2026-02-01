import { DashboardLayout, supportNavItems } from '@/components/layout/DashboardLayout';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { supabase } from '@/integrations/supabase/client';
import { useQuery } from '@tanstack/react-query';
import { Users, CreditCard, HelpCircle } from 'lucide-react';

export default function SupportDashboard() {
  // Fetch summary stats
  const { data: stats } = useQuery({
    queryKey: ['support-stats'],
    queryFn: async () => {
      const [accountsRes, payoutsRes] = await Promise.all([
        supabase.from('accounts').select('status', { count: 'exact' }).eq('status', 'under_review'),
        supabase.from('payouts').select('status', { count: 'exact' }).eq('status', 'under_review'),
      ]);

      return {
        accountsUnderReview: accountsRes.count || 0,
        payoutsUnderReview: payoutsRes.count || 0,
      };
    },
  });

  return (
    <DashboardLayout title="Support Dashboard" navItems={supportNavItems}>
      <div className="space-y-6">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Support Overview</h2>
          <p className="text-muted-foreground">
            View account status and assist traders with inquiries.
          </p>
        </div>

        {/* Stats grid */}
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Accounts Under Review</CardTitle>
              <Users className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats?.accountsUnderReview || 0}</div>
              <p className="text-xs text-muted-foreground">Awaiting resolution</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Payouts Under Review</CardTitle>
              <CreditCard className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats?.payoutsUnderReview || 0}</div>
              <p className="text-xs text-muted-foreground">Being processed</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Your Role</CardTitle>
              <HelpCircle className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">Support</div>
              <p className="text-xs text-muted-foreground">Limited view access</p>
            </CardContent>
          </Card>
        </div>

        {/* Info card */}
        <Card>
          <CardHeader>
            <CardTitle>Support Guidelines</CardTitle>
            <CardDescription>Remember these key principles when assisting traders</CardDescription>
          </CardHeader>
          <CardContent className="text-muted-foreground space-y-2">
            <p>• You have read-only access to accounts and payouts</p>
            <p>• Escalate any disputes to Risk Officers</p>
            <p>• Never promise payout approvals - only Admins can approve</p>
            <p>• All conversations should be documented in the audit trail</p>
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}
