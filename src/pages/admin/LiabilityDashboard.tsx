import { useState, useEffect, useRef } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { DashboardLayout, adminNavItems } from '@/components/layout/DashboardLayout';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import { 
  DollarSign, 
  AlertTriangle, 
  Clock, 
  TrendingUp,
  Download,
  RefreshCw,
  Calendar,
  Shield,
  AlertCircle
} from 'lucide-react';
import { parseLocalDate } from '@/lib/date-utils';
import { format } from 'date-fns';

interface LiabilitySnapshot {
  as_of: string;
  pending_counts: Record<string, number>;
  pending_amounts: Record<string, number>;
  approved_unpaid: number;
  opening_soon_count: number;
  opening_soon_by_day: Array<{ opens_on: string; count: number }>;
  by_cohort: Array<{
    cohort_id: string;
    cohort_name: string;
    approved_unpaid: number;
    pending_amount: number;
    approved_count: number;
    pending_count: number;
  }>;
  velocity: {
    requested_14d: number;
    paid_14d: number;
    paid_amount_14d: number;
  };
  days_forward: number;
  // Net buffer fields
  total_pending_amount: number;
  expected_opening_soon_liability: number;
  cash_reserve: number;
  assumed_avg_first_payout: number;
  net_buffer: number;
  error?: string;
}

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount);
}

function MetricCard({ 
  title, 
  value, 
  subtitle, 
  icon: Icon, 
  variant = 'default' 
}: { 
  title: string; 
  value: string | number; 
  subtitle?: string; 
  icon: React.ElementType;
  variant?: 'default' | 'warning' | 'critical';
}) {
  const variantClasses = {
    default: 'bg-card',
    warning: 'bg-amber-50 dark:bg-amber-950/20 border-amber-200 dark:border-amber-800',
    critical: 'bg-red-50 dark:bg-red-950/20 border-red-200 dark:border-red-800',
  };

  return (
    <Card className={variantClasses[variant]}>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold">{value}</div>
        {subtitle && (
          <p className="text-xs text-muted-foreground mt-1">{subtitle}</p>
        )}
      </CardContent>
    </Card>
  );
}

export default function LiabilityDashboard() {
  const { toast } = useToast();
  
  // Local input state (not tied to query)
  const [cashReserveInput, setCashReserveInput] = useState<number>(0);
  const [assumedAvgPayoutInput, setAssumedAvgPayoutInput] = useState<number>(300);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  
  // Applied state (drives query)
  const [appliedCashReserve, setAppliedCashReserve] = useState<number>(0);
  const [appliedAvgPayout, setAppliedAvgPayout] = useState<number>(300);
  
  // Load persisted settings on mount (with error resilience)
  useEffect(() => {
    let mounted = true;

    const loadSettings = async () => {
      try {
        const { data, error } = await supabase.rpc('get_liability_buffer_settings');
        if (!mounted) return;

        if (!error && data && typeof data === 'object' && !('error' in data)) {
          const s = data as { cash_reserve: number; assumed_avg_first_payout: number };
          setCashReserveInput(s.cash_reserve);
          setAssumedAvgPayoutInput(s.assumed_avg_first_payout);
          setAppliedCashReserve(s.cash_reserve);
          setAppliedAvgPayout(s.assumed_avg_first_payout);
        }
      } finally {
        if (mounted) setSettingsLoaded(true);
      }
    };

    loadSettings();
    return () => { mounted = false; };
  }, []);
  
  // Mutation to persist settings
  const saveSettingsMutation = useMutation({
    mutationFn: async (params: { cash_reserve: number; assumed_avg_first_payout: number }) => {
      const { data, error } = await supabase.rpc('upsert_liability_buffer_settings', {
        _cash_reserve: params.cash_reserve,
        _assumed_avg_first_payout: params.assumed_avg_first_payout,
      });
      if (error) throw error;
      return data;
    },
    onError: (err) => {
      toast({
        title: 'Failed to save settings',
        description: (err as Error).message,
        variant: 'destructive',
      });
    },
  });
  
  const { data, isLoading, error, refetch, isRefetching } = useQuery({
    queryKey: ['liability-snapshot', appliedCashReserve, appliedAvgPayout],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_liability_snapshot', {
        _days_forward: 7,
        _cash_reserve: appliedCashReserve,
        _assumed_avg_first_payout: appliedAvgPayout,
      });
      if (error) throw error;
      return data as unknown as LiabilitySnapshot;
    },
    enabled: settingsLoaded, // Wait for settings to load first
    refetchInterval: 60000, // Refresh every minute
  });
  
  // Buffer flip detection - toast when net_buffer crosses from ≥0 to <0
  const prevNetBufferRef = useRef<number | null>(null);
  
  useEffect(() => {
    const nb = data?.net_buffer;
    if (typeof nb !== 'number') return;

    // First value: set baseline, don't toast
    if (prevNetBufferRef.current === null) {
      prevNetBufferRef.current = nb;
      return;
    }

    const prev = prevNetBufferRef.current;

    // Flip detection: non-negative -> negative
    if (prev >= 0 && nb < 0) {
      toast({
        title: 'Net Buffer turned negative',
        description: `Shortfall: ${formatCurrency(Math.abs(nb))}. Consider increasing reserve or pausing approvals.`,
        variant: 'destructive',
      });
    }

    prevNetBufferRef.current = nb;
  }, [data?.net_buffer, toast]);
  
  // Client-side clamping helper
  const clampNum = (v: number, min: number, max: number) =>
    Math.min(max, Math.max(min, Number.isFinite(v) ? v : min));

  // Apply button handler - clamps inputs + persists to DB
  const handleApplyBufferSettings = () => {
    const cr = clampNum(cashReserveInput, 0, 1_000_000_000);
    const avg = clampNum(assumedAvgPayoutInput, 0, 100_000);

    setCashReserveInput(cr);
    setAssumedAvgPayoutInput(avg);
    setAppliedCashReserve(cr);
    setAppliedAvgPayout(avg);

    // Persist in background (don't block the refetch)
    saveSettingsMutation.mutate({ cash_reserve: cr, assumed_avg_first_payout: avg });
  };

  // Reset to defaults helper
  const handleResetDefaults = () => {
    setCashReserveInput(0);
    setAssumedAvgPayoutInput(300);
    setAppliedCashReserve(0);
    setAppliedAvgPayout(300);
    saveSettingsMutation.mutate(
      { cash_reserve: 0, assumed_avg_first_payout: 300 },
      { onSuccess: () => refetch() }
    );
  };

  // MUST-FIX #3: Proper CSV escaping for values with commas/quotes
  const csvCell = (v: unknown) =>
    `"${String(v ?? '').replace(/"/g, '""')}"`;

  const handleExportCSV = () => {
    if (!data) return;
    
    const lines = [
      'Payout Liability Dashboard Export',
      `As of: ${data.as_of}`,
      '',
      'Summary Metrics',
      `Approved Unpaid,${data.approved_unpaid}`,
      `Pending Count,${data.pending_counts?.pending || 0}`,
      `Under Review Count,${data.pending_counts?.under_review || 0}`,
      `Opening Soon (7d),${data.opening_soon_count}`,
      '',
      'By Cohort',
      'Cohort,Approved Unpaid,Pending Amount,Approved Count,Pending Count',
      ...data.by_cohort.map(c => 
        `${csvCell(c.cohort_name)},${c.approved_unpaid},${c.pending_amount},${c.approved_count},${c.pending_count}`
      ),
      '',
      'Opening Soon By Day',
      'Date,Count',
      ...data.opening_soon_by_day.map(d => `${csvCell(d.opens_on)},${d.count}`),
    ];
    
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `liability-snapshot-${data.as_of}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (error) {
    return (
      <DashboardLayout title="Payout Liability" navItems={adminNavItems}>
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>
            Failed to load liability data: {(error as Error).message}
          </AlertDescription>
        </Alert>
      </DashboardLayout>
    );
  }

  if (data?.error) {
    return (
      <DashboardLayout title="Payout Liability" navItems={adminNavItems}>
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>
            Access denied: {data.error}
          </AlertDescription>
        </Alert>
      </DashboardLayout>
    );
  }

  // Use RPC's total_pending_amount directly for consistency
  const totalPendingAmount = data?.total_pending_amount || 0;

  return (
    <DashboardLayout title="Payout Liability" navItems={adminNavItems}>
      <div className="space-y-6">
        {/* Header with actions */}
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <p className="text-sm text-muted-foreground">
              {data ? `Data as of ${data.as_of} (Eastern)` : 'Loading...'}
            </p>
          </div>
          <div className="flex gap-2">
            <Button 
              variant="outline" 
              size="sm" 
              onClick={() => refetch()}
              disabled={isRefetching}
            >
              <RefreshCw className={`h-4 w-4 mr-2 ${isRefetching ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
            <Button 
              variant="outline" 
              size="sm" 
              onClick={handleExportCSV}
              disabled={!data}
            >
              <Download className="h-4 w-4 mr-2" />
              Export CSV
            </Button>
          </div>
        </div>

        {/* Negative Buffer Alert */}
        {data && (data.net_buffer || 0) < 0 && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>Net Buffer Negative</AlertTitle>
            <AlertDescription className="flex flex-col gap-3">
              <span>
                Current cash reserve ({formatCurrency(data.cash_reserve || 0)}) is insufficient to cover 
                pending liability ({formatCurrency(data.total_pending_amount || 0)}) plus expected 
                opening-soon liability ({formatCurrency(data.expected_opening_soon_liability || 0)}). 
                Shortfall: <strong>{formatCurrency(Math.abs(data.net_buffer || 0))}</strong>
              </span>
              <div className="flex gap-2">
                <Button 
                  variant="outline" 
                  size="sm" 
                  onClick={() => refetch()}
                  disabled={isRefetching}
                  className="bg-background"
                >
                  <RefreshCw className={`h-4 w-4 mr-2 ${isRefetching ? 'animate-spin' : ''}`} />
                  Refresh
                </Button>
                <Button 
                  variant="outline" 
                  size="sm" 
                  onClick={handleResetDefaults}
                  className="bg-background"
                >
                  Reset to Defaults
                </Button>
              </div>
            </AlertDescription>
          </Alert>
        )}

        {/* Net Buffer Configuration */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Net Buffer Calculator</CardTitle>
            <CardDescription>Configure cash reserve and assumptions to calculate operational buffer</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
              <div className="space-y-2">
                <Label htmlFor="cashReserve">Cash Reserve ($)</Label>
                <Input
                  id="cashReserve"
                  type="number"
                  min="0"
                  inputMode="numeric"
                  value={cashReserveInput}
                  onChange={(e) => setCashReserveInput(Number(e.target.value) || 0)}
                  placeholder="0"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="assumedAvgPayout">Avg First Payout Estimate ($)</Label>
                <Input
                  id="assumedAvgPayout"
                  type="number"
                  min="0"
                  inputMode="numeric"
                  value={assumedAvgPayoutInput}
                  onChange={(e) => setAssumedAvgPayoutInput(Number(e.target.value) || 300)}
                  placeholder="300"
                />
              </div>
              <div className="flex items-end">
                <Button 
                  variant="secondary" 
                  size="sm"
                  onClick={handleApplyBufferSettings}
                  disabled={cashReserveInput === appliedCashReserve && assumedAvgPayoutInput === appliedAvgPayout}
                >
                  Apply
                </Button>
              </div>
              {data && (
                <>
                  <div className="flex flex-col justify-end">
                    <p className="text-xs text-muted-foreground">Expected Opening Soon Liability</p>
                    <p className="text-lg font-semibold">{formatCurrency(data.expected_opening_soon_liability || 0)}</p>
                  </div>
                  <div className="flex flex-col justify-end">
                    <p className="text-xs text-muted-foreground">Net Buffer</p>
                    <p className={`text-lg font-bold ${(data.net_buffer || 0) < 0 ? 'text-destructive' : (data.net_buffer || 0) < 10000 ? 'text-warning' : 'text-primary'}`}>
                      {formatCurrency(data.net_buffer || 0)}
                    </p>
                  </div>
                </>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Key Metrics */}
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-5">
          {isLoading ? (
            <>
              <Skeleton className="h-[120px]" />
              <Skeleton className="h-[120px]" />
              <Skeleton className="h-[120px]" />
              <Skeleton className="h-[120px]" />
              <Skeleton className="h-[120px]" />
            </>
          ) : data ? (
            <>
              <MetricCard
                title="Approved Unpaid"
                value={formatCurrency(data.approved_unpaid)}
                subtitle="Ready to pay out"
                icon={DollarSign}
                variant={data.approved_unpaid > 50000 ? 'critical' : data.approved_unpaid > 10000 ? 'warning' : 'default'}
              />
              <MetricCard
                title="Total Pending Liability"
                value={formatCurrency(totalPendingAmount)}
                subtitle={`${(data.pending_counts?.pending || 0) + (data.pending_counts?.under_review || 0)} requests in queue`}
                icon={Clock}
                variant={totalPendingAmount > 100000 ? 'warning' : 'default'}
              />
              <MetricCard
                title="Opening Next 7 Days"
                value={data.opening_soon_count}
                subtitle="Accounts becoming eligible"
                icon={Calendar}
                variant={data.opening_soon_count > 20 ? 'warning' : 'default'}
              />
              <MetricCard
                title="14-Day Velocity"
                value={formatCurrency(data.velocity?.paid_amount_14d || 0)}
                subtitle={`${data.velocity?.paid_14d || 0} payouts completed`}
                icon={TrendingUp}
              />
              <MetricCard
                title="Net Buffer"
                value={formatCurrency(data.net_buffer || 0)}
                subtitle={appliedCashReserve > 0 ? `Reserve: ${formatCurrency(appliedCashReserve)}` : 'Set cash reserve above'}
                icon={Shield}
                variant={(data.net_buffer || 0) < 0 ? 'critical' : (data.net_buffer || 0) < 10000 ? 'warning' : 'default'}
              />
            </>
          ) : null}
        </div>

        {/* Status Breakdown */}
        {data && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Pending by Status</CardTitle>
              <CardDescription>Current payout requests awaiting action</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-4">
                <div className="flex items-center gap-2">
                  <Badge variant="secondary">Pending</Badge>
                  <span className="text-sm font-medium">
                    {data.pending_counts?.pending || 0} ({formatCurrency(data.pending_amounts?.pending || 0)})
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className="border-warning text-warning">Under Review</Badge>
                  <span className="text-sm font-medium">
                    {data.pending_counts?.under_review || 0} ({formatCurrency(data.pending_amounts?.under_review || 0)})
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="default">Approved</Badge>
                  <span className="text-sm font-medium">
                    {data.pending_counts?.approved || 0} ({formatCurrency(data.pending_amounts?.approved || 0)})
                  </span>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        <div className="grid gap-6 lg:grid-cols-2">
          {/* By Cohort */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Liability by Cohort</CardTitle>
              <CardDescription>Breakdown of pending payouts by account tier</CardDescription>
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <Skeleton className="h-[200px]" />
              ) : data?.by_cohort?.length ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Cohort</TableHead>
                      <TableHead className="text-right">Approved</TableHead>
                      <TableHead className="text-right">Pending</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.by_cohort.map((cohort) => (
                      <TableRow key={cohort.cohort_id}>
                        <TableCell className="font-medium">{cohort.cohort_name}</TableCell>
                        <TableCell className="text-right">
                          {cohort.approved_count > 0 ? (
                            <span className="text-primary font-medium">
                              {formatCurrency(cohort.approved_unpaid)}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          {cohort.pending_count > 0 ? (
                            <span>{formatCurrency(cohort.pending_amount)}</span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <p className="text-sm text-muted-foreground text-center py-8">
                  No pending payouts
                </p>
              )}
            </CardContent>
          </Card>

          {/* Opening Soon */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Eligibility Opening Soon</CardTitle>
              <CardDescription>Accounts whose cooling period ends in the next 7 days</CardDescription>
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <Skeleton className="h-[200px]" />
              ) : data?.opening_soon_by_day?.length ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead className="text-right">Accounts</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.opening_soon_by_day.map((day) => {
                      const date = parseLocalDate(day.opens_on);
                      return (
                        <TableRow key={day.opens_on}>
                          <TableCell className="font-medium">
                            {date ? format(date, 'EEE, MMM d') : day.opens_on}
                          </TableCell>
                          <TableCell className="text-right">
                            <Badge variant="secondary">{day.count}</Badge>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              ) : (
                <p className="text-sm text-muted-foreground text-center py-8">
                  No accounts opening in the next 7 days
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </DashboardLayout>
  );
}
