import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { supabase } from '@/integrations/supabase/client';
import { useQuery } from '@tanstack/react-query';
import { Gauge, TrendingUp, Info } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

// Solo-operator steady-state ceiling (see capacity-monitoring memory)
const FUNDED_CEILING = 500;
// Comfort zone — where ops load stays manageable for a solo operator
const COMFORT_TARGET = 200;
// Assumed average funded-account tenure in months before churn/breach/cap-out
const AVG_FUNDED_TENURE_MONTHS = 3;
// Fixed monthly opex floor — below this signup volume, margin gets thin
const MIN_VIABLE_SIGNUPS = 50;

function stageFor(funded: number): { label: string; tone: 'default' | 'secondary' | 'destructive' } {
  if (funded < 50) return { label: 'Bootstrap', tone: 'secondary' };
  if (funded < 300) return { label: 'Growth', tone: 'default' };
  if (funded < FUNDED_CEILING) return { label: 'Approaching Cap', tone: 'secondary' };
  return { label: 'At Capacity', tone: 'destructive' };
}

export function SignupCapacityCard() {
  const { data, isLoading } = useQuery({
    queryKey: ['signup-capacity'],
    refetchInterval: 60_000,
    queryFn: async () => {
      const [fundedRes, throttleRes] = await Promise.all([
        supabase
          .from('accounts')
          .select('id, cohorts!inner(cohort_phase)', { count: 'exact', head: true })
          .eq('status', 'active')
          .eq('cohorts.cohort_phase', 'performance'),
        supabase
          .from('risk_throttle_state')
          .select('state, pass_rate_30d, purchase_enabled')
          .eq('id', '00000000-0000-0000-0000-000000000002')
          .single(),
      ]);

      const funded = fundedRes.count ?? 0;
      const throttle = throttleRes.data;
      // Pass rate as decimal — fall back to a conservative 12% if unknown
      const passRateRaw = Number(throttle?.pass_rate_30d ?? 0);
      const passRate = passRateRaw > 0 ? passRateRaw / 100 : 0.12;
      const purchaseEnabled = throttle?.purchase_enabled ?? true;
      const state = (throttle?.state ?? 'green') as 'green' | 'yellow' | 'orange' | 'red';

      const headroom = Math.max(FUNDED_CEILING - funded, 0);
      const comfortHeadroom = Math.max(COMFORT_TARGET - funded, 0);
      // Safe new signups per month = funded-headroom / pass-rate / tenure
      // We base the recommendation on the COMFORT target, not the hard ceiling.
      const comfortBased = Math.floor(comfortHeadroom / passRate / AVG_FUNDED_TENURE_MONTHS);
      const ceilingBased = Math.floor(headroom / passRate / AVG_FUNDED_TENURE_MONTHS);
      // Throttle multiplier (matches the auto-throttle states)
      const throttleMultiplier = !purchaseEnabled
        ? 0
        : state === 'red'
          ? 0
          : state === 'orange'
            ? 0.4
            : state === 'yellow'
              ? 0.7
              : 1.0;

      const safeMonthly = Math.max(
        Math.floor(comfortBased * throttleMultiplier),
        0,
      );
      const maxMonthly = Math.max(
        Math.floor(ceilingBased * throttleMultiplier),
        0,
      );
      const safeDaily = Math.max(Math.floor(safeMonthly / 30), 0);

      return {
        funded,
        headroom,
        comfortHeadroom,
        passRatePct: passRate * 100,
        purchaseEnabled,
        state,
        safeMonthly,
        maxMonthly,
        safeDaily,
        comfortPct: Math.min(100, Math.round((funded / COMFORT_TARGET) * 100)),
        ceilingPct: Math.min(100, Math.round((funded / FUNDED_CEILING) * 100)),
      };
    },
  });

  if (isLoading || !data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Gauge className="h-5 w-5" /> Signup Capacity
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">Loading…</p>
        </CardContent>
      </Card>
    );
  }

  const stage = stageFor(data.funded);
  const belowViable = data.safeMonthly > 0 && data.safeMonthly < MIN_VIABLE_SIGNUPS;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Gauge className="h-5 w-5" />
          Signup Capacity
          <Badge variant={stage.tone}>{stage.label}</Badge>
          {!data.purchaseEnabled && (
            <Badge variant="destructive">Purchases Blocked</Badge>
          )}
        </CardTitle>
        <CardDescription>
          How many new signups you can absorb right now without overloading reserves. Auto-balances against funded account count and pass-rate throttle.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid grid-cols-2 gap-6">
          <div>
            <div className="flex items-baseline gap-2">
              <span className="text-4xl font-bold">{data.safeMonthly.toLocaleString()}</span>
              <span className="text-sm text-muted-foreground">/ month</span>
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              ≈ {data.safeDaily.toLocaleString()} per day · comfort-zone pace
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Absolute max: {data.maxMonthly.toLocaleString()}/mo (stretches ops to the ceiling)
            </p>
          </div>
          <div>
            <div className="flex items-baseline gap-2">
              <span className="text-2xl font-semibold">{data.funded}</span>
              <span className="text-sm text-muted-foreground">
                / {COMFORT_TARGET} comfort · {FUNDED_CEILING} ceiling
              </span>
            </div>
            <Progress value={data.comfortPct} className="mt-2 h-2" />
            <p className="text-xs text-muted-foreground mt-1">
              {data.comfortHeadroom > 0
                ? `${data.comfortHeadroom} slots until comfort target`
                : `${data.headroom} slots until hard ceiling (past comfort zone)`}
            </p>
          </div>
        </div>

        <div className="rounded-md border border-border bg-muted/40 p-3 text-xs space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Current pass rate (30d)</span>
            <span className="font-mono">{data.passRatePct.toFixed(1)}%</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Throttle state</span>
            <span className="font-mono uppercase">{data.state}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Avg funded tenure assumed</span>
            <span className="font-mono">{AVG_FUNDED_TENURE_MONTHS} mo</span>
          </div>
        </div>

        {data.safeMonthly === 0 ? (
          <p className="text-xs text-destructive">
            Capacity is throttled to zero — purchases are blocked or the system is in RED state. The auto-throttle will reopen intake when pass-rate normalizes.
          </p>
        ) : belowViable ? (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            Headroom is below the {MIN_VIABLE_SIGNUPS}/mo viability floor — margin will be thin against fixed opex. Consider a price bump or wait for funded accounts to roll off.
          </p>
        ) : (
          <p className="text-xs text-muted-foreground flex items-start gap-1.5">
            <TrendingUp className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            You can comfortably absorb up to <strong className="text-foreground">{data.safeMonthly}</strong> new signups this month. The pass-rate throttle will automatically tighten purchases if too many start getting funded.
          </p>
        )}

        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <button className="text-xs text-muted-foreground inline-flex items-center gap-1 hover:text-foreground">
                <Info className="h-3 w-3" /> How is this calculated?
              </button>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs text-xs">
              <p className="mb-1"><strong>Formula:</strong></p>
              <p>safe/mo = (ceiling − funded) ÷ pass_rate ÷ tenure × throttle_multiplier</p>
              <p className="mt-2 text-muted-foreground">
                Ceiling = {FUNDED_CEILING} concurrent funded (solo-operator scaling limit). Throttle multipliers: GREEN 1.0, YELLOW 0.7, ORANGE 0.4, RED 0.
              </p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </CardContent>
    </Card>
  );
}