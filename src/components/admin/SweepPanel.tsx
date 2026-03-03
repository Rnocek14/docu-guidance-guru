import { useState, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { supabase } from '@/integrations/supabase/client';
import { Play, RefreshCw, TrendingUp, TrendingDown, BarChart3 } from 'lucide-react';

interface SweepSummary {
  n: number;
  run_id: string | null;
  profit_mean: number;
  profit_p5: number;
  p_loss: number;
  max_dd: number;
  reserve_breach: number;
  worst_month: number;
  duration_ms: number;
}

interface SweepResult {
  sweep_id: string;
  sweep_type: string;
  preset: string;
  run_ids: string[];
  summaries: SweepSummary[];
  errors?: { n: number; error: string }[];
  config: {
    seed: number;
    months: number;
    iterations: number;
    reserve_threshold: number;
    accountsPerMonthList: number[];
  };
}

const DEFAULT_N_LIST = [100, 150, 200, 300, 500];

// Ramp guard A/B: N=200, no cap vs $300 cap (first 3 payouts)
const RAMP_GUARD_CAP = 300;
const RAMP_GUARD_CAP_COUNT = 3;
const RAMP_GUARD_N = 200;

interface RampGuardResult {
  baseline: SweepSummary;
  guarded: SweepSummary;
  worstMonthDelta: number;
  pLossDelta: number;
  profitMeanDelta: number;
}

export function SweepPanel() {
  const [isRunning, setIsRunning] = useState(false);
  const [result, setResult] = useState<SweepResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);

  // Ramp guard A/B state
  const [isRunningRamp, setIsRunningRamp] = useState(false);
  const [rampResult, setRampResult] = useState<RampGuardResult | null>(null);
  const [rampError, setRampError] = useState<string | null>(null);
  const [rampProgress, setRampProgress] = useState<string | null>(null);

  const getAuthHeaders = useCallback(async () => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) throw new Error('Not authenticated');
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${session.access_token}`,
    };
  }, []);

  const sweepUrl = `https://${import.meta.env.VITE_SUPABASE_PROJECT_ID}.supabase.co/functions/v1/run-sweep`;

  const runSweep = useCallback(async () => {
    setIsRunning(true);
    setError(null);
    setResult(null);
    setProgress('Authenticating...');

    try {
      const headers = await getAuthHeaders();
      setProgress(`Running N-sweep: ${DEFAULT_N_LIST.join(', ')} accounts/mo...`);

      const response = await fetch(sweepUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          preset: 'baseline',
          seed: 42,
          months: 12,
          iterations: 2000,
          reserve_threshold: 16000,
          accountsPerMonthList: DEFAULT_N_LIST,
          sweep_type: 'N_SWEEP',
          knobs: {
            targetPayRevSoft: 0.45,
            payRevEngageThreshold: 0.38,
          },
        }),
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Sweep failed');

      setResult(data as SweepResult);
      setProgress(null);
    } catch (err) {
      setError((err as Error).message);
      setProgress(null);
    } finally {
      setIsRunning(false);
    }
  }, [getAuthHeaders, sweepUrl]);

  const runRampGuard = useCallback(async () => {
    setIsRunningRamp(true);
    setRampError(null);
    setRampResult(null);
    setRampProgress('Running A/B: N=200 without cap...');

    try {
      const headers = await getAuthHeaders();

      // A: Baseline (no first payout cap)
      const baselineResp = await fetch(sweepUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          preset: 'baseline',
          seed: 42,
          months: 12,
          iterations: 2000,
          reserve_threshold: 16000,
          accountsPerMonthList: [RAMP_GUARD_N],
          sweep_type: 'RAMP_GUARD_AB',
          knobs: {
            targetPayRevSoft: 0.45,
            payRevEngageThreshold: 0.38,
            firstPayoutCap: null,
          },
        }),
      });
      const baselineData = await baselineResp.json();
      if (!baselineResp.ok) throw new Error(baselineData.error || 'Baseline run failed');

      setRampProgress('Running A/B: N=200 with $300 cap (first 3 payouts)...');

      // B: Guarded ($300 cap on first 3 payouts)
      const guardedResp = await fetch(sweepUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          preset: 'baseline',
          seed: 42,
          months: 12,
          iterations: 2000,
          reserve_threshold: 16000,
          accountsPerMonthList: [RAMP_GUARD_N],
          sweep_type: 'RAMP_GUARD_AB',
          knobs: {
            targetPayRevSoft: 0.45,
            payRevEngageThreshold: 0.38,
            firstPayoutCap: RAMP_GUARD_CAP,
            firstPayoutCapCount: RAMP_GUARD_CAP_COUNT,
          },
        }),
      });
      const guardedData = await guardedResp.json();
      if (!guardedResp.ok) throw new Error(guardedData.error || 'Guarded run failed');

      const baseline = (baselineData as SweepResult).summaries[0];
      const guarded = (guardedData as SweepResult).summaries[0];

      setRampResult({
        baseline,
        guarded,
        worstMonthDelta: guarded.worst_month - baseline.worst_month,
        pLossDelta: guarded.p_loss - baseline.p_loss,
        profitMeanDelta: guarded.profit_mean - baseline.profit_mean,
      });
      setRampProgress(null);
    } catch (err) {
      setRampError((err as Error).message);
      setRampProgress(null);
    } finally {
      setIsRunningRamp(false);
    }
  }, [getAuthHeaders, sweepUrl]);

  const fmt = (v: number) => '$' + v.toLocaleString(undefined, { maximumFractionDigits: 0 });
  const fmtSigned = (v: number) => (v >= 0 ? '+' : '') + fmt(v);
  const pct = (v: number) => (v * 100).toFixed(1) + '%';
  const pctSigned = (v: number) => (v >= 0 ? '+' : '') + pct(v);

  // Find breakeven N
  const breakEvenN = result?.summaries.find(s => s.profit_mean > 0)?.n ?? null;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <BarChart3 className="h-5 w-5 text-muted-foreground" />
          <CardTitle className="text-lg">MES Breakeven Sweep</CardTitle>
        </div>
        <CardDescription>
          Run controlled N-sweep ({DEFAULT_N_LIST.join(', ')} accounts/mo) to find Minimum Efficient Scale.
          Same seed, same knobs — only accountsPerMonth changes.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-3">
          <Button onClick={runSweep} disabled={isRunning} size="lg">
            {isRunning ? (
              <><RefreshCw className="mr-2 h-4 w-4 animate-spin" />{progress || 'Running...'}</>
            ) : (
              <><Play className="mr-2 h-4 w-4" />Run N-Sweep (5 points)</>
            )}
          </Button>
          {result && (
            <Badge variant="outline" className="text-xs">
              Sweep: {result.sweep_id.slice(0, 8)}
            </Badge>
          )}
        </div>

        {error && (
          <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </div>
        )}

        {result && (
          <>
            {/* Breakeven indicator */}
            {breakEvenN && (
              <div className="rounded-lg border border-success/50 bg-success/10 p-3 text-sm">
                <strong>MES Estimate:</strong> Breakeven at <strong>N ≈ {breakEvenN}</strong> accounts/month
                (first N where mean monthly profit turns positive).
              </div>
            )}
            {!breakEvenN && result.summaries.length > 0 && (
              <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm">
                <strong>Warning:</strong> No sweep point reached positive mean profit.
                MES may be above {DEFAULT_N_LIST[DEFAULT_N_LIST.length - 1]} accounts/month.
              </div>
            )}

            {/* MES Curve Table */}
            <div className="rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[80px]">N</TableHead>
                    <TableHead>Mean Profit</TableHead>
                    <TableHead>Worst Month</TableHead>
                    <TableHead>P5 (Worst)</TableHead>
                    <TableHead>P(Loss)</TableHead>
                    <TableHead>Max DD</TableHead>
                    <TableHead>Reserve Breach</TableHead>
                    <TableHead className="w-[80px]">Run ID</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {result.summaries.map((s) => (
                    <TableRow key={s.n} className={s.profit_mean > 0 ? '' : 'bg-destructive/5'}>
                      <TableCell className="font-medium">{s.n}</TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1">
                          {s.profit_mean >= 0 ? (
                            <TrendingUp className="h-3 w-3 text-success" />
                          ) : (
                            <TrendingDown className="h-3 w-3 text-destructive" />
                          )}
                          <span className={s.profit_mean >= 0 ? 'text-success font-medium' : 'text-destructive font-medium'}>
                            {fmt(s.profit_mean)}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className={s.worst_month < 0 ? 'text-destructive font-medium' : ''}>
                        {fmt(s.worst_month)}
                      </TableCell>
                      <TableCell className={s.profit_p5 < 0 ? 'text-destructive' : ''}>
                        {fmt(s.profit_p5)}
                      </TableCell>
                      <TableCell className={s.p_loss > 0.1 ? 'text-destructive font-medium' : ''}>
                        {pct(s.p_loss)}
                      </TableCell>
                      <TableCell>{fmt(s.max_dd)}</TableCell>
                      <TableCell className={s.reserve_breach > 0.1 ? 'text-destructive font-medium' : ''}>
                        {pct(s.reserve_breach)}
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {s.run_id?.slice(0, 8) ?? '—'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            {/* Errors */}
            {result.errors && result.errors.length > 0 && (
              <div className="rounded-lg border border-warning/50 bg-warning/10 p-3 text-sm space-y-1">
                <strong>Partial failures:</strong>
                {result.errors.map((e, i) => (
                  <div key={i}>N={e.n}: {e.error}</div>
                ))}
              </div>
            )}

            {/* Config summary */}
            <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
              <Badge variant="outline">Seed: {result.config.seed}</Badge>
              <Badge variant="outline">Months: {result.config.months}</Badge>
              <Badge variant="outline">Iterations: {result.config.iterations}</Badge>
              <Badge variant="outline">Reserve: ${result.config.reserve_threshold.toLocaleString()}</Badge>
              <Badge variant="outline">Pacing: 0.45 / 0.38</Badge>
            </div>
          </>
        )}

        {/* ================================================================ */}
        {/* RAMP GUARD A/B TEST */}
        {/* ================================================================ */}
        <div className="border-t pt-4 mt-4">
          <h3 className="text-sm font-semibold mb-1">Ramp Guard A/B — N={RAMP_GUARD_N}</h3>
          <p className="text-xs text-muted-foreground mb-3">
            Compares N={RAMP_GUARD_N} with no cap vs ${RAMP_GUARD_CAP} cap on first {RAMP_GUARD_CAP_COUNT} payouts.
            Same seed, same pacing. Shows how much the cap reduces early variance.
          </p>

          <div className="flex items-center gap-3">
            <Button onClick={runRampGuard} disabled={isRunningRamp} variant="secondary" size="sm">
              {isRunningRamp ? (
                <><RefreshCw className="mr-2 h-3 w-3 animate-spin" />{rampProgress || 'Running...'}</>
              ) : (
                <><Play className="mr-2 h-3 w-3" />Run Ramp Guard A/B</>
              )}
            </Button>
          </div>

          {rampError && (
            <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive mt-3">
              {rampError}
            </div>
          )}

          {rampResult && (
            <div className="mt-3 space-y-3">
              {/* Delta summary */}
              <div className="rounded-lg border p-3 text-sm space-y-1">
                <div className="font-semibold text-sm mb-2">Impact of ${RAMP_GUARD_CAP} cap (first {RAMP_GUARD_CAP_COUNT} payouts) at N={RAMP_GUARD_N}:</div>
                <div className="grid grid-cols-3 gap-4 text-center">
                  <div>
                    <div className="text-xs text-muted-foreground">Worst Month Δ</div>
                    <div className={`text-lg font-bold ${rampResult.worstMonthDelta > 0 ? 'text-success' : 'text-destructive'}`}>
                      {fmtSigned(rampResult.worstMonthDelta)}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground">P(Loss) Δ</div>
                    <div className={`text-lg font-bold ${rampResult.pLossDelta < 0 ? 'text-success' : 'text-destructive'}`}>
                      {pctSigned(rampResult.pLossDelta)}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground">Mean Profit Δ</div>
                    <div className={`text-lg font-bold ${rampResult.profitMeanDelta > 0 ? 'text-success' : 'text-destructive'}`}>
                      {fmtSigned(rampResult.profitMeanDelta)}
                    </div>
                  </div>
                </div>
              </div>

              {/* Comparison table */}
              <div className="rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[120px]">Scenario</TableHead>
                      <TableHead>Mean Profit</TableHead>
                      <TableHead>Worst Month</TableHead>
                      <TableHead>P(Loss)</TableHead>
                      <TableHead>Max DD</TableHead>
                      <TableHead>Reserve Breach</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    <TableRow>
                      <TableCell className="font-medium">No Cap</TableCell>
                      <TableCell className={rampResult.baseline.profit_mean >= 0 ? 'text-success' : 'text-destructive'}>
                        {fmt(rampResult.baseline.profit_mean)}
                      </TableCell>
                      <TableCell className={rampResult.baseline.worst_month < 0 ? 'text-destructive' : ''}>
                        {fmt(rampResult.baseline.worst_month)}
                      </TableCell>
                      <TableCell>{pct(rampResult.baseline.p_loss)}</TableCell>
                      <TableCell>{fmt(rampResult.baseline.max_dd)}</TableCell>
                      <TableCell>{pct(rampResult.baseline.reserve_breach)}</TableCell>
                    </TableRow>
                    <TableRow className="bg-success/5">
                      <TableCell className="font-medium">${RAMP_GUARD_CAP} Cap ×{RAMP_GUARD_CAP_COUNT}</TableCell>
                      <TableCell className={rampResult.guarded.profit_mean >= 0 ? 'text-success' : 'text-destructive'}>
                        {fmt(rampResult.guarded.profit_mean)}
                      </TableCell>
                      <TableCell className={rampResult.guarded.worst_month < 0 ? 'text-destructive' : ''}>
                        {fmt(rampResult.guarded.worst_month)}
                      </TableCell>
                      <TableCell>{pct(rampResult.guarded.p_loss)}</TableCell>
                      <TableCell>{fmt(rampResult.guarded.max_dd)}</TableCell>
                      <TableCell>{pct(rampResult.guarded.reserve_breach)}</TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              </div>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
