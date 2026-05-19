import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Progress } from '@/components/ui/progress';
import { Separator } from '@/components/ui/separator';
import {
  ShieldAlert,
  ShieldCheck,
  ShieldX,
  Zap,
  Lock,
  Unlock,
  TrendingUp,
  DollarSign,
  Clock,
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

interface BreakerState {
  breaker_level: string;
  payouts_blocked: boolean;
  approvals_blocked: boolean;
  evaluations_frozen: boolean;
  rolling_pass_rate: number;
  rolling_pass_count: number;
  rolling_total_count: number;
  net_buffer: number | null;
  pending_liability: number;
  last_evaluated_at: string;
  triggered_by: string | null;
  previous_level: string | null;
  rolling_payrev_ratio: number;
  payrev_revenue_30d: number;
  payrev_payouts_30d: number;
  payrev_window_days: number;
  payrev_level: string;
  payrev_release_streak: number;
  last_transition_at: string | null;
  last_transition_reason: string | null;
}

const LEVEL_CONFIG = {
  normal: {
    icon: ShieldCheck,
    color: 'text-success',
    bg: 'bg-success/10 border-success/30',
    badge: 'default' as const,
    label: 'Normal',
    description: 'All systems operational. Pass rate within safe bounds.',
  },
  elevated: {
    icon: ShieldAlert,
    color: 'text-warning',
    bg: 'bg-warning/10 border-warning/30',
    badge: 'outline' as const,
    label: 'Elevated',
    description: 'Pass rate ≥15% or negative net buffer. Payouts paused.',
  },
  critical: {
    icon: ShieldX,
    color: 'text-destructive',
    bg: 'bg-destructive/10 border-destructive/30',
    badge: 'destructive' as const,
    label: 'Critical',
    description: 'Pass rate ≥18%. Payouts AND approvals blocked.',
  },
  emergency: {
    icon: Zap,
    color: 'text-destructive',
    bg: 'bg-destructive/20 border-destructive/50',
    badge: 'destructive' as const,
    label: 'Emergency',
    description: 'Pass rate ≥20%. All payouts, approvals, and new evaluations frozen.',
  },
};

const THRESHOLD_ELEVATED = 15;
const THRESHOLD_CRITICAL = 18;
const THRESHOLD_EMERGENCY = 20;

// Pay/Rev thresholds (calibrated v1.1, 2026-05-19)
const PAYREV_L1 = 0.30; // tighten
const PAYREV_L2 = 0.45; // freeze
const PAYREV_L2_RELEASE = 0.40;
const PAYREV_L1_RELEASE = 0.25;

export function BreakerStatusPanel() {
  const { data: breaker, isLoading } = useQuery({
    queryKey: ['econ-breaker-state'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_econ_breaker_state');
      if (error) throw error;
      return (data as unknown as BreakerState[])?.[0] ?? null;
    },
    refetchInterval: 10000, // Every 10s — this is a critical metric
  });

  if (isLoading || !breaker) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5" />
            Circuit Breaker
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="h-24 flex items-center justify-center text-muted-foreground">
            Loading breaker state...
          </div>
        </CardContent>
      </Card>
    );
  }

  const level = breaker.breaker_level as keyof typeof LEVEL_CONFIG;
  const config = LEVEL_CONFIG[level] || LEVEL_CONFIG.normal;
  const Icon = config.icon;
  const passRate = Number(breaker.rolling_pass_rate) || 0;
  const payRev = Number(breaker.rolling_payrev_ratio) || 0;
  const payRevPct = payRev * 100;
  const payrevLevel = (breaker.payrev_level || 'normal') as 'normal' | 'elevated' | 'critical';
  const payrevDrivingColor =
    payrevLevel === 'critical' ? 'text-destructive'
    : payrevLevel === 'elevated' ? 'text-warning'
    : 'text-foreground';

  // Calculate how close to each threshold
  const headroomToElevated = Math.max(0, THRESHOLD_ELEVATED - passRate);
  const headroomToCritical = Math.max(0, THRESHOLD_CRITICAL - passRate);

  return (
    <Card className={`border ${config.bg}`}>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <Icon className={`h-5 w-5 ${config.color}`} />
            Circuit Breaker
          </CardTitle>
          <Badge variant={config.badge} className="text-sm">
            {config.label}
          </Badge>
        </div>
        <CardDescription>{config.description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Pass Rate Gauge */}
        <div className="space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span className="flex items-center gap-1">
              <TrendingUp className="h-3.5 w-3.5 text-muted-foreground" />
              Rolling 30-Day Pass Rate
            </span>
            <span className={`font-bold ${passRate >= 15 ? 'text-destructive' : 'text-foreground'}`}>
              {passRate.toFixed(1)}%
            </span>
          </div>
          <div className="relative">
            <Progress
              value={Math.min(passRate / THRESHOLD_EMERGENCY * 100, 100)}
              className="h-3"
            />
            {/* Threshold markers */}
            <div className="absolute top-0 h-3 flex items-center" style={{ left: `${(THRESHOLD_ELEVATED / THRESHOLD_EMERGENCY) * 100}%` }}>
              <div className="w-0.5 h-full bg-warning" />
            </div>
            <div className="absolute top-0 h-3 flex items-center" style={{ left: `${(THRESHOLD_CRITICAL / THRESHOLD_EMERGENCY) * 100}%` }}>
              <div className="w-0.5 h-full bg-destructive" />
            </div>
          </div>
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>0%</span>
            <span className="text-warning">15%</span>
            <span className="text-destructive">18%</span>
            <span className="text-destructive font-bold">20%</span>
          </div>
        </div>

        <div className="text-xs text-muted-foreground">
          {breaker.rolling_pass_count}/{breaker.rolling_total_count} accounts passed in 30-day window
          {headroomToElevated > 0 && level === 'normal' && (
            <span className="ml-1">• {headroomToElevated.toFixed(1)}pp headroom to elevated</span>
          )}
          {headroomToCritical > 0 && level === 'elevated' && (
            <span className="ml-1">• {headroomToCritical.toFixed(1)}pp headroom to critical</span>
          )}
        </div>

        <Separator />

        {/* Pay/Rev Gauge — v1.1 production breaker signal */}
        <div className="space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span className="flex items-center gap-1">
              <DollarSign className="h-3.5 w-3.5 text-muted-foreground" />
              Rolling 30-Day Pay/Rev
            </span>
            <span className={`font-bold ${payrevDrivingColor}`}>
              {payRevPct.toFixed(1)}%
            </span>
          </div>
          <div className="relative">
            <Progress
              value={Math.min((payRev / 0.60) * 100, 100)}
              className="h-3"
            />
            <div className="absolute top-0 h-3 flex items-center" style={{ left: `${(PAYREV_L1 / 0.60) * 100}%` }}>
              <div className="w-0.5 h-full bg-warning" />
            </div>
            <div className="absolute top-0 h-3 flex items-center" style={{ left: `${(PAYREV_L2 / 0.60) * 100}%` }}>
              <div className="w-0.5 h-full bg-destructive" />
            </div>
          </div>
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>0%</span>
            <span className="text-warning">30% L1</span>
            <span className="text-destructive">45% L2</span>
            <span>60%</span>
          </div>
          <div className="text-xs text-muted-foreground">
            ${Math.round(breaker.payrev_payouts_30d).toLocaleString()} paid /
            {' '}${Math.round(breaker.payrev_revenue_30d).toLocaleString()} revenue •
            sub-level <code className="bg-muted px-1 rounded">{payrevLevel}</code>
            {payrevLevel !== 'normal' && breaker.payrev_release_streak > 0 && (
              <span> • release streak {breaker.payrev_release_streak}/{payrevLevel === 'critical' ? 12 : 36}</span>
            )}
          </div>
          <div className="text-[10px] text-muted-foreground/80">
            Window: trailing 30 days, fulfilled checkouts vs paid+paid_confirmed payouts.
            Tighten {'>'}30%, Freeze {'>'}45%. Release at {'<'}{PAYREV_L2_RELEASE*100}% / {'<'}{PAYREV_L1_RELEASE*100}% with hysteresis.
          </div>
        </div>

        <Separator />

        {/* Control Surface Status */}
        <div className="grid grid-cols-3 gap-3">
          <div className={`flex items-center gap-2 p-2 rounded-md text-sm ${breaker.payouts_blocked ? 'bg-destructive/10' : 'bg-muted'}`}>
            {breaker.payouts_blocked ? <Lock className="h-4 w-4 text-destructive" /> : <Unlock className="h-4 w-4 text-success" />}
            <span className={breaker.payouts_blocked ? 'text-destructive font-medium' : 'text-muted-foreground'}>
              Payouts
            </span>
          </div>
          <div className={`flex items-center gap-2 p-2 rounded-md text-sm ${breaker.approvals_blocked ? 'bg-destructive/10' : 'bg-muted'}`}>
            {breaker.approvals_blocked ? <Lock className="h-4 w-4 text-destructive" /> : <Unlock className="h-4 w-4 text-success" />}
            <span className={breaker.approvals_blocked ? 'text-destructive font-medium' : 'text-muted-foreground'}>
              Approvals
            </span>
          </div>
          <div className={`flex items-center gap-2 p-2 rounded-md text-sm ${breaker.evaluations_frozen ? 'bg-destructive/10' : 'bg-muted'}`}>
            {breaker.evaluations_frozen ? <Lock className="h-4 w-4 text-destructive" /> : <Unlock className="h-4 w-4 text-success" />}
            <span className={breaker.evaluations_frozen ? 'text-destructive font-medium' : 'text-muted-foreground'}>
              Intake
            </span>
          </div>
        </div>

        {/* Financial Context */}
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div className="flex items-center gap-2">
            <DollarSign className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-muted-foreground">Net Buffer:</span>
            <span className={`font-medium ${(breaker.net_buffer ?? 0) < 0 ? 'text-destructive' : 'text-foreground'}`}>
              ${Math.round(breaker.net_buffer ?? 0).toLocaleString()}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <DollarSign className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-muted-foreground">Pending:</span>
            <span className="font-medium">
              ${Math.round(breaker.pending_liability).toLocaleString()}
            </span>
          </div>
        </div>

        {/* Last Evaluation */}
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Clock className="h-3 w-3" />
          Last evaluated {formatDistanceToNow(new Date(breaker.last_evaluated_at), { addSuffix: true })}
          {breaker.triggered_by && (
            <span>• triggered by <code className="bg-muted px-1 rounded">{breaker.triggered_by}</code></span>
          )}
        </div>

        {/* Level change alert */}
        {breaker.previous_level && breaker.previous_level !== breaker.breaker_level && (
          <Alert variant={level === 'normal' ? 'default' : 'destructive'} className="mt-2">
            <AlertTitle className="text-sm">Level Changed</AlertTitle>
            <AlertDescription className="text-xs">
              {breaker.previous_level} → {breaker.breaker_level}
              {breaker.last_transition_at && (
                <span> • {formatDistanceToNow(new Date(breaker.last_transition_at), { addSuffix: true })}</span>
              )}
              {breaker.last_transition_reason && (
                <div className="mt-1 font-mono text-[10px] opacity-80">{breaker.last_transition_reason}</div>
              )}
            </AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}
