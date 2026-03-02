/**
 * Structural Risk Map — Pass Rate × Request Rate grid
 * Shows loss probability, margin, and breaker dependency per cell.
 * Turns anxiety into geometry.
 * 
 * v2: Extended axes into danger zone (pass 5–15%, request 20–60%)
 *     + clustering toggle to surface the real insolvency frontier.
 */

import { useState, useCallback, useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Play, Loader2, Grid3X3, AlertTriangle } from 'lucide-react';
import {
  runMonteCarlo,
  DEFAULT_ASSUMPTIONS,
  type MonteCarloAssumptions,
  type MonteCarloConfig,
} from '@/lib/monte-carlo';
import { PAY_REV_GUARDRAIL_V1 } from '@/lib/breaker-policy';

// ============================================================================
// CONFIG
// ============================================================================

// Extended axes: push into danger zone to find the real frontier
const PASS_RATES = [0.05, 0.07, 0.09, 0.10, 0.12, 0.15];
const REQUEST_RATES = [0.20, 0.25, 0.30, 0.35, 0.45, 0.60];

const CONFIG: MonteCarloConfig = { iterations: 250, monthsPerIteration: 12, seed: 42 };
const CONFIG_WITH_BREAKER: MonteCarloConfig = { ...CONFIG, breakerPolicy: PAY_REV_GUARDRAIL_V1 };

// ============================================================================
// TYPES
// ============================================================================

interface GridCell {
  passRate: number;
  requestRate: number;
  // Without breakers
  margin: number;
  lossProb: number;
  profitMean: number;
  maxDD: number;
  payRevRatio: number;
  // With breakers
  breakerMargin: number;
  breakerLossProb: number;
  breakerProfitMean: number;
  breakerL1Pct: number;
  breakerL2Pct: number;
}

interface RiskMapResult {
  grid: GridCell[];
  elapsed: number;
  clustering: boolean;
}

// ============================================================================
// HELPERS
// ============================================================================

function deepClone(base: MonteCarloAssumptions): MonteCarloAssumptions {
  return JSON.parse(JSON.stringify(base));
}

function buildAssumptions(
  passMode: number,
  requestMode: number,
  clustering: boolean,
): MonteCarloAssumptions {
  const a = deepClone(DEFAULT_ASSUMPTIONS);
  a.passRate = { min: Math.max(0.02, passMode - 0.02), mode: passMode, max: passMode + 0.03 };
  a.payoutRequestRate = {
    min: Math.max(0.05, requestMode - 0.05),
    mode: requestMode,
    max: Math.min(0.95, requestMode + 0.10),
  };
  if (clustering) {
    // Overlay clustering: higher payout frequency + larger payouts (correlated timing)
    a.payoutsPerPaidAccountPerMonth = { min: 0.8, mode: 1.4, max: 2.0 };
    a.avgPayoutAmount = {
      mean: a.avgPayoutAmount.mean * 1.15,
      stdDev: a.avgPayoutAmount.stdDev * 1.15,
    };
  }
  return a;
}

function runGrid(clustering: boolean): RiskMapResult {
  const start = Date.now();
  const grid: GridCell[] = [];

  for (const pr of PASS_RATES) {
    for (const rr of REQUEST_RATES) {
      const assumptions = buildAssumptions(pr, rr, clustering);
      const rNo = runMonteCarlo(CONFIG, assumptions);
      const rWith = runMonteCarlo(CONFIG_WITH_BREAKER, assumptions);

      grid.push({
        passRate: pr,
        requestRate: rr,
        margin: rNo.diagnostics.effectiveMargin,
        lossProb: rNo.risk.probabilityOfLoss,
        profitMean: rNo.profit.mean,
        maxDD: rNo.risk.maxDrawdown,
        payRevRatio: rNo.diagnostics.payoutToRevenueRatio,
        breakerMargin: rWith.diagnostics.effectiveMargin,
        breakerLossProb: rWith.risk.probabilityOfLoss,
        breakerProfitMean: rWith.profit.mean,
        breakerL1Pct: rWith.breakerDiagnostics?.timeInL1Pct ?? 0,
        breakerL2Pct: rWith.breakerDiagnostics?.timeInL2Pct ?? 0,
      });
    }
  }

  return { grid, elapsed: Date.now() - start, clustering };
}

// ============================================================================
// COLOR LOGIC
// ============================================================================

function lossColor(lossProb: number): string {
  if (lossProb <= 0) return 'bg-success/20';
  if (lossProb < 0.05) return 'bg-success/10';
  if (lossProb < 0.15) return 'bg-warning/20';
  if (lossProb < 0.30) return 'bg-destructive/20';
  return 'bg-destructive/30';
}

function lossFg(lossProb: number): string {
  if (lossProb < 0.05) return 'text-success';
  if (lossProb < 0.15) return 'text-warning';
  if (lossProb < 0.30) return 'text-destructive';
  return 'text-destructive font-bold';
}

function marginColor(margin: number): string {
  if (margin >= 0.30) return 'text-success font-bold';
  if (margin >= 0.10) return 'text-success';
  if (margin >= 0) return 'text-warning';
  return 'text-destructive font-bold';
}

// ============================================================================
// COMPONENT
// ============================================================================

type ViewMode = 'no-breaker' | 'with-breaker';

export function StructuralRiskMap() {
  const [result, setResult] = useState<RiskMapResult | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>('no-breaker');
  const [clustering, setClustering] = useState(false);

  const handleRun = useCallback(() => {
    setIsRunning(true);
    setTimeout(() => {
      try {
        setResult(runGrid(clustering));
      } finally {
        setIsRunning(false);
      }
    }, 50);
  }, [clustering]);

  const fmt = (v: number) => '$' + Math.round(v).toLocaleString();
  const pct = (v: number) => (v * 100).toFixed(1) + '%';

  const totalSims = PASS_RATES.length * REQUEST_RATES.length * 2;

  // Summary stats
  const summary = useMemo(() => {
    if (!result) return null;
    const noBreaker = result.grid;
    const greenNo = noBreaker.filter(c => c.lossProb < 0.05).length;
    const yellowNo = noBreaker.filter(c => c.lossProb >= 0.05 && c.lossProb < 0.15).length;
    const redNo = noBreaker.filter(c => c.lossProb >= 0.15).length;
    const rescued = noBreaker.filter(c => c.lossProb >= 0.15 && c.breakerLossProb < 0.15).length;
    const breakerDependent = noBreaker.filter(c => c.lossProb >= 0.05 && c.breakerLossProb < 0.05).length;
    const highL2 = noBreaker.filter(c => c.breakerL2Pct > 0.10).length;

    // Find insolvency frontier (lowest pass rate with a red cell)
    const redPasses = [...new Set(noBreaker.filter(c => c.lossProb >= 0.15).map(c => c.passRate))].sort((a, b) => a - b);
    const yellowPasses = [...new Set(noBreaker.filter(c => c.lossProb >= 0.05).map(c => c.passRate))].sort((a, b) => a - b);

    return {
      greenNo, yellowNo, redNo, rescued, breakerDependent, highL2,
      insolvencyStart: redPasses[0] ?? null,
      cautionStart: yellowPasses[0] ?? null,
    };
  }, [result]);

  // Find current config position
  const currentPass = DEFAULT_ASSUMPTIONS.passRate.mode;
  const currentRequest = DEFAULT_ASSUMPTIONS.payoutRequestRate.mode;

  if (!result) {
    return (
      <Card className="border-dashed">
        <CardContent className="flex flex-col items-center justify-center py-16">
          <Grid3X3 className="h-12 w-12 text-muted-foreground mb-4" />
          <h3 className="text-lg font-medium mb-2">Structural Risk Map</h3>
          <p className="text-muted-foreground text-center mb-2 max-w-md">
            Extended grid: pass rate {pct(PASS_RATES[0])}–{pct(PASS_RATES[PASS_RATES.length - 1])},
            request rate {pct(REQUEST_RATES[0])}–{pct(REQUEST_RATES[REQUEST_RATES.length - 1])}.
            Each cell runs with and without breakers.
          </p>

          {/* Clustering toggle */}
          <div className="flex items-center gap-3 mb-4">
            <Button
              variant={clustering ? 'outline' : 'default'}
              size="sm"
              onClick={() => setClustering(false)}
            >
              Normal Timing
            </Button>
            <Button
              variant={clustering ? 'default' : 'outline'}
              size="sm"
              onClick={() => setClustering(true)}
            >
              <AlertTriangle className="mr-1 h-3 w-3" />
              Payout Clustering
            </Button>
          </div>

          <p className="text-xs text-muted-foreground mb-4">
            {totalSims} simulations × {CONFIG.iterations} iterations.
            {clustering ? ' Clustering ON: correlated payout timing overlay.' : ''}
            {' '}~60–180s.
          </p>
          <Button onClick={handleRun} disabled={isRunning} size="lg">
            {isRunning ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
            {isRunning ? 'Computing Grid…' : 'Build Risk Map'}
          </Button>
        </CardContent>
      </Card>
    );
  }

  const showBreakers = viewMode === 'with-breaker';

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Grid3X3 className="h-5 w-5" />
            Structural Risk Map
            {result.clustering && (
              <Badge variant="destructive" className="gap-1">
                <AlertTriangle className="h-3 w-3" />
                Clustering ON
              </Badge>
            )}
          </CardTitle>
          <CardDescription>
            Each cell: {showBreakers ? 'WITH breakers' : 'NO breakers'}.
            Loss probability (color) · margin · profit/mo.
            Your config is <span className="font-medium text-primary">ringed</span>.
            {result.clustering && ' Payout clustering overlay active — this is where tails appear.'}
          </CardDescription>
          <div className="flex flex-wrap gap-2 pt-2">
            <Button
              variant={viewMode === 'no-breaker' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setViewMode('no-breaker')}
            >
              No Breakers
            </Button>
            <Button
              variant={viewMode === 'with-breaker' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setViewMode('with-breaker')}
            >
              With Breakers
            </Button>
            <Badge variant="secondary" className="ml-auto">
              {(result.elapsed / 1000).toFixed(1)}s · {PASS_RATES.length}×{REQUEST_RATES.length} · {CONFIG.iterations} iter
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr>
                <th className="pb-2 pr-2 text-left text-xs text-muted-foreground">
                  Pass ↓ / Req →
                </th>
                {REQUEST_RATES.map(rr => (
                  <th key={rr} className={`pb-2 px-1 text-center text-xs ${
                    Math.abs(rr - currentRequest) < 0.005 ? 'text-primary font-bold' : 'text-muted-foreground'
                  }`}>
                    {pct(rr)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {PASS_RATES.map(pr => (
                <tr key={pr}>
                  <td className={`py-1 pr-2 text-xs font-medium whitespace-nowrap ${
                    Math.abs(pr - currentPass) < 0.005 ? 'text-primary font-bold' : 'text-muted-foreground'
                  }`}>
                    {pct(pr)}
                  </td>
                  {REQUEST_RATES.map(rr => {
                    const cell = result.grid.find(
                      c => c.passRate === pr && c.requestRate === rr
                    );
                    if (!cell) return <td key={rr} />;

                    const lp = showBreakers ? cell.breakerLossProb : cell.lossProb;
                    const mg = showBreakers ? cell.breakerMargin : cell.margin;
                    const profit = showBreakers ? cell.breakerProfitMean : cell.profitMean;

                    const isCurrent =
                      Math.abs(pr - currentPass) < 0.005 &&
                      Math.abs(rr - currentRequest) < 0.005;

                    // Show if breakers rescue this cell
                    const isRescued = cell.lossProb >= 0.15 && cell.breakerLossProb < 0.15;

                    return (
                      <td
                        key={rr}
                        className={`py-2 px-1.5 text-center rounded-md ${lossColor(lp)} ${
                          isCurrent ? 'ring-2 ring-primary ring-offset-2 ring-offset-background' : ''
                        }`}
                      >
                        <div className={`text-xs font-bold ${lossFg(lp)}`}>{pct(lp)}</div>
                        <div className={`text-[11px] font-mono ${marginColor(mg)}`}>
                          {pct(mg)}
                        </div>
                        <div className="text-[10px] font-mono text-muted-foreground">
                          {fmt(profit)}/mo
                        </div>
                        {showBreakers && cell.breakerL2Pct > 0.01 && (
                          <div className={`text-[10px] font-mono ${cell.breakerL2Pct > 0.10 ? 'text-destructive font-bold' : 'text-warning'}`}>
                            L2: {pct(cell.breakerL2Pct)}
                          </div>
                        )}
                        {showBreakers && isRescued && (
                          <div className="text-[10px] text-primary font-semibold">rescued</div>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {/* Summary + Legend */}
      {summary && (
        <Card className="border-muted">
          <CardContent className="pt-4 space-y-4">
            {/* Frontier callout */}
            <div className={`rounded-lg p-3 text-sm ${
              summary.redNo > 0 ? 'bg-destructive/10 border border-destructive/30' : 'bg-success/10 border border-success/30'
            }`}>
              <strong>Insolvency Frontier (no breakers):</strong>{' '}
              {summary.insolvencyStart != null ? (
                <>
                  Danger zone begins at <span className="text-destructive font-bold">{pct(summary.insolvencyStart)} pass rate</span>.
                  {summary.cautionStart != null && summary.cautionStart < summary.insolvencyStart && (
                    <> Caution from <span className="text-warning font-bold">{pct(summary.cautionStart)}</span>.</>
                  )}
                </>
              ) : summary.cautionStart != null ? (
                <>No danger cells, but caution starts at <span className="text-warning font-bold">{pct(summary.cautionStart)} pass rate</span>.</>
              ) : (
                <>No insolvency detected across the entire grid — structurally safe everywhere.</>
              )}
            </div>

            {/* Stats row */}
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div className="rounded-lg bg-success/10 p-2.5 text-center">
                <div className="text-lg font-bold text-success">{summary.greenNo}</div>
                <div className="text-xs text-muted-foreground">Safe (loss &lt;5%)</div>
              </div>
              <div className="rounded-lg bg-warning/10 p-2.5 text-center">
                <div className="text-lg font-bold text-warning">{summary.yellowNo}</div>
                <div className="text-xs text-muted-foreground">Caution (5–15%)</div>
              </div>
              <div className="rounded-lg bg-destructive/10 p-2.5 text-center">
                <div className="text-lg font-bold text-destructive">{summary.redNo}</div>
                <div className="text-xs text-muted-foreground">Danger (≥15%)</div>
              </div>
              <div className="rounded-lg bg-primary/10 p-2.5 text-center">
                <div className="text-lg font-bold text-primary">{summary.rescued}</div>
                <div className="text-xs text-muted-foreground">Rescued by breakers</div>
              </div>
            </div>

            {/* Breaker dependency insight */}
            {summary.breakerDependent > 0 && (
              <div className="rounded-lg bg-warning/10 border border-warning/30 p-3 text-sm">
                <strong>Breaker dependency:</strong>{' '}
                {summary.breakerDependent} cell{summary.breakerDependent > 1 ? 's' : ''} shift from caution → safe only with breakers.
                {summary.highL2 > 0 && (
                  <> ⚠ {summary.highL2} cell{summary.highL2 > 1 ? 's have' : ' has'} L2 &gt; 10% — breakers are doing life support, not safety-netting.</>
                )}
              </div>
            )}

            {/* Legend */}
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Cell Legend</p>
                <div className="space-y-1 text-xs">
                  <div className="flex items-center gap-2">
                    <span className="inline-block w-3 h-3 rounded bg-success/20" />
                    <span>Loss prob &lt; 5% — structurally safe</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="inline-block w-3 h-3 rounded bg-warning/20" />
                    <span>5–15% — caution zone</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="inline-block w-3 h-3 rounded bg-destructive/20" />
                    <span>15–30% — danger</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="inline-block w-3 h-3 rounded bg-destructive/30" />
                    <span>&gt;30% — structurally broken</span>
                  </div>
                </div>
              </div>
              <div>
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">How To Read</p>
                <ul className="space-y-1 text-xs text-muted-foreground list-disc pl-4">
                  <li>Top = monthly loss probability (how often revenue &lt; costs)</li>
                  <li>Middle = effective margin</li>
                  <li>Bottom = avg monthly profit ($)</li>
                  <li><span className="text-primary font-medium">Ringed</span> = your current config</li>
                  <li>"rescued" = breakers move cell from danger → safe</li>
                  <li>L2% = breaker freeze engagement (high = life support)</li>
                </ul>
              </div>
            </div>

            {/* Executive insight */}
            <div className="rounded-lg bg-muted/50 p-3 text-xs text-muted-foreground">
              <strong>Executive takeaway:</strong>{' '}
              {result.clustering
                ? 'With payout clustering, correlated timing creates tail risk that simple pass/request drift cannot. If red cells appear only with clustering ON, your risk is timing-structural, not parameter-structural. Breakers should target this regime specifically.'
                : 'Without clustering, pass/request drift degrades margins smoothly. If no red cells appear, your insolvency risk comes from correlated payout timing — run this grid with Clustering ON to surface it.'}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Actions */}
      <div className="flex items-center gap-2 justify-end">
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setClustering(!result.clustering);
            // Signal that re-run is needed
          }}
        >
          {result.clustering ? 'Switch to Normal' : 'Switch to Clustering'}
        </Button>
        <Button onClick={handleRun} disabled={isRunning} variant="outline" size="sm">
          {isRunning ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
          {isRunning ? 'Computing…' : 'Re-compute'}
        </Button>
      </div>
    </div>
  );
}
