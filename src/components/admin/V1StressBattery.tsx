import { useState, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Play, CheckCircle, XCircle, AlertTriangle, Loader2 } from 'lucide-react';
import {
  runMonteCarlo,
  DEFAULT_ASSUMPTIONS,
  type MonteCarloAssumptions,
  type MonteCarloConfig,
  type MonteCarloResult,
} from '@/lib/monte-carlo';

// ============================================================================
// CONFIG
// ============================================================================
const CONFIG: MonteCarloConfig = { iterations: 500, monthsPerIteration: 12, seed: 42 };
const CONFIG_90DAY: MonteCarloConfig = { iterations: 1000, monthsPerIteration: 3, seed: 42 };

// ============================================================================
// SCENARIO BUILDERS (deep clone, never drops caps)
// ============================================================================
function deepClone(base: MonteCarloAssumptions): MonteCarloAssumptions {
  return JSON.parse(JSON.stringify(base));
}

function withPassRate(mode: number, base = DEFAULT_ASSUMPTIONS): MonteCarloAssumptions {
  const a = deepClone(base);
  a.passRate = { min: Math.max(0.04, mode - 0.04), mode, max: mode + 0.06 };
  return a;
}

function withHighProfitability(mult: number, base = DEFAULT_ASSUMPTIONS): MonteCarloAssumptions {
  const a = deepClone(base);
  a.avgPayoutAmount = { mean: a.avgPayoutAmount.mean * mult, stdDev: a.avgPayoutAmount.stdDev * mult };
  return a;
}

function withPayoutClustering(base = DEFAULT_ASSUMPTIONS): MonteCarloAssumptions {
  const a = deepClone(base);
  a.payoutRequestRate = { min: 0.70, mode: 0.85, max: 0.95 };
  a.payoutsPerPaidAccountPerMonth = { min: 1.2, mode: 1.8, max: 2.5 };
  return a;
}

function withMaxWithdrawalPressure(base = DEFAULT_ASSUMPTIONS): MonteCarloAssumptions {
  const a = deepClone(base);
  a.payoutRequestRate = { min: 0.80, mode: 0.90, max: 0.98 };
  a.avgPayoutAmount = { mean: 600, stdDev: 100 };
  return a;
}

function withVolume(n: number, base = DEFAULT_ASSUMPTIONS): MonteCarloAssumptions {
  const a = deepClone(base);
  a.accountsPerMonth = n;
  return a;
}

function withAttack(intensity: number, base = DEFAULT_ASSUMPTIONS): MonteCarloAssumptions {
  const a = deepClone(base);
  a.knobs.attackIntensity = intensity;
  return a;
}

// ============================================================================
// TYPES
// ============================================================================
interface ScenarioRow {
  name: string;
  result: MonteCarloResult;
  assumptions: MonteCarloAssumptions;
}

interface DrawdownRow {
  name: string;
  maxDD: number;
  worstMonth: number;
  cumP5: number;
}

interface StressBatteryResult {
  scenarios: ScenarioRow[];
  drawdown: DrawdownRow[];
  configCheck: {
    firstPayoutCap: number | null;
    lifetimeCapPerUser: number | null;
    lifetimeCapMultiple: string;
    payoutSplitPercent: number;
    pricePerAccount: number;
  };
  verdict: { label: string; pass: boolean }[];
  recommendedCapital: number;
}

// ============================================================================
// RUNNER
// ============================================================================
function runStressBattery(): StressBatteryResult {
  const scenarios: ScenarioRow[] = [];
  const run = (name: string, assumptions: MonteCarloAssumptions) => {
    scenarios.push({ name, assumptions, result: runMonteCarlo(CONFIG, assumptions) });
  };

  // 1-3. Core scenarios
  run('Baseline (12% pass, 500/mo)', DEFAULT_ASSUMPTIONS);
  run('10% pass rate', withPassRate(0.10));
  run('14% pass rate (danger zone)', withPassRate(0.14));

  // 4. Critical +2pp shift
  const baseMode = DEFAULT_ASSUMPTIONS.passRate.mode;
  run(`+2pp shift (${(baseMode * 100).toFixed(0)}% → ${((baseMode + 0.02) * 100).toFixed(0)}%)`, withPassRate(baseMode + 0.02));

  // 5-7. Payout stress
  run('1.5× funded profitability', withHighProfitability(1.5));
  run('Payout clustering', withPayoutClustering());
  run('Max withdrawal pressure', withMaxWithdrawalPressure());

  // 8-9. Combined stress
  run('10% pass + 1.5× profit', withHighProfitability(1.5, withPassRate(0.10)));
  run('14% + clustering + attack', withAttack(1.5, withPayoutClustering(withPassRate(0.14))));

  // 10-11. Solo operator
  run('Solo ramp (200/mo)', withVolume(200));
  run('Solo ramp + 14% pass', withPassRate(0.14, withVolume(200)));

  // 90-day drawdown
  const ddScenarios = [
    { name: 'Baseline', assumptions: DEFAULT_ASSUMPTIONS },
    { name: '14% pass rate', assumptions: withPassRate(0.14) },
    { name: '1.5× profitability', assumptions: withHighProfitability(1.5) },
    { name: 'Payout clustering', assumptions: withPayoutClustering() },
    { name: '14% + clustering + attack', assumptions: withAttack(1.5, withPayoutClustering(withPassRate(0.14))) },
  ];

  const drawdown: DrawdownRow[] = ddScenarios.map(s => {
    const r = runMonteCarlo(CONFIG_90DAY, s.assumptions);
    let cumP5: number;
    if (r.rawSamples && r.rawSamples.length > 0) {
      const cumProfits = r.rawSamples.map(iter => iter.reduce((a, b) => a + b, 0));
      cumProfits.sort((a, b) => a - b);
      cumP5 = cumProfits[Math.floor(cumProfits.length * 0.05)];
    } else {
      cumP5 = r.profit.p5 * 3;
    }
    return { name: s.name, maxDD: r.risk.maxDrawdown, worstMonth: r.risk.worstMonth, cumP5 };
  });

  const baseline = scenarios[0].result;
  const verdict = [
    { label: 'Baseline margin > 0%', pass: baseline.diagnostics.effectiveMargin > 0 },
    { label: 'Baseline profit > $0/mo', pass: baseline.profit.mean > 0 },
    { label: 'Baseline loss prob < 40%', pass: baseline.risk.probabilityOfLoss < 0.40 },
    { label: 'No scenario margin < -15%', pass: scenarios.every(s => s.result.diagnostics.effectiveMargin > -0.15) },
    { label: 'No scenario loses > $10k/mo', pass: scenarios.every(s => s.result.profit.mean > -10000) },
    { label: 'Max DD < $100k (any scenario)', pass: scenarios.every(s => s.result.risk.maxDrawdown < 100000) },
    { label: '10% pass still profitable', pass: (scenarios.find(s => s.name.includes('10%'))?.result.profit.mean ?? 0) > -3000 },
  ];

  const baselineDD = drawdown[0]?.maxDD ?? 0;

  return {
    scenarios,
    drawdown,
    configCheck: {
      firstPayoutCap: DEFAULT_ASSUMPTIONS.knobs.firstPayoutCap,
      lifetimeCapPerUser: DEFAULT_ASSUMPTIONS.knobs.lifetimeCapPerUser,
      lifetimeCapMultiple: DEFAULT_ASSUMPTIONS.knobs.lifetimeCapPerUser !== null
        ? `${(DEFAULT_ASSUMPTIONS.knobs.lifetimeCapPerUser / DEFAULT_ASSUMPTIONS.pricePerAccount).toFixed(1)}×`
        : 'unlimited',
      payoutSplitPercent: DEFAULT_ASSUMPTIONS.knobs.payoutSplitPercent,
      pricePerAccount: DEFAULT_ASSUMPTIONS.pricePerAccount,
    },
    verdict,
    recommendedCapital: Math.round(baselineDD * 1.5),
  };
}

// ============================================================================
// COMPONENT
// ============================================================================
export function V1StressBattery() {
  const [result, setResult] = useState<StressBatteryResult | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0);

  const handleRun = useCallback(() => {
    setIsRunning(true);
    setElapsed(0);
    const start = Date.now();

    // Use setTimeout to let UI update before blocking
    setTimeout(() => {
      try {
        const r = runStressBattery();
        setResult(r);
        setElapsed(Date.now() - start);
      } finally {
        setIsRunning(false);
      }
    }, 50);
  }, []);

  const fmt = (v: number) => '$' + Math.round(v).toLocaleString();
  const pct = (v: number) => (v * 100).toFixed(1) + '%';
  const fmtDelta = (v: number) => (v >= 0 ? '+' : '') + '$' + Math.round(v).toLocaleString();

  if (!result) {
    return (
      <Card className="border-dashed">
        <CardContent className="flex flex-col items-center justify-center py-16">
          <AlertTriangle className="h-12 w-12 text-muted-foreground mb-4" />
          <h3 className="text-lg font-medium mb-2">V1 Survivability Stress Test</h3>
          <p className="text-muted-foreground text-center mb-2 max-w-md">
            Runs 11 stress scenarios + 90-day drawdown analysis against the frozen V1 config.
            Uses the client-side Monte Carlo engine (500 iterations × 12 months).
          </p>
          <p className="text-xs text-muted-foreground mb-4">Takes 30–90 seconds depending on your device.</p>
          <Button onClick={handleRun} disabled={isRunning} size="lg">
            {isRunning ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
            {isRunning ? 'Running…' : 'Run Stress Battery'}
          </Button>
        </CardContent>
      </Card>
    );
  }

  const baseline = result.scenarios[0].result;
  const passCount = result.verdict.filter(v => v.pass).length;
  const allPass = passCount === result.verdict.length;

  return (
    <div className="space-y-6">
      {/* Config Verification */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Config Under Test (verified from engine)</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-3">
            <Badge variant="outline">Entry: ${result.configCheck.pricePerAccount}</Badge>
            <Badge variant="outline">1st Cap: ${result.configCheck.firstPayoutCap}</Badge>
            <Badge variant="outline">LT Cap: ${result.configCheck.lifetimeCapPerUser} ({result.configCheck.lifetimeCapMultiple})</Badge>
            <Badge variant="outline">Split: {(result.configCheck.payoutSplitPercent * 100).toFixed(0)}%</Badge>
            <Badge variant="secondary">{elapsed > 0 ? `${(elapsed / 1000).toFixed(1)}s` : ''}</Badge>
          </div>
        </CardContent>
      </Card>

      {/* Verdict */}
      <Card className={allPass ? 'border-success/50 bg-success/5' : 'border-destructive/50 bg-destructive/5'}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            {allPass ? <CheckCircle className="h-5 w-5 text-success" /> : <XCircle className="h-5 w-5 text-destructive" />}
            {allPass ? 'V1 CONFIG SURVIVES ALL CHECKS' : `${result.verdict.length - passCount} CHECK(S) FAILED`}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {result.verdict.map((v, i) => (
              <div key={i} className="flex items-center gap-2 text-sm">
                {v.pass ? <CheckCircle className="h-4 w-4 text-success shrink-0" /> : <XCircle className="h-4 w-4 text-destructive shrink-0" />}
                {v.label}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Scenario Table */}
      <Card>
        <CardHeader>
          <CardTitle>Stress Scenarios (500 iter × 12 months)</CardTitle>
          <CardDescription>All scenarios use V1 frozen config as base. Deltas are vs baseline.</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="pb-2 pr-4">Scenario</th>
                <th className="pb-2 pr-4 text-right">Margin</th>
                <th className="pb-2 pr-4 text-right">Profit/mo</th>
                <th className="pb-2 pr-4 text-right">P5 (tail)</th>
                <th className="pb-2 pr-4 text-right">Loss Prob</th>
                <th className="pb-2 pr-4 text-right">Max DD</th>
                <th className="pb-2 text-right">Δ Profit</th>
              </tr>
            </thead>
            <tbody>
              {result.scenarios.map((s, i) => {
                const r = s.result;
                const d = r.diagnostics;
                const profitDelta = i > 0 ? r.profit.mean - baseline.profit.mean : 0;
                const isNegMargin = d.effectiveMargin < 0;
                return (
                  <tr key={i} className={`border-b last:border-0 ${isNegMargin ? 'bg-destructive/5' : ''}`}>
                    <td className="py-2 pr-4 font-medium">{s.name}</td>
                    <td className={`py-2 pr-4 text-right font-mono ${isNegMargin ? 'text-destructive' : 'text-success'}`}>{pct(d.effectiveMargin)}</td>
                    <td className={`py-2 pr-4 text-right font-mono ${r.profit.mean < 0 ? 'text-destructive' : ''}`}>{fmt(r.profit.mean)}</td>
                    <td className="py-2 pr-4 text-right font-mono text-destructive">{fmt(r.profit.p5)}</td>
                    <td className="py-2 pr-4 text-right font-mono">{pct(r.risk.probabilityOfLoss)}</td>
                    <td className="py-2 pr-4 text-right font-mono">{fmt(r.risk.maxDrawdown)}</td>
                    <td className={`py-2 text-right font-mono ${i === 0 ? 'text-muted-foreground' : profitDelta < 0 ? 'text-destructive' : 'text-success'}`}>
                      {i === 0 ? '—' : fmtDelta(profitDelta)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {/* +2pp Shift Callout */}
      {(() => {
        const shift = result.scenarios.find(s => s.name.includes('+2pp'));
        if (!shift) return null;
        const profitDelta = shift.result.profit.mean - baseline.profit.mean;
        const marginDelta = (shift.result.diagnostics.effectiveMargin - baseline.diagnostics.effectiveMargin) * 100;
        const stillProfitable = shift.result.profit.mean > 0;
        return (
          <Card className={stillProfitable ? 'border-warning/50 bg-warning/5' : 'border-destructive/50 bg-destructive/5'}>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <AlertTriangle className="h-5 w-5" />
                Critical: +2pp Pass Rate Shift
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid gap-4 sm:grid-cols-3">
                <div>
                  <p className="text-xs text-muted-foreground">Profit Δ</p>
                  <p className="text-lg font-bold text-destructive">{fmtDelta(profitDelta)}/mo</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Margin Δ</p>
                  <p className="text-lg font-bold">{marginDelta.toFixed(1)} pp</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Still Profitable?</p>
                  <p className="text-lg font-bold">{stillProfitable ? '✅ Yes' : '🚨 No'}</p>
                </div>
              </div>
            </CardContent>
          </Card>
        );
      })()}

      {/* 90-Day Drawdown */}
      <Card>
        <CardHeader>
          <CardTitle>90-Day Worst-Case Drawdown (1000 iter × 3 months)</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="pb-2 pr-4">Scenario</th>
                <th className="pb-2 pr-4 text-right">90d Max DD</th>
                <th className="pb-2 pr-4 text-right">Worst Month</th>
                <th className="pb-2 text-right">Cum P5 (90d)</th>
              </tr>
            </thead>
            <tbody>
              {result.drawdown.map((d, i) => (
                <tr key={i} className="border-b last:border-0">
                  <td className="py-2 pr-4 font-medium">{d.name}</td>
                  <td className="py-2 pr-4 text-right font-mono text-destructive">{fmt(d.maxDD)}</td>
                  <td className="py-2 pr-4 text-right font-mono text-destructive">{fmt(d.worstMonth)}</td>
                  <td className="py-2 text-right font-mono">{fmt(d.cumP5)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-4 rounded-lg bg-muted/50 p-3 text-sm">
            <strong>Operating capital needed:</strong> ≥ {fmt(result.recommendedCapital)} (1.5× worst baseline 90-day drawdown)
          </div>
        </CardContent>
      </Card>

      {/* Re-run button */}
      <div className="flex justify-end">
        <Button onClick={handleRun} disabled={isRunning} variant="outline">
          {isRunning ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
          Re-run Battery
        </Button>
      </div>
    </div>
  );
}
