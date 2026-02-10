import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Eye } from 'lucide-react';
import type { Account, Cohort } from '@/lib/types';
import { supabase } from '@/integrations/supabase/client';
import { useQuery } from '@tanstack/react-query';

interface ConsistencyPreviewCardProps {
  account: Account & { cohort: Cohort };
}

/**
 * Shows Challenge-phase traders what Verification will require,
 * so they can train toward those constraints early.
 */
export function ConsistencyPreviewCard({ account }: ConsistencyPreviewCardProps) {
  const cohortPhase = account.cohort?.cohort_phase;

  // Only show for evaluation (challenge) phase accounts
  if (cohortPhase !== 'evaluation') return null;

  // Fetch the next cohort (verification) to show its rules
  const nextCohortId = account.cohort?.next_cohort_id;

  const { data: nextCohort } = useQuery({
    queryKey: ['next-cohort-preview', nextCohortId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('cohorts')
        .select('name, profit_target_percent, min_trading_days, min_profitable_days, max_daily_profit_cap_percent')
        .eq('id', nextCohortId!)
        .single();
      if (error) throw error;
      return data;
    },
    enabled: !!nextCohortId,
  });

  // Fetch current daily stats to show how trader would fare
  const { data: dailyStats } = useQuery({
    queryKey: ['consistency-preview-stats', account.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('account_daily_stats')
        .select('net_pnl, is_winning_day')
        .eq('account_id', account.id);
      if (error) throw error;
      return data;
    },
    enabled: !!account.id,
  });

  if (!nextCohort) return null;

  // Compute how the trader's current behavior maps to verification rules
  const totalProfit = dailyStats?.reduce((s, d) => s + Math.max(0, Number(d.net_pnl)), 0) ?? 0;
  const bestDayPnl = dailyStats?.reduce((max, d) => {
    const pnl = Number(d.net_pnl);
    return pnl > max ? pnl : max;
  }, 0) ?? 0;
  const bestDayPct = totalProfit > 0 ? (bestDayPnl / totalProfit) * 100 : 0;
  const bestDayCap = nextCohort.max_daily_profit_cap_percent ?? 40;
  const wouldPassBestDay = bestDayPct <= bestDayCap;

  const profitableDays = dailyStats?.filter((d) => d.is_winning_day).length ?? 0;
  const minProfitableDays = nextCohort.min_profitable_days ?? 5;
  const wouldPassMinDays = profitableDays >= minProfitableDays;

  // Non-binary status: Good / Watch / Risky with quantified gap
  type RuleStatus = 'good' | 'watch' | 'risky';
  const getBestDayStatus = (): RuleStatus => {
    if (bestDayPct <= bestDayCap * 0.8) return 'good';
    if (bestDayPct <= bestDayCap) return 'watch';
    return 'risky';
  };
  const getMinDaysStatus = (): RuleStatus => {
    if (profitableDays >= minProfitableDays) return 'good';
    if (profitableDays >= minProfitableDays * 0.6) return 'watch';
    return 'risky';
  };

  const rules = [
    {
      label: 'Profit Distribution',
      description: 'No single day should dominate your total gains',
      current: null,
      status: getBestDayStatus(),
      tooltip: 'Reviewers look for consistent performance across multiple days.',
    },
    {
      label: 'Minimum Profitable Days',
      description: 'A minimum number of winning days is required',
      current: null,
      status: getMinDaysStatus(),
      tooltip: null,
    },
    {
      label: 'Profit Target',
      description: 'Separate target for verification phase',
      current: null,
      status: null as RuleStatus | null,
      tooltip: null,
    },
    {
      label: 'Min Trading Days',
      description: 'More trading days required in verification',
      current: null,
      status: null as RuleStatus | null,
      tooltip: null,
    },
  ];

  return (
    <Card className="border-dashed">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2 text-lg">
              <Eye className="h-5 w-5 text-primary" />
              Verification Preview
            </CardTitle>
            <CardDescription>
              What {nextCohort.name} will require — start training now
            </CardDescription>
          </div>
          <Badge variant="outline" className="text-xs">Next Phase</Badge>
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-2.5">
          {rules.map((rule) => (
            <div key={rule.label} className="flex items-start justify-between gap-4 text-sm">
              <div>
                <div className="font-medium">{rule.label}</div>
                <div className="text-xs text-muted-foreground">{rule.description}</div>
              </div>
              {rule.status !== null ? (
                <div className="flex flex-col items-end shrink-0">
                  <Badge
                    variant={rule.status === 'good' ? 'default' : rule.status === 'risky' ? 'destructive' : 'outline'}
                    className="text-xs"
                  >
                    {rule.status === 'good' ? 'Good' : rule.status === 'watch' ? 'Watch' : 'Risky'}
                  </Badge>
                  {rule.current && (
                    <span className="text-[11px] text-muted-foreground mt-0.5" title={rule.tooltip ?? undefined}>
                      {rule.current}
                    </span>
                  )}
                </div>
              ) : (
                <Badge variant="secondary" className="text-xs shrink-0">Info</Badge>
              )}
            </div>
          ))}
        </div>
        <div className="mt-3 pt-3 border-t border-border text-xs text-muted-foreground">
          These rules are enforced in Verification, not now. Building consistent habits early improves your chances.
        </div>
      </CardContent>
    </Card>
  );
}
