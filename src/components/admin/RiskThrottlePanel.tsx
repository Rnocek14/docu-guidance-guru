import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { supabase } from '@/integrations/supabase/client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Activity, ShieldAlert, ShoppingCart, Clock, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { useState } from 'react';

const STATE_CONFIG = {
  green: { label: 'GREEN', variant: 'default' as const, color: 'text-green-500' },
  yellow: { label: 'YELLOW', variant: 'secondary' as const, color: 'text-yellow-500' },
  orange: { label: 'ORANGE', variant: 'destructive' as const, color: 'text-orange-500' },
  red: { label: 'RED', variant: 'destructive' as const, color: 'text-red-500' },
};

export function RiskThrottlePanel() {
  const queryClient = useQueryClient();
  const [overrideReason, setOverrideReason] = useState('');

  const { data: throttle, isLoading } = useQuery({
    queryKey: ['risk-throttle-state'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('risk_throttle_state')
        .select('*')
        .eq('id', '00000000-0000-0000-0000-000000000002')
        .single();

      if (error) throw error;
      return data;
    },
    refetchInterval: 60_000,
  });

  const overrideMutation = useMutation({
    mutationFn: async (params: {
      purchase_enabled: boolean;
      eligibility_delay_bonus_days: number;
      reason: string;
    }) => {
      const { error } = await supabase.rpc('manual_risk_throttle_override', {
        p_purchase_enabled: params.purchase_enabled,
        p_eligibility_delay_bonus_days: params.eligibility_delay_bonus_days,
        p_reason: params.reason,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['risk-throttle-state'] });
      toast.success('Throttle override applied');
      setOverrideReason('');
    },
    onError: (err: Error) => {
      toast.error(err.message || 'Failed to apply override');
    },
  });

  const runNowMutation = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke('evaluate-risk-throttle', {
        method: 'POST',
      });
      if (error) throw error;
      return data;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['risk-throttle-state'] });
      toast.success(`Evaluation complete — state: ${data?.state ?? 'unknown'}`);
    },
    onError: (err: Error) => {
      toast.error(err.message || 'Failed to run evaluation');
    },
  });

  if (isLoading || !throttle) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Activity className="h-5 w-5" />
            Risk Throttle
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">Loading…</p>
        </CardContent>
      </Card>
    );
  }

  const stateConfig = STATE_CONFIG[throttle.state as keyof typeof STATE_CONFIG] || STATE_CONFIG.green;
  const hasOverride = !!throttle.manual_override_at;

  // Calculate override expiry
  let overrideExpiresLabel: string | null = null;
  if (hasOverride && throttle.manual_override_at) {
    const overrideAt = new Date(throttle.manual_override_at);
    const expiresAt = new Date(overrideAt.getTime() + 24 * 60 * 60 * 1000);
    const now = new Date();
    const remainingMs = expiresAt.getTime() - now.getTime();
    if (remainingMs > 0) {
      const hours = Math.floor(remainingMs / (60 * 60 * 1000));
      const mins = Math.floor((remainingMs % (60 * 60 * 1000)) / (60 * 1000));
      overrideExpiresLabel = `Expires in ${hours}h ${mins}m`;
    } else {
      overrideExpiresLabel = 'Expired — next auto-eval will re-assess';
    }
  }

  return (
    <Card className="border-primary/50">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldAlert className="h-5 w-5" />
          Pass-Rate Throttle
          <Badge variant={stateConfig.variant}>{stateConfig.label}</Badge>
          {hasOverride && (
            <Badge variant="outline" className="ml-1 text-xs">Manual Override</Badge>
          )}
        </CardTitle>
        <CardDescription>
          Automated liquidity control — only machines tighten, humans loosen.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Pass rate metrics */}
        <div className="grid grid-cols-3 gap-4">
          <div className="text-center">
            <p className="text-2xl font-bold">{Number(throttle.pass_rate_7d).toFixed(1)}%</p>
            <p className="text-xs text-muted-foreground">7-day</p>
          </div>
          <div className="text-center">
            <p className="text-2xl font-bold">{Number(throttle.pass_rate_14d).toFixed(1)}%</p>
            <p className="text-xs text-muted-foreground">14-day</p>
          </div>
          <div className="text-center">
            <p className="text-2xl font-bold">{Number(throttle.pass_rate_30d).toFixed(1)}%</p>
            <p className="text-xs text-muted-foreground">30-day</p>
          </div>
        </div>

        {/* Active controls */}
        <div className="space-y-3 pt-2 border-t border-border">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <ShoppingCart className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-medium">Purchases</span>
            </div>
            <Badge variant={throttle.purchase_enabled ? 'default' : 'destructive'}>
              {throttle.purchase_enabled ? 'ENABLED' : 'BLOCKED'}
            </Badge>
          </div>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Clock className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-medium">Eligibility Delay Bonus</span>
            </div>
            <span className="text-sm font-mono">
              +{throttle.eligibility_delay_bonus_days} days
            </span>
          </div>
        </div>

        {/* Reason */}
        {throttle.reason && (
          <p className="text-xs text-muted-foreground bg-muted/50 rounded p-2">
            {throttle.reason}
          </p>
        )}

        {/* Override expiry */}
        {overrideExpiresLabel && (
          <p className="text-xs font-medium text-amber-600 dark:text-amber-400">
            ⏱ Override: {overrideExpiresLabel}
          </p>
        )}

        {/* Last evaluated */}
        {throttle.auto_updated_at && (
          <p className="text-xs text-muted-foreground">
            Last auto-eval: {new Date(throttle.auto_updated_at).toLocaleString()}
          </p>
        )}

        {/* Run evaluation now */}
        <div className="pt-2">
          <Button
            size="sm"
            variant="outline"
            className="w-full"
            disabled={runNowMutation.isPending}
            onClick={() => runNowMutation.mutate()}
          >
            <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${runNowMutation.isPending ? 'animate-spin' : ''}`} />
            {runNowMutation.isPending ? 'Evaluating…' : 'Run Evaluation Now'}
          </Button>
        </div>

        {/* Manual override controls */}
        <div className="pt-3 border-t border-border space-y-3">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Admin Override (Loosen Only)
          </p>
          <div className="flex items-center gap-3">
            <input
              type="text"
              placeholder="Override reason…"
              className="flex-1 text-sm rounded-md border border-input bg-background px-3 py-1.5"
              value={overrideReason}
              onChange={(e) => setOverrideReason(e.target.value)}
            />
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={!overrideReason || overrideMutation.isPending}
              onClick={() =>
                overrideMutation.mutate({
                  purchase_enabled: true,
                  eligibility_delay_bonus_days: 0,
                  reason: overrideReason,
                })
              }
            >
              Release All
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!overrideReason || overrideMutation.isPending}
              onClick={() =>
                overrideMutation.mutate({
                  purchase_enabled: true,
                  eligibility_delay_bonus_days: throttle.eligibility_delay_bonus_days,
                  reason: overrideReason,
                })
              }
            >
              Enable Purchases Only
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
