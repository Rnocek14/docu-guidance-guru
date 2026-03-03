import { useState, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { supabase } from '@/integrations/supabase/client';
import { Play, RefreshCw, TrendingUp, TrendingDown, BarChart3 } from 'lucide-react';

interface SweepSummary {
  n: number;
  variant_id: string;
  variant_label: string;
  run_id: string | null;
  profit_mean: number;
  profit_p5: number;
  p_loss: number;
  max_dd: number;
  reserve_breach: number;
  worst_month: number;
  duration_ms: number;
  // Ladder evidence
  avg_clean_payout_count?: number;
  clean_p50?: number;
  clean_p90?: number;
  ever_reached_pro_pct?: number;
  ever_reached_elite_pct?: number;
  cap_binding_rate?: number;
  avg_payout_size?: number;
}

interface SweepResult {
  sweep_id: string;
  sweep_type: string;
  preset: string;
  run_ids: string[];
  summaries: SweepSummary[];
  errors?: { n: number; variant_id: string; error: string }[];
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

export function SweepPanel() {
  const [isRunning, setIsRunning] = useState(false);
  const [result, setResult] = useState<SweepResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);

  // Ramp guard A/B state
  const [isRunningRamp, setIsRunningRamp] = useState(false);
  const [rampResult, setRampResult] = useState<SweepResult | null>(null);
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

  // ── N-Sweep (single variant, varying N) ──
  const runSweep = useCallback(async () => {
    setIsRunning(true);
    setError(null);
    setResult(null);
    setProgress(`Running N-sweep: ${DEFAULT_N_LIST.join(', ')} accounts/mo...`);

    try {
      const headers = await getAuthHeaders();
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

  // ── Ramp Guard A/B (single N, two variants, one sweep call) ──
  const runRampGuard = useCallback(async () => {
    setIsRunningRamp(true);
    setRampError(null);
    setRampResult(null);
    setRampProgress(`Running A/B: N=${RAMP_GUARD_N} — baseline vs $${RAMP_GUARD_CAP} cap...`);

    try {
      const headers = await getAuthHeaders();

      const response = await fetch(sweepUrl, {
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
          // Shared knobs (applied to both variants)
          knobs: {
            targetPayRevSoft: 0.45,
            payRevEngageThreshold: 0.38,
          },
          // Two variants: baseline omits cap fields entirely, guarded sets them
          variants: [
            {
              id: 'baseline',
              label: 'No Cap',
              knobs: {},   // no firstPayoutCap — field omitted, not null
            },
            {
              id: 'guarded',
              label: `$${RAMP_GUARD_CAP} Cap ×${RAMP_GUARD_CAP_COUNT}`,
              knobs: {
                firstPayoutCap: RAMP_GUARD_CAP,
                firstPayoutCapCount: RAMP_GUARD_CAP_COUNT,
              },
            },
          ],
        }),
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Ramp Guard A/B failed');

      setRampResult(data as SweepResult);
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

  // Ramp guard deltas
  const rampBaseline = rampResult?.summaries.find(s => s.variant_id === 'baseline');
  const rampGuarded = rampResult?.summaries.find(s => s.variant_id === 'guarded');
  const rampDeltas = rampBaseline && rampGuarded ? {
    worstMonth: rampGuarded.worst_month - rampBaseline.worst_month,
    pLoss: rampGuarded.p_loss - rampBaseline.p_loss,
    profitMean: rampGuarded.profit_mean - rampBaseline.profit_mean,
  } : null;

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
            <div className="rounded-lg border overflow-x-auto">
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
                    <TableRow key={`${s.n}-${s.variant_id}`} className={s.profit_mean > 0 ? '' : 'bg-destructive/5'}>
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
                  <div key={i}>N={e.n} ({e.variant_id}): {e.error}</div>
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
        {/* RAMP GUARD A/B TEST — single sweep call, two variants */}
        {/* ================================================================ */}
        <div className="border-t pt-4 mt-4">
          <h3 className="text-sm font-semibold mb-1">Ramp Guard A/B — N={RAMP_GUARD_N}</h3>
          <p className="text-xs text-muted-foreground mb-3">
            Single sweep, two variants: no cap vs ${RAMP_GUARD_CAP} cap on first {RAMP_GUARD_CAP_COUNT} payouts.
            Same seed, same pacing, shared sweep_id. Shows how the cap changes tail risk + payout mechanics.
          </p>

          <div className="flex items-center gap-3">
            <Button onClick={runRampGuard} disabled={isRunningRamp} variant="secondary" size="sm">
              {isRunningRamp ? (
                <><RefreshCw className="mr-2 h-3 w-3 animate-spin" />{rampProgress || 'Running...'}</>
              ) : (
                <><Play className="mr-2 h-3 w-3" />Run Ramp Guard A/B</>
              )}
            </Button>
            {rampResult && (
              <Badge variant="outline" className="text-xs">
                Sweep: {rampResult.sweep_id.slice(0, 8)}
              </Badge>
            )}
          </div>

          {rampError && (
            <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive mt-3">
              {rampError}
            </div>
          )}

          {rampResult && rampBaseline && rampGuarded && rampDeltas && (
            <div className="mt-3 space-y-3">
              {/* Delta summary */}
              <div className="rounded-lg border p-3 text-sm space-y-1">
                <div className="font-semibold text-sm mb-2">Impact of ${RAMP_GUARD_CAP} cap (first {RAMP_GUARD_CAP_COUNT} payouts) at N={RAMP_GUARD_N}:</div>
                <div className="grid grid-cols-3 gap-4 text-center">
                  <div>
                    <div className="text-xs text-muted-foreground">Worst Month Δ</div>
                    <div className={`text-lg font-bold ${rampDeltas.worstMonth > 0 ? 'text-success' : 'text-destructive'}`}>
                      {fmtSigned(rampDeltas.worstMonth)}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground">P(Loss) Δ</div>
                    <div className={`text-lg font-bold ${rampDeltas.pLoss < 0 ? 'text-success' : 'text-destructive'}`}>
                      {pctSigned(rampDeltas.pLoss)}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground">Mean Profit Δ</div>
                    <div className={`text-lg font-bold ${rampDeltas.profitMean > 0 ? 'text-success' : 'text-destructive'}`}>
                      {fmtSigned(rampDeltas.profitMean)}
                    </div>
                  </div>
                </div>
              </div>

              {/* Full comparison table with ladder evidence */}
              <div className="rounded-lg border overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[140px]">Scenario</TableHead>
                      <TableHead>Mean Profit</TableHead>
                      <TableHead>Worst Month</TableHead>
                      <TableHead>P(Loss)</TableHead>
                      <TableHead>Max DD</TableHead>
                      <TableHead>Reserve Breach</TableHead>
                      <TableHead>Avg Payout</TableHead>
                      <TableHead>Cap Bind %</TableHead>
                      <TableHead>Clean P50/P90</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {[rampBaseline, rampGuarded].map((s) => (
                      <TableRow key={s.variant_id} className={s.variant_id === 'guarded' ? 'bg-success/5' : ''}>
                        <TableCell className="font-medium">{s.variant_label}</TableCell>
                        <TableCell className={s.profit_mean >= 0 ? 'text-success font-medium' : 'text-destructive font-medium'}>
                          {fmt(s.profit_mean)}
                        </TableCell>
                        <TableCell className={s.worst_month < 0 ? 'text-destructive font-medium' : ''}>
                          {fmt(s.worst_month)}
                        </TableCell>
                        <TableCell className={s.p_loss > 0.1 ? 'text-destructive font-medium' : ''}>
                          {pct(s.p_loss)}
                        </TableCell>
                        <TableCell>{fmt(s.max_dd)}</TableCell>
                        <TableCell className={s.reserve_breach > 0.1 ? 'text-destructive font-medium' : ''}>
                          {pct(s.reserve_breach)}
                        </TableCell>
                        <TableCell>{s.avg_payout_size != null ? fmt(s.avg_payout_size) : '—'}</TableCell>
                        <TableCell>{s.cap_binding_rate != null ? pct(s.cap_binding_rate) : '—'}</TableCell>
                        <TableCell className="font-mono text-xs">
                          {s.clean_p50 != null ? `${s.clean_p50} / ${s.clean_p90 ?? '?'}` : '—'}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              {/* Errors */}
              {rampResult.errors && rampResult.errors.length > 0 && (
                <div className="rounded-lg border border-warning/50 bg-warning/10 p-3 text-sm space-y-1">
                  <strong>Partial failures:</strong>
                  {rampResult.errors.map((e, i) => (
                    <div key={i}>{e.variant_id}: {e.error}</div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}