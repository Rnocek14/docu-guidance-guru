import { useMemo, useState } from 'react';
import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { missionControlNavItems } from '@/components/layout/AdminNav';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Separator } from '@/components/ui/separator';
import { TrendingUp, AlertTriangle, DollarSign, Users } from 'lucide-react';
import {
  ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis, Tooltip, Legend, CartesianGrid,
} from 'recharts';

const STORAGE_KEY = 'meridian.cohort-projection.v1';

type Inputs = {
  monthsToProject: number;
  evalsPerMonth: number;
  evalPrice: number;
  resetPrice: number;
  resetRate: number;        // % of failed evals that buy a reset
  passRate: number;         // % of evals that reach funded
  payoutRequestRate: number;// % of funded that EVER request a payout (asymptote)
  avgFirstPayout: number;
  avgRepeatPayout: number;
  cac: number;
  refundRate: number;       // % of revenue
  stripeFeePct: number;
  wcCostPerActiveAccount: number;
  infraMonthly: number;
  supportMonthly: number;
};

const DEFAULTS: Inputs = {
  monthsToProject: 6,
  evalsPerMonth: 200,
  evalPrice: 150,
  resetPrice: 80,
  resetRate: 35,
  passRate: 10,
  payoutRequestRate: 70,
  avgFirstPayout: 400,
  avgRepeatPayout: 700,
  cac: 60,
  refundRate: 4,
  stripeFeePct: 3,
  wcCostPerActiveAccount: 8,
  infraMonthly: 300,
  supportMonthly: 500,
};

function loadInputs(): Inputs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch { return DEFAULTS; }
}

// Maturity curve: % of a cohort's eventual payouts that have happened by month N
// (S-shape: slow start, ramps months 2-4, asymptote by month 6)
const MATURITY = [0.05, 0.20, 0.45, 0.65, 0.80, 0.90, 0.95, 0.98, 1.0, 1.0, 1.0, 1.0];

function project(inp: Inputs) {
  const months: number[] = Array.from({ length: inp.monthsToProject }, (_, i) => i + 1);
  const fundedPerCohort = inp.evalsPerMonth * (inp.passRate / 100);
  const eventualPayoutTradersPerCohort = fundedPerCohort * (inp.payoutRequestRate / 100);

  // Per cohort total expected payouts $ over lifetime:
  // first payout for everyone who pays out + ~2 repeat avgs as tail
  const totalPayoutPerCohort =
    eventualPayoutTradersPerCohort * (inp.avgFirstPayout + inp.avgRepeatPayout * 1.5);

  const rows = months.map((m) => {
    // Revenue this month
    const failedThisMonth = inp.evalsPerMonth - fundedPerCohort;
    const resetsThisMonth = failedThisMonth * (inp.resetRate / 100);
    const grossRevenue = inp.evalsPerMonth * inp.evalPrice + resetsThisMonth * inp.resetPrice;

    // Payouts: sum maturity-weighted slice from each prior cohort + this month's new cohort
    let payouts = 0;
    for (let c = 1; c <= m; c++) {
      const age = m - c; // 0 = brand new cohort
      const cur = MATURITY[Math.min(age, MATURITY.length - 1)];
      const prev = age === 0 ? 0 : MATURITY[Math.min(age - 1, MATURITY.length - 1)];
      payouts += totalPayoutPerCohort * (cur - prev);
    }

    // Active accounts billed by WealthCharts ~= funded accounts still trading
    // Rough proxy: cumulative funded × 0.7 retention
    const cumulativeFunded = fundedPerCohort * m;
    const activeAccounts = cumulativeFunded * 0.7;

    const stripeFees = grossRevenue * (inp.stripeFeePct / 100);
    const refunds = grossRevenue * (inp.refundRate / 100);
    const cacCost = inp.evalsPerMonth * inp.cac;
    const wcCost = activeAccounts * inp.wcCostPerActiveAccount;
    const totalCosts = payouts + stripeFees + refunds + cacCost + wcCost + inp.infraMonthly + inp.supportMonthly;

    const net = grossRevenue - totalCosts;
    const payRev = grossRevenue > 0 ? (payouts / grossRevenue) * 100 : 0;

    return {
      month: `M${m}`,
      grossRevenue: Math.round(grossRevenue),
      payouts: Math.round(payouts),
      cac: Math.round(cacCost),
      otherCosts: Math.round(stripeFees + refunds + wcCost + inp.infraMonthly + inp.supportMonthly),
      totalCosts: Math.round(totalCosts),
      net: Math.round(net),
      payRev: +payRev.toFixed(1),
      activeAccounts: Math.round(activeAccounts),
    };
  });

  const totals = rows.reduce(
    (a, r) => ({
      revenue: a.revenue + r.grossRevenue,
      payouts: a.payouts + r.payouts,
      cac: a.cac + r.cac,
      otherCosts: a.otherCosts + r.otherCosts,
      net: a.net + r.net,
    }),
    { revenue: 0, payouts: 0, cac: 0, otherCosts: 0, net: 0 },
  );

  const avgPayRev = rows.reduce((s, r) => s + r.payRev, 0) / rows.length;
  const worstMonth = rows.reduce((w, r) => (r.net < w.net ? r : w), rows[0]);
  const breakerRisk = avgPayRev > 45 ? 'high' : avgPayRev > 30 ? 'medium' : 'low';

  return { rows, totals, avgPayRev, worstMonth, breakerRisk };
}

function NumberField({
  label, value, onChange, suffix, step = 1, hint,
}: { label: string; value: number; onChange: (v: number) => void; suffix?: string; step?: number; hint?: string }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">{label}{suffix && <span className="ml-1 text-muted-foreground">({suffix})</span>}</Label>
      <Input
        type="number"
        value={value}
        step={step}
        onChange={(e) => onChange(Number(e.target.value) || 0)}
        className="h-9"
      />
      {hint && <p className="text-[10px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

const fmt = (n: number) => `$${n.toLocaleString()}`;

export default function CohortProjection() {
  const [inp, setInp] = useState<Inputs>(loadInputs);
  const update = <K extends keyof Inputs>(k: K, v: Inputs[K]) => {
    const next = { ...inp, [k]: v };
    setInp(next);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* ignore */ }
  };
  const reset = () => { setInp(DEFAULTS); localStorage.removeItem(STORAGE_KEY); };

  const result = useMemo(() => project(inp), [inp]);

  return (
    <DashboardLayout title="Cohort Projection" navItems={missionControlNavItems}>
      <div className="space-y-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-2xl font-bold tracking-tight">Month-by-Month Cohort Projection</h2>
            <p className="text-muted-foreground">
              Punch in your real numbers each week. Models the payout tail so month 1 doesn't lie to you.
            </p>
          </div>
          <button
            onClick={reset}
            className="rounded-md border border-input bg-background px-3 py-1.5 text-sm hover:bg-muted"
          >
            Reset to defaults
          </button>
        </div>

        <Alert>
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>This is a planning model, not actuals</AlertTitle>
          <AlertDescription>
            Numbers are deterministic projections from the inputs below. Once you have real
            cohort data, compare it monthly against the model and adjust the assumptions.
          </AlertDescription>
        </Alert>

        {/* INPUTS */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Assumptions</CardTitle>
            <CardDescription>Edit any value — the projection recalculates live.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-4">
            <NumberField label="Months to project" value={inp.monthsToProject} onChange={(v) => update('monthsToProject', Math.max(1, Math.min(12, v)))} />
            <NumberField label="Evals sold / month" value={inp.evalsPerMonth} onChange={(v) => update('evalsPerMonth', v)} />
            <NumberField label="Avg eval price" value={inp.evalPrice} suffix="$" onChange={(v) => update('evalPrice', v)} />
            <NumberField label="Avg reset price" value={inp.resetPrice} suffix="$" onChange={(v) => update('resetPrice', v)} />
            <NumberField label="Reset rate" value={inp.resetRate} suffix="%" onChange={(v) => update('resetRate', v)} hint="% of failed evals that buy a reset" />
            <NumberField label="Pass rate to funded" value={inp.passRate} suffix="%" onChange={(v) => update('passRate', v)} hint="% reaching funded sim" />
            <NumberField label="Payout request rate" value={inp.payoutRequestRate} suffix="%" onChange={(v) => update('payoutRequestRate', v)} hint="% of funded who EVER request payout" />
            <NumberField label="Avg first payout" value={inp.avgFirstPayout} suffix="$" onChange={(v) => update('avgFirstPayout', v)} />
            <NumberField label="Avg repeat payout" value={inp.avgRepeatPayout} suffix="$" onChange={(v) => update('avgRepeatPayout', v)} />
            <NumberField label="CAC (per eval)" value={inp.cac} suffix="$" onChange={(v) => update('cac', v)} hint="Ad spend ÷ evals sold" />
            <NumberField label="Refund rate" value={inp.refundRate} suffix="%" onChange={(v) => update('refundRate', v)} hint="Keep under 5%" />
            <NumberField label="Stripe fees" value={inp.stripeFeePct} suffix="%" onChange={(v) => update('stripeFeePct', v)} />
            <NumberField label="WealthCharts / active acct" value={inp.wcCostPerActiveAccount} suffix="$/mo" onChange={(v) => update('wcCostPerActiveAccount', v)} />
            <NumberField label="Infra (Supabase etc.)" value={inp.infraMonthly} suffix="$/mo" onChange={(v) => update('infraMonthly', v)} />
            <NumberField label="Support / VA" value={inp.supportMonthly} suffix="$/mo" onChange={(v) => update('supportMonthly', v)} />
          </CardContent>
        </Card>

        {/* HEADLINE */}
        <div className="grid gap-4 md:grid-cols-4">
          <Card>
            <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground"><DollarSign className="h-3.5 w-3.5" />Total revenue ({inp.monthsToProject} mo)</CardTitle></CardHeader>
            <CardContent><div className="text-2xl font-bold">{fmt(result.totals.revenue)}</div></CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground"><TrendingUp className="h-3.5 w-3.5" />Net ({inp.monthsToProject} mo)</CardTitle></CardHeader>
            <CardContent><div className={`text-2xl font-bold ${result.totals.net >= 0 ? 'text-emerald-500' : 'text-destructive'}`}>{fmt(result.totals.net)}</div><p className="text-xs text-muted-foreground">≈ {fmt(Math.round(result.totals.net / inp.monthsToProject))}/mo avg</p></CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-xs uppercase tracking-wide text-muted-foreground">Avg Pay/Rev</CardTitle></CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{result.avgPayRev.toFixed(1)}%</div>
              <Badge variant={result.breakerRisk === 'high' ? 'destructive' : result.breakerRisk === 'medium' ? 'secondary' : 'default'} className="mt-1 text-[10px]">
                {result.breakerRisk === 'high' ? 'Breaker risk' : result.breakerRisk === 'medium' ? 'Watch' : 'Healthy'}
              </Badge>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground"><Users className="h-3.5 w-3.5" />Worst month</CardTitle></CardHeader>
            <CardContent>
              <div className={`text-2xl font-bold ${result.worstMonth.net >= 0 ? 'text-emerald-500' : 'text-destructive'}`}>{fmt(result.worstMonth.net)}</div>
              <p className="text-xs text-muted-foreground">{result.worstMonth.month}</p>
            </CardContent>
          </Card>
        </div>

        {/* CHART */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Monthly revenue vs payouts vs net</CardTitle>
            <CardDescription>The payout tail compounds — watch how net trends down even as revenue stays flat.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="h-72 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={result.rows}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                  <XAxis dataKey="month" className="text-xs" />
                  <YAxis className="text-xs" tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`} />
                  <Tooltip
                    formatter={(v: number) => fmt(v)}
                    contentStyle={{ background: 'hsl(var(--background))', border: '1px solid hsl(var(--border))', borderRadius: 8 }}
                  />
                  <Legend />
                  <Bar dataKey="grossRevenue" name="Revenue" fill="hsl(var(--primary))" opacity={0.7} />
                  <Bar dataKey="payouts" name="Trader payouts" fill="hsl(var(--destructive))" opacity={0.7} />
                  <Line type="monotone" dataKey="net" name="Net" stroke="hsl(var(--foreground))" strokeWidth={2} dot />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        {/* TABLE */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Month-by-month breakdown</CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="py-2 pr-3">Month</th>
                  <th className="py-2 pr-3 text-right">Revenue</th>
                  <th className="py-2 pr-3 text-right">Payouts</th>
                  <th className="py-2 pr-3 text-right">CAC</th>
                  <th className="py-2 pr-3 text-right">Other costs</th>
                  <th className="py-2 pr-3 text-right">Net</th>
                  <th className="py-2 pr-3 text-right">Pay/Rev</th>
                  <th className="py-2 pr-3 text-right">Active accts</th>
                </tr>
              </thead>
              <tbody>
                {result.rows.map((r) => (
                  <tr key={r.month} className="border-b last:border-0">
                    <td className="py-2 pr-3 font-medium">{r.month}</td>
                    <td className="py-2 pr-3 text-right font-mono">{fmt(r.grossRevenue)}</td>
                    <td className="py-2 pr-3 text-right font-mono text-destructive">{fmt(r.payouts)}</td>
                    <td className="py-2 pr-3 text-right font-mono">{fmt(r.cac)}</td>
                    <td className="py-2 pr-3 text-right font-mono">{fmt(r.otherCosts)}</td>
                    <td className={`py-2 pr-3 text-right font-mono font-semibold ${r.net >= 0 ? 'text-emerald-500' : 'text-destructive'}`}>{fmt(r.net)}</td>
                    <td className="py-2 pr-3 text-right font-mono">
                      <span className={r.payRev > 45 ? 'text-destructive' : r.payRev > 30 ? 'text-amber-500' : ''}>
                        {r.payRev}%
                      </span>
                    </td>
                    <td className="py-2 pr-3 text-right font-mono">{r.activeAccounts}</td>
                  </tr>
                ))}
                <tr className="bg-muted/50 font-semibold">
                  <td className="py-2 pr-3">Total</td>
                  <td className="py-2 pr-3 text-right font-mono">{fmt(result.totals.revenue)}</td>
                  <td className="py-2 pr-3 text-right font-mono">{fmt(result.totals.payouts)}</td>
                  <td className="py-2 pr-3 text-right font-mono">{fmt(result.totals.cac)}</td>
                  <td className="py-2 pr-3 text-right font-mono">{fmt(result.totals.otherCosts)}</td>
                  <td className={`py-2 pr-3 text-right font-mono ${result.totals.net >= 0 ? 'text-emerald-500' : 'text-destructive'}`}>{fmt(result.totals.net)}</td>
                  <td className="py-2 pr-3 text-right font-mono">—</td>
                  <td className="py-2 pr-3 text-right font-mono">—</td>
                </tr>
              </tbody>
            </table>
          </CardContent>
        </Card>

        <Separator />

        <Card>
          <CardHeader>
            <CardTitle className="text-base">How to read this</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-muted-foreground">
            <p>
              <strong className="text-foreground">Month 1 always looks great</strong> — no payout tail yet. Don't extrapolate it.
            </p>
            <p>
              <strong className="text-foreground">By month 4–6 the tail compounds</strong> — funded traders from earlier cohorts start requesting payouts. That's your real run-rate.
            </p>
            <p>
              <strong className="text-foreground">Watch Pay/Rev.</strong> If avg crosses 30%, tighten rules. At 45% Breaker Policy v1 auto-tightens. At 60% it freezes payouts.
            </p>
            <p>
              <strong className="text-foreground">CAC is the lever that matters most.</strong> Push it past ~40% of eval price and the model collapses fast — try it.
            </p>
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}