import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Separator } from '@/components/ui/separator';
import { GitCompare, AlertTriangle, TrendingDown, ArrowRight, Info } from 'lucide-react';

interface CompoundImpact {
  current: {
    avg_payout_split: number;
    avg_lifetime_cap_multiple: number;
    avg_entry_fee: number;
    avg_first_payout_cap: number;
    estimated_breakeven_pass_rate: number;
  };
  proposed: {
    avg_payout_split: number;
    avg_lifetime_cap_multiple: number;
    avg_first_payout_cap: number;
    estimated_breakeven_pass_rate: number;
  };
  delta: {
    split_change_pct: number;
    cap_multiple_change: number;
    first_cap_change: number;
    breakeven_shift_pct: number;
  };
  breaker: {
    level: string;
    rolling_pass_rate: number;
    headroom_to_elevated: number;
    headroom_to_breakeven: number;
  };
  pending_changes_count: number;
  pending_changes: Array<{
    id: string;
    setting_key: string;
    proposed_value: unknown;
    reason: string | null;
    proposed_at: string;
    proposed_by_system: boolean;
  }>;
  approximation_notice: string;
  warning: string | null;
  evaluated_at: string;
}

export function CompoundImpactPanel() {
  const { data: impact, isLoading } = useQuery({
    queryKey: ['compound-config-impact'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('simulate_compound_config_impact');
      if (error) throw error;
      return data as unknown as CompoundImpact;
    },
    refetchInterval: 30000,
  });

  if (isLoading || !impact) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <GitCompare className="h-5 w-5" />
            Configuration Impact
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="h-20 flex items-center justify-center text-muted-foreground">
            Analyzing configuration impact...
          </div>
        </CardContent>
      </Card>
    );
  }

  const hasPending = impact.pending_changes_count > 0;
  const isDangerous = impact.warning?.startsWith('DANGER');
  const isWarning = impact.warning?.startsWith('WARNING');

  return (
    <Card className={isDangerous ? 'border-destructive/50' : isWarning ? 'border-warning/50' : ''}>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <GitCompare className="h-5 w-5" />
            Configuration Impact Simulator
          </CardTitle>
          {hasPending && (
            <Badge variant={isDangerous ? 'destructive' : isWarning ? 'outline' : 'secondary'}>
              {impact.pending_changes_count} pending
            </Badge>
          )}
        </div>
        <CardDescription>
          Cumulative effect of all pending safety setting changes on platform economics
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Warning Banner */}
        {impact.warning && (
          <Alert variant={isDangerous ? 'destructive' : 'default'}>
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription className="text-sm font-medium">
              {impact.warning}
            </AlertDescription>
          </Alert>
        )}

        {/* Current vs Proposed */}
        <div className="grid grid-cols-3 gap-4 text-center">
          <div className="space-y-1">
            <div className="text-xs text-muted-foreground uppercase tracking-wider">Current</div>
            <div className="text-2xl font-bold">{impact.current.estimated_breakeven_pass_rate}%</div>
            <div className="text-xs text-muted-foreground">breakeven pass rate</div>
          </div>
          <div className="flex items-center justify-center">
            <ArrowRight className="h-5 w-5 text-muted-foreground" />
          </div>
          <div className="space-y-1">
            <div className="text-xs text-muted-foreground uppercase tracking-wider">
              {hasPending ? 'If Approved' : 'No Changes'}
            </div>
            <div className={`text-2xl font-bold ${
              impact.delta.breakeven_shift_pct < -1 ? 'text-destructive' :
              impact.delta.breakeven_shift_pct < 0 ? 'text-warning' :
              'text-foreground'
            }`}>
              {impact.proposed.estimated_breakeven_pass_rate}%
            </div>
            <div className="text-xs text-muted-foreground">breakeven pass rate</div>
          </div>
        </div>

        {/* Delta Details */}
        {hasPending && (
          <>
            <Separator />
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <span className="text-muted-foreground">Avg Split:</span>{' '}
                <span className="font-medium">{impact.current.avg_payout_split}%</span>
                {impact.delta.split_change_pct !== 0 && (
                  <span className={`ml-1 ${impact.delta.split_change_pct > 0 ? 'text-destructive' : 'text-success'}`}>
                    ({impact.delta.split_change_pct > 0 ? '+' : ''}{impact.delta.split_change_pct}%)
                  </span>
                )}
              </div>
              <div>
                <span className="text-muted-foreground">Breakeven Δ:</span>{' '}
                <span className={`font-medium ${impact.delta.breakeven_shift_pct < 0 ? 'text-destructive' : 'text-success'}`}>
                  {impact.delta.breakeven_shift_pct > 0 ? '+' : ''}{impact.delta.breakeven_shift_pct}pp
                </span>
              </div>
              <div>
                <span className="text-muted-foreground">Cap Multiple:</span>{' '}
                <span className="font-medium">{impact.current.avg_lifetime_cap_multiple}x</span>
                {impact.delta.cap_multiple_change !== 0 && (
                  <span className={`ml-1 ${impact.delta.cap_multiple_change > 0 ? 'text-destructive' : 'text-success'}`}>
                    ({impact.delta.cap_multiple_change > 0 ? '+' : ''}{impact.delta.cap_multiple_change})
                  </span>
                )}
              </div>
              <div>
                <span className="text-muted-foreground">First Cap:</span>{' '}
                <span className="font-medium">${impact.current.avg_first_payout_cap}</span>
                {impact.delta.first_cap_change !== 0 && (
                  <span className={`ml-1 ${impact.delta.first_cap_change > 0 ? 'text-success' : 'text-destructive'}`}>
                    ({impact.delta.first_cap_change > 0 ? '+' : ''}${impact.delta.first_cap_change})
                  </span>
                )}
              </div>
            </div>
          </>
        )}

        <Separator />

        {/* Live Breaker Context */}
        <div className="space-y-2">
          <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Live Breaker Context
          </div>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <span className="text-muted-foreground">Current Pass Rate:</span>{' '}
              <span className={`font-medium ${impact.breaker.rolling_pass_rate >= 15 ? 'text-destructive' : ''}`}>
                {Number(impact.breaker.rolling_pass_rate).toFixed(1)}%
              </span>
            </div>
            <div>
              <span className="text-muted-foreground">Headroom to Breakeven:</span>{' '}
              <span className={`font-medium ${Number(impact.breaker.headroom_to_breakeven) < 3 ? 'text-warning' : ''}`}>
                {Number(impact.breaker.headroom_to_breakeven).toFixed(1)}pp
              </span>
            </div>
          </div>
        </div>

        {/* No pending changes info */}
        {!hasPending && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Info className="h-3 w-3" />
            No pending configuration changes. Impact analysis will update when changes are proposed.
          </div>
        )}

        {/* Key structural metrics */}
        <div className="flex items-center gap-4 text-xs text-muted-foreground pt-1">
          <span>Cap Multiple: {impact.current.avg_lifetime_cap_multiple}x</span>
          <span>Avg Entry: ${impact.current.avg_entry_fee}</span>
          <span>First Cap: ${impact.current.avg_first_payout_cap}</span>
        </div>

        {/* Approximation notice */}
        <div className="flex items-center gap-2 text-xs text-muted-foreground/60 pt-1 border-t border-border/50">
          <Info className="h-3 w-3 shrink-0" />
          <span>{impact.approximation_notice || 'Heuristic estimate — not a Monte Carlo simulation.'}</span>
        </div>
      </CardContent>
    </Card>
  );
}
