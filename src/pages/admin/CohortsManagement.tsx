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
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { supabase } from '@/integrations/supabase/client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Settings, Users, Lock, Clock, AlertTriangle, Info } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import type { Tables } from '@/integrations/supabase/types';

type Cohort = Tables<'cohorts'>;

interface CohortWithStats extends Cohort {
  accountCount: number;
  passedAccountCount: number;
}

export default function CohortsManagement() {
  const queryClient = useQueryClient();
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [editingCohort, setEditingCohort] = useState<CohortWithStats | null>(null);
  const [newCohort, setNewCohort] = useState({
    name: '',
    description: '',
    profit_target_percent: 10,
    max_daily_loss_percent: 5,
    max_total_drawdown_percent: 10,
    max_position_size_percent: 100,
    min_trading_days: 5,
    first_payout_cap_amount: 300,
    payout_eligibility_delay_days: 7,
  });

  // Fetch cohorts with account counts (including passed accounts)
  const { data: cohorts, isLoading } = useQuery({
    queryKey: ['admin-cohorts'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('cohorts')
        .select('*')
        .order('created_at', { ascending: false });

      if (error) throw error;

      // Get account counts per cohort (total and passed)
      const { data: accounts } = await supabase
        .from('accounts')
        .select('cohort_id, status');

      const countMap = new Map<string, { total: number; passed: number }>();
      accounts?.forEach((a) => {
        const current = countMap.get(a.cohort_id) || { total: 0, passed: 0 };
        current.total += 1;
        if (['passed', 'payout_requested', 'payout_under_review', 'payout_approved'].includes(a.status)) {
          current.passed += 1;
        }
        countMap.set(a.cohort_id, current);
      });

      return data.map((cohort) => ({
        ...cohort,
        accountCount: countMap.get(cohort.id)?.total || 0,
        passedAccountCount: countMap.get(cohort.id)?.passed || 0,
      })) as CohortWithStats[];
    },
  });

  // Create cohort mutation
  const createCohort = useMutation({
    mutationFn: async (cohort: typeof newCohort) => {
      // Validate cooling period range
      const delayDays = cohort.payout_eligibility_delay_days;
      if (delayDays < 0 || delayDays > 30) {
        throw new Error('Payout eligibility delay must be between 0 and 30 days');
      }

      const { error } = await supabase.from('cohorts').insert({
        name: cohort.name,
        description: cohort.description || null,
        profit_target_percent: cohort.profit_target_percent,
        max_daily_loss_percent: cohort.max_daily_loss_percent,
        max_total_drawdown_percent: cohort.max_total_drawdown_percent,
        max_position_size_percent: cohort.max_position_size_percent,
        min_trading_days: cohort.min_trading_days,
        first_payout_cap_amount: cohort.first_payout_cap_amount,
        payout_eligibility_delay_days: cohort.payout_eligibility_delay_days,
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
        payout_eligibility_delay_days: 7,
      });
    },
    onError: (error: Error) => {
      toast.error(error.message || 'Failed to create cohort');
    },
  });

  // Update cohort mutation with audit logging
  const updateCohort = useMutation({
    mutationFn: async ({ 
      cohortId, 
      updates, 
      oldValues 
    }: { 
      cohortId: string; 
      updates: Partial<Cohort>; 
      oldValues: Partial<Cohort>;
    }) => {
      // Validate cooling period range if being updated
      if (updates.payout_eligibility_delay_days !== undefined) {
        const delayDays = updates.payout_eligibility_delay_days;
        if (delayDays < 0 || delayDays > 30) {
          throw new Error('Payout eligibility delay must be between 0 and 30 days');
        }
      }

      // Update cohort
      const { error: updateError } = await supabase
        .from('cohorts')
        .update(updates)
        .eq('id', cohortId);
      if (updateError) throw updateError;

      // Log audit entry for cohort update
      const { data: { user } } = await supabase.auth.getUser();
      
      // We'll insert audit log - if it fails, we don't block the update
      try {
        await supabase.from('audit_logs').insert({
          user_id: user?.id || null,
          action: 'cohort_assigned', // Using existing enum value for cohort changes
          details: {
            cohort_id: cohortId,
            action_type: 'cohort_updated',
            changes: Object.keys(updates).map(key => ({
              field: key,
              old_value: oldValues[key as keyof Cohort],
              new_value: updates[key as keyof Cohort],
            })),
          },
          reason: `Cohort settings updated: ${Object.keys(updates).join(', ')}`,
        });
      } catch {
        // Audit logging failure shouldn't block the operation
        console.warn('Failed to log audit entry for cohort update');
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-cohorts'] });
      toast.success('Cohort updated');
      setEditDialogOpen(false);
      setEditingCohort(null);
    },
    onError: (error: Error) => {
      toast.error(error.message || 'Failed to update cohort');
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

  const openEditDialog = (cohort: CohortWithStats) => {
    setEditingCohort(cohort);
    setEditDialogOpen(true);
  };

  const handleUpdateCohort = () => {
    if (!editingCohort) return;

    const originalCohort = cohorts?.find(c => c.id === editingCohort.id);
    if (!originalCohort) return;

    // Build updates object with only changed fields
    const updates: Partial<Cohort> = {};
    const oldValues: Partial<Cohort> = {};

    if (editingCohort.payout_eligibility_delay_days !== originalCohort.payout_eligibility_delay_days) {
      updates.payout_eligibility_delay_days = editingCohort.payout_eligibility_delay_days;
      oldValues.payout_eligibility_delay_days = originalCohort.payout_eligibility_delay_days;
    }
    if (editingCohort.first_payout_cap_amount !== originalCohort.first_payout_cap_amount) {
      updates.first_payout_cap_amount = editingCohort.first_payout_cap_amount;
      oldValues.first_payout_cap_amount = originalCohort.first_payout_cap_amount;
    }

    if (Object.keys(updates).length === 0) {
      toast.info('No changes to save');
      setEditDialogOpen(false);
      return;
    }

    updateCohort.mutate({ cohortId: editingCohort.id, updates, oldValues });
  };

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
                    <div className="flex items-center gap-2">
                      <Badge variant={cohort.is_active ? 'default' : 'secondary'}>
                        {cohort.is_active ? 'Active' : 'Inactive'}
                      </Badge>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => openEditDialog(cohort)}
                      >
                        <Settings className="h-4 w-4" />
                      </Button>
                    </div>
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
                    <div>
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <div className="cursor-help">
                              <p className="text-muted-foreground flex items-center gap-1">
                                Cooling Period
                                <Info className="h-3 w-3" />
                              </p>
                              <p className="font-medium flex items-center gap-1">
                                <Clock className="h-3 w-3" />
                                {cohort.payout_eligibility_delay_days} days
                              </p>
                            </div>
                          </TooltipTrigger>
                          <TooltipContent>
                            <p className="max-w-xs text-xs">
                              First payout request allowed {cohort.payout_eligibility_delay_days} days after passing. 
                              Uses NY time zone. Does not apply to subsequent payouts.
                            </p>
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    </div>
                  </div>

                  {/* Stats */}
                  <div className="flex items-center justify-between pt-3 border-t">
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Users className="h-4 w-4" />
                      {cohort.accountCount} accounts
                      {cohort.passedAccountCount > 0 && (
                        <span className="text-success">({cohort.passedAccountCount} passed)</span>
                      )}
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
              <div className="space-y-2 col-span-2">
                <Label htmlFor="coolingPeriod" className="flex items-center gap-1">
                  First Payout Eligibility Delay (days)
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Info className="h-3 w-3 text-muted-foreground cursor-help" />
                      </TooltipTrigger>
                      <TooltipContent>
                        <p className="max-w-xs text-xs">
                          Time between passing and when first payout can be requested. 
                          Only applies to first payout. Uses NY time zone.
                        </p>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </Label>
                <Input
                  id="coolingPeriod"
                  type="number"
                  min={0}
                  max={30}
                  value={newCohort.payout_eligibility_delay_days}
                  onChange={(e) =>
                    setNewCohort({ 
                      ...newCohort, 
                      payout_eligibility_delay_days: Math.min(30, Math.max(0, Number(e.target.value))) 
                    })
                  }
                />
                <p className="text-xs text-muted-foreground">
                  0–30 days. Default 7. Cooling window before first payout request is allowed.
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

      {/* Edit Cohort Dialog */}
      <Dialog open={editDialogOpen} onOpenChange={setEditDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Edit Cohort: {editingCohort?.name}</DialogTitle>
            <DialogDescription>
              Modify payout settings for this cohort. Core trading rules are frozen.
            </DialogDescription>
          </DialogHeader>
          {editingCohort && (
            <div className="space-y-4 py-4">
              {/* Warning for cohorts with passed accounts */}
              {editingCohort.passedAccountCount > 0 && (
                <Alert variant="destructive">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertDescription>
                    This cohort has {editingCohort.passedAccountCount} passed account(s). 
                    Changing the cooling period will affect their payout eligibility window.
                  </AlertDescription>
                </Alert>
              )}

              <div className="space-y-2">
                <Label htmlFor="editFirstPayoutCap">First Payout Cap ($)</Label>
                <Input
                  id="editFirstPayoutCap"
                  type="number"
                  value={editingCohort.first_payout_cap_amount ?? ''}
                  onChange={(e) =>
                    setEditingCohort({ 
                      ...editingCohort, 
                      first_payout_cap_amount: e.target.value ? Number(e.target.value) : null 
                    })
                  }
                  placeholder="Leave empty for no cap"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="editCoolingPeriod" className="flex items-center gap-1">
                  First Payout Eligibility Delay (days)
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Info className="h-3 w-3 text-muted-foreground cursor-help" />
                      </TooltipTrigger>
                      <TooltipContent>
                        <p className="max-w-xs text-xs">
                          Time between passing and when first payout can be requested.
                          Only applies to first payout. Uses NY time zone.
                        </p>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </Label>
                <Input
                  id="editCoolingPeriod"
                  type="number"
                  min={0}
                  max={30}
                  value={editingCohort.payout_eligibility_delay_days}
                  onChange={(e) =>
                    setEditingCohort({ 
                      ...editingCohort, 
                      payout_eligibility_delay_days: Math.min(30, Math.max(0, Number(e.target.value))) 
                    })
                  }
                />
                <p className="text-xs text-muted-foreground">
                  0–30 days. Changes are logged and affect future eligibility calculations.
                </p>
              </div>

              {/* Preview of impact */}
              <div className="bg-muted/50 rounded-lg p-3 text-sm">
                <p className="font-medium mb-1">Preview</p>
                <p className="text-muted-foreground">
                  First payout request allowed on: <span className="font-mono">passed_at + {editingCohort.payout_eligibility_delay_days} days</span> (NY time)
                </p>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleUpdateCohort}
              disabled={updateCohort.isPending}
            >
              Save Changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  );
}
