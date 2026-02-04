import { DashboardLayout, adminNavItems } from '@/components/layout/DashboardLayout';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { supabase } from '@/integrations/supabase/client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Settings, Users, Lock } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import type { Tables } from '@/integrations/supabase/types';

type Cohort = Tables<'cohorts'>;

export default function CohortsManagement() {
  const queryClient = useQueryClient();
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [newCohort, setNewCohort] = useState({
    name: '',
    description: '',
    profit_target_percent: 10,
    max_daily_loss_percent: 5,
    max_total_drawdown_percent: 10,
    max_position_size_percent: 100,
    min_trading_days: 5,
    first_payout_cap_amount: 300,
  });

  // Fetch cohorts with account counts
  const { data: cohorts, isLoading } = useQuery({
    queryKey: ['admin-cohorts'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('cohorts')
        .select('*')
        .order('created_at', { ascending: false });

      if (error) throw error;

      // Get account counts per cohort
      const { data: accounts } = await supabase
        .from('accounts')
        .select('cohort_id');

      const countMap = new Map<string, number>();
      accounts?.forEach((a) => {
        countMap.set(a.cohort_id, (countMap.get(a.cohort_id) || 0) + 1);
      });

      return data.map((cohort) => ({
        ...cohort,
        accountCount: countMap.get(cohort.id) || 0,
      }));
    },
  });

  // Create cohort mutation
  const createCohort = useMutation({
    mutationFn: async (cohort: typeof newCohort) => {
      const { error } = await supabase.from('cohorts').insert({
        name: cohort.name,
        description: cohort.description || null,
        profit_target_percent: cohort.profit_target_percent,
        max_daily_loss_percent: cohort.max_daily_loss_percent,
        max_total_drawdown_percent: cohort.max_total_drawdown_percent,
        max_position_size_percent: cohort.max_position_size_percent,
        min_trading_days: cohort.min_trading_days,
        first_payout_cap_amount: cohort.first_payout_cap_amount,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-cohorts'] });
      toast.success('Cohort created');
      setCreateDialogOpen(false);
      setNewCohort({
        name: '',
        description: '',
        profit_target_percent: 10,
        max_daily_loss_percent: 5,
        max_total_drawdown_percent: 10,
        max_position_size_percent: 100,
        min_trading_days: 5,
        first_payout_cap_amount: 300,
      });
    },
    onError: (error: Error) => {
      toast.error(error.message || 'Failed to create cohort');
    },
  });

  // Toggle intake mutation
  const toggleIntake = useMutation({
    mutationFn: async ({ cohortId, active }: { cohortId: string; active: boolean }) => {
      const { error } = await supabase
        .from('cohorts')
        .update({ intake_active: active })
        .eq('id', cohortId);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-cohorts'] });
      toast.success('Intake updated');
    },
    onError: (error: Error) => {
      toast.error(error.message || 'Failed to update intake');
    },
  });

  return (
    <DashboardLayout title="Cohort Management" navItems={adminNavItems}>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-bold tracking-tight">Trading Cohorts</h2>
            <p className="text-muted-foreground">
              Configure rule sets for different account tiers.
            </p>
          </div>
          <Button onClick={() => setCreateDialogOpen(true)}>
            <Plus className="mr-2 h-4 w-4" />
            New Cohort
          </Button>
        </div>

        {/* Info card */}
        <Card className="border-primary/30 bg-primary/5">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-primary text-base">
              <Lock className="h-4 w-4" />
              Rule Immutability
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            <p>Once an account is assigned to a cohort, its rules are snapshotted and frozen. Changes to cohort rules only affect new accounts.</p>
          </CardContent>
        </Card>

        {/* Cohorts grid */}
        {isLoading ? (
          <div className="text-center py-8 text-muted-foreground">Loading cohorts...</div>
        ) : cohorts && cohorts.length > 0 ? (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {cohorts.map((cohort) => (
              <Card key={cohort.id} className={!cohort.is_active ? 'opacity-60' : ''}>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-lg">{cohort.name}</CardTitle>
                    <Badge variant={cohort.is_active ? 'default' : 'secondary'}>
                      {cohort.is_active ? 'Active' : 'Inactive'}
                    </Badge>
                  </div>
                  <CardDescription>{cohort.description || 'No description'}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  {/* Rules */}
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <div>
                      <p className="text-muted-foreground">Profit Target</p>
                      <p className="font-medium text-success">{cohort.profit_target_percent}%</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Max Daily Loss</p>
                      <p className="font-medium text-destructive">{cohort.max_daily_loss_percent}%</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Max Drawdown</p>
                      <p className="font-medium text-destructive">{cohort.max_total_drawdown_percent}%</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Min Trading Days</p>
                      <p className="font-medium">{cohort.min_trading_days}</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">First Payout Cap</p>
                      <p className="font-medium text-warning">
                        {cohort.first_payout_cap_amount 
                          ? `$${cohort.first_payout_cap_amount}` 
                          : 'No cap'}
                      </p>
                    </div>
                  </div>

                  {/* Stats */}
                  <div className="flex items-center justify-between pt-3 border-t">
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Users className="h-4 w-4" />
                      {cohort.accountCount} accounts
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-muted-foreground">Intake</span>
                      <Switch
                        checked={cohort.intake_active}
                        onCheckedChange={(checked) =>
                          toggleIntake.mutate({ cohortId: cohort.id, active: checked })
                        }
                      />
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        ) : (
          <Card>
            <CardContent className="text-center py-8 text-muted-foreground">
              No cohorts configured. Create your first cohort to define trading rules.
            </CardContent>
          </Card>
        )}
      </div>

      {/* Create Cohort Dialog */}
      <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Create New Cohort</DialogTitle>
            <DialogDescription>
              Define a new rule set for trading accounts.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="name">Cohort Name</Label>
              <Input
                id="name"
                value={newCohort.name}
                onChange={(e) => setNewCohort({ ...newCohort, name: e.target.value })}
                placeholder="e.g., Standard 100K"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="description">Description</Label>
              <Textarea
                id="description"
                value={newCohort.description}
                onChange={(e) => setNewCohort({ ...newCohort, description: e.target.value })}
                placeholder="Optional description"
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="profit">Profit Target %</Label>
                <Input
                  id="profit"
                  type="number"
                  value={newCohort.profit_target_percent}
                  onChange={(e) =>
                    setNewCohort({ ...newCohort, profit_target_percent: Number(e.target.value) })
                  }
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="daily">Max Daily Loss %</Label>
                <Input
                  id="daily"
                  type="number"
                  value={newCohort.max_daily_loss_percent}
                  onChange={(e) =>
                    setNewCohort({ ...newCohort, max_daily_loss_percent: Number(e.target.value) })
                  }
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="drawdown">Max Drawdown %</Label>
                <Input
                  id="drawdown"
                  type="number"
                  value={newCohort.max_total_drawdown_percent}
                  onChange={(e) =>
                    setNewCohort({ ...newCohort, max_total_drawdown_percent: Number(e.target.value) })
                  }
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="days">Min Trading Days</Label>
                <Input
                  id="days"
                  type="number"
                  value={newCohort.min_trading_days}
                  onChange={(e) =>
                    setNewCohort({ ...newCohort, min_trading_days: Number(e.target.value) })
                  }
                />
              </div>
              <div className="space-y-2 col-span-2">
                <Label htmlFor="firstPayoutCap">First Payout Cap ($)</Label>
                <Input
                  id="firstPayoutCap"
                  type="number"
                  value={newCohort.first_payout_cap_amount ?? ''}
                  onChange={(e) =>
                    setNewCohort({ 
                      ...newCohort, 
                      first_payout_cap_amount: e.target.value ? Number(e.target.value) : null 
                    })
                  }
                  placeholder="Leave empty for no cap"
                />
                <p className="text-xs text-muted-foreground">
                  Limits the first payout per cycle to reduce fraud risk. $300 recommended.
                </p>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => createCohort.mutate(newCohort)}
              disabled={!newCohort.name || createCohort.isPending}
            >
              Create Cohort
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  );
}
