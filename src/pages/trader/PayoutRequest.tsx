import { useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { DashboardLayout, traderNavItems } from '@/components/layout/DashboardLayout';
import { PayoutCoolingCard } from '@/components/trader/PayoutCoolingCard';
import { PayoutProfitBufferCard } from '@/components/trader/PayoutProfitBufferCard';
import { PayoutWinningDaysCard } from '@/components/trader/PayoutWinningDaysCard';
import { PayoutMilestoneCard } from '@/components/trader/PayoutMilestoneCard';
import { LifetimeHeadroomCard } from '@/components/trader/LifetimeHeadroomCard';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { ArrowLeft, DollarSign, AlertTriangle, CheckCircle2, Info } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { toast } from 'sonner';
import type { Account, PayoutEligibility } from '@/lib/types';

export default function PayoutRequest() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [requestedAmount, setRequestedAmount] = useState<string>('');

  // Fetch account details
  const { data: account, isLoading: accountLoading } = useQuery({
    queryKey: ['account-payout', id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('accounts')
        .select(`*, cohort:cohorts(*)`)
        .eq('id', id)
        .eq('user_id', user?.id)
        .single();

      if (error) throw error;
      return data as Account & { cohort: any };
    },
    enabled: !!id && !!user?.id,
  });

  // Fetch payout eligibility
  const { data: eligibility, isLoading: eligibilityLoading } = useQuery({
    queryKey: ['payout-eligibility', id],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('calculate_payout_eligibility', {
        _account_id: id!,
      });
      if (error) throw error;
      return data as unknown as PayoutEligibility;
    },
    enabled: !!id,
  });

  // Submit payout request mutation
  const submitPayout = useMutation({
    mutationFn: async (amount: number) => {
      // First validate
      const { data: validation, error: validationError } = await supabase.rpc('validate_payout_request', {
        _account_id: id!,
        _requested_amount: amount,
      });
      
      if (validationError) throw validationError;
      
      const validationResult = validation as unknown as PayoutEligibility;
      if (!validationResult.eligible) {
        throw new Error(validationResult.reason || 'Payout request not eligible');
      }

      // Create payout request
      const { data, error } = await supabase
        .from('payouts')
        .insert({
          account_id: id!,
          amount: amount,
          status: 'pending',
          submitted_amount: amount,
          calculated_eligible_amount: eligibility?.max_eligible_amount,
        })
        .select()
        .single();

      if (error) throw error;

      // Update account status
      await supabase
        .from('accounts')
        .update({ status: 'payout_requested' })
        .eq('id', id!);

      return data;
    },
    onSuccess: () => {
      toast.success('Payout request submitted successfully');
      queryClient.invalidateQueries({ queryKey: ['account-payout', id] });
      queryClient.invalidateQueries({ queryKey: ['payout-eligibility', id] });
      navigate('/trader/payouts');
    },
    onError: (error: Error) => {
      toast.error(error.message || 'Failed to submit payout request');
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const amount = parseFloat(requestedAmount);
    if (isNaN(amount) || amount < 50) {
      toast.error('Minimum payout amount is $50');
      return;
    }
    if (eligibility?.max_eligible_amount && amount > eligibility.max_eligible_amount) {
      toast.error(`Maximum eligible amount is $${eligibility.max_eligible_amount.toFixed(2)}`);
      return;
    }
    submitPayout.mutate(amount);
  };

  const handleMaxAmount = () => {
    if (eligibility?.max_eligible_amount) {
      setRequestedAmount(eligibility.max_eligible_amount.toFixed(2));
    }
  };

  const isLoading = accountLoading || eligibilityLoading;
  // FIX #4: Stricter check - only true if explicitly true (not undefined)
  const isWindowOpen = eligibility?.payout_window_opened === true;
  const canRequestPayout = eligibility?.eligible === true && isWindowOpen;
  const reasonCode = eligibility?.reason_code ?? 'UNKNOWN';
  const isDedicatedGate = reasonCode === 'PROFIT_BUFFER' || reasonCode === 'NO_PROFIT' || reasonCode === 'MIN_WINNING_DAYS';

  if (isLoading) {
    return (
      <DashboardLayout title="Request Payout" navItems={traderNavItems}>
        <div className="space-y-6">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-64 w-full" />
        </div>
      </DashboardLayout>
    );
  }

  if (!account) {
    return (
      <DashboardLayout title="Request Payout" navItems={traderNavItems}>
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
    <DashboardLayout title="Request Payout" navItems={traderNavItems}>
      <div className="space-y-6 max-w-2xl">
        {/* Header */}
        <div className="space-y-1">
          <Link to={`/trader/accounts/${id}`} className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground mb-2">
            <ArrowLeft className="h-4 w-4" />
            Back to Account
          </Link>
          <h2 className="text-2xl font-bold tracking-tight">Request Payout</h2>
          <p className="text-muted-foreground">
            Account #{account.account_number}
          </p>
        </div>

        {/* Cooling Period Card (if in cooling) */}
        {eligibility && !isWindowOpen && (
          <PayoutCoolingCard
            daysSincePass={eligibility.days_since_pass ?? 0}
            coolingPeriodDays={eligibility.cooling_period_days ?? 7}
            windowOpensAt={eligibility.payout_window_opens_at ?? ''}
            isWindowOpen={false}
          />
        )}

        {/* Eligibility Status (dedicated gates get their own card instead) */}
        {eligibility && !eligibility.eligible && isWindowOpen && !isDedicatedGate && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Not Eligible for Payout</AlertTitle>
            <AlertDescription>
              {eligibility.reason}
              {eligibility.hint && <p className="mt-1 text-sm">{eligibility.hint}</p>}
            </AlertDescription>
          </Alert>
        )}

        {/* Winning Trading Days Card — show when has prior payout and required_winning_days > 0 */}
        {eligibility && isWindowOpen && eligibility.has_prior_payout && (eligibility.required_winning_days ?? 0) > 0 && (
          <PayoutWinningDaysCard
            tradingDaysSincePayout={eligibility.winning_days_since_payout ?? 0}
            requiredTradingDays={eligibility.required_winning_days!}
            winningDaysRemaining={eligibility.winning_days_remaining ?? 0}
            progressPct={eligibility.winning_days_progress_pct ?? 100}
            isMet={reasonCode !== 'MIN_WINNING_DAYS'}
          />
        )}

        {/* Profit Buffer Card — show on eligible + has_prior_payout OR on denial with PROFIT_BUFFER/NO_PROFIT */}
        {eligibility && isWindowOpen && eligibility.profit_buffer_required != null && eligibility.has_prior_payout && (
          <PayoutProfitBufferCard
            profitBufferRequired={eligibility.profit_buffer_required}
            realizedProfit={eligibility.realized_profit ?? 0}
            profitBufferRemaining={eligibility.profit_buffer_remaining ?? 0}
            profitBufferMet={eligibility.profit_buffer_met ?? true}
            profitBufferProgressPct={eligibility.profit_buffer_progress_pct}
          />
        )}

        {/* Payout Info Cards */}
        {eligibility && isWindowOpen && (
          <div className="grid gap-4 md:grid-cols-2">
            <PayoutMilestoneCard
              firstPayoutCapAmount={account.cohort?.first_payout_cap_amount ?? null}
              isFirstPayoutInCycle={eligibility.is_first_payout_in_cycle ?? true}
            />
            <LifetimeHeadroomCard
              lifetimeCapAmount={eligibility.lifetime_cap_amount ?? null}
              lifetimePaidTotal={eligibility.lifetime_paid_total ?? 0}
              lifetimeHeadroom={eligibility.lifetime_headroom ?? null}
            />
          </div>
        )}

        {/* Payout Request Form */}
        {canRequestPayout && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <DollarSign className="h-5 w-5" />
                Payout Details
              </CardTitle>
              <CardDescription>
                Enter the amount you'd like to request as a payout
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleSubmit} className="space-y-6">
                {/* Eligibility Summary */}
                <div className="rounded-lg border bg-muted/50 p-4 space-y-2">
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Simulated Performance</span>
                    <span className="font-medium">${eligibility?.realized_profit?.toFixed(2) ?? '0.00'}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Payout Rate ({eligibility?.payout_split_percent ?? 80}%)</span>
                    <span className="font-medium">${eligibility?.total_eligible_by_split?.toFixed(2) ?? '0.00'}</span>
                  </div>
                  <div className="flex justify-between text-sm border-t pt-2 mt-2">
                    <span className="font-medium">Maximum Eligible</span>
                    <span className="font-bold text-success">${eligibility?.max_eligible_amount?.toFixed(2) ?? '0.00'}</span>
                  </div>
                  {eligibility?.first_payout_cap_applied && (
                    <div className="text-xs text-muted-foreground flex items-center gap-1 mt-1">
                      <Info className="h-3 w-3" />
                      First payout cap of ${eligibility.first_payout_cap_amount} applied
                    </div>
                  )}
                  {eligibility?.lifetime_cap_applied && (
                    <div className="text-xs text-warning flex items-center gap-1 mt-1">
                      <AlertTriangle className="h-3 w-3" />
                      Limited by lifetime cap headroom
                    </div>
                  )}
                </div>

                {/* Amount Input */}
                <div className="space-y-2">
                  <Label htmlFor="amount">Payout Amount</Label>
                  <div className="flex gap-2">
                    <div className="relative flex-1">
                      <DollarSign className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                      <Input
                        id="amount"
                        type="number"
                        min="50"
                        max={eligibility?.max_eligible_amount ?? 0}
                        step="0.01"
                        placeholder="0.00"
                        value={requestedAmount}
                        onChange={(e) => setRequestedAmount(e.target.value)}
                        className="pl-9"
                      />
                    </div>
                    <Button type="button" variant="outline" onClick={handleMaxAmount}>
                      Max
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Minimum: $50 | Maximum: ${eligibility?.max_eligible_amount?.toFixed(2) ?? '0.00'}
                  </p>
                </div>

                {/* Submit */}
                <Button 
                  type="submit" 
                  className="w-full" 
                  disabled={submitPayout.isPending || !requestedAmount}
                >
                  {submitPayout.isPending ? 'Submitting...' : 'Submit Payout Request'}
                </Button>

                <p className="text-xs text-muted-foreground text-center">
                  Your request will be reviewed by our team. Payouts are typically processed within 2-3 business days.
                </p>
                <p className="text-xs text-muted-foreground/70 text-center">
                  All trading activity is simulated. Payouts are performance-based rewards, not profit withdrawals or investment returns, and are subject to eligibility rules.
                </p>
              </form>
            </CardContent>
          </Card>
        )}

        {/* Window Open but not eligible for other reasons */}
        {isWindowOpen && !canRequestPayout && eligibility && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-muted-foreground">
                <AlertTriangle className="h-5 w-5" />
                Payout Unavailable
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-muted-foreground">
                {eligibility.reason || 'You are not currently eligible to request a payout.'}
              </p>
              {eligibility.hint && (
                <p className="text-sm text-muted-foreground mt-2">{eligibility.hint}</p>
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </DashboardLayout>
  );
}
