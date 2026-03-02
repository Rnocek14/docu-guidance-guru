/**
 * Structural Risk Map — Pass Rate × Request Rate grid
 * Shows loss probability, margin, and breaker dependency per cell.
 * Turns anxiety into geometry.
 * 
 * v2: Extended axes into danger zone (pass 5–15%, request 20–60%)
 *     + clustering toggle to surface the real insolvency frontier.
 * 
 * Perf: gridMap lookup (O(1) per cell), dedicated iteration count,
 *       canonical clustering overlay from stress battery.
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
// GRID AXES — extended into danger zone to find the real frontier
// ============================================================================

const PASS_RATES = [0.05, 0.07, 0.09, 0.10, 0.12, 0.15];
const REQUEST_RATES = [0.20, 0.25, 0.30, 0.35, 0.45, 0.60];

// ============================================================================
// TYPES
// ============================================================================

interface GridCell {
  passRate: number;
  requestRate: number;
  margin: number;
  lossProb: number;
  profitMean: number;
  maxDD: number;
  payRevRatio: number;
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
// HELPERS — canonical, consistent with stress battery
// ============================================================================

function deepClone(base: MonteCarloAssumptions): MonteCarloAssumptions {
  return JSON.parse(JSON.stringify(base));
}

/**
 * Build assumptions for a grid cell.
 * Clustering overlay matches the stress battery's withPayoutClustering():
 *   - payoutsPerPaidAccountPerMonth: { min: 0.8, mode: 1.4, max: 2.0 }
 *   - avgPayoutAmount scaled 1.15×
 * But does NOT override payoutRequestRate (that's the grid axis).
 */
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

/** Stable key for grid lookup — avoids float-equality fragility */
function gridKey(pr: number, rr: number): string {
  return `${pr.toFixed(4)}|${rr.toFixed(4)}`;
}

// ============================================================================
// GRID RUNNER
// ============================================================================

function runGrid(clustering: boolean): RiskMapResult {
  const start = Date.now();
  const grid: GridCell[] = [];

  // Dedicated grid config: smaller iterations for speed, tuned per mode
  const iterations = clustering ? 350 : 250;
  const baseConfig: MonteCarloConfig = { iterations, monthsPerIteration: 12, seed: 42 };
  const breakerConfig: MonteCarloConfig = { ...baseConfig, breakerPolicy: PAY_REV_GUARDRAIL_V1 };

  for (const pr of PASS_RATES) {
    for (const rr of REQUEST_RATES) {
      const assumptions = buildAssumptions(pr, rr, clustering);
      const rNo = runMonteCarlo(baseConfig, assumptions);
      const rWith = runMonteCarlo(breakerConfig, assumptions);

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

  // O(1) cell lookup — avoids O(cells²) .find() in render
  const gridMap = useMemo(() => {
    if (!result) return new Map<string, GridCell>();
    const m = new Map<string, GridCell>();
    for (const c of result.grid) m.set(gridKey(c.passRate, c.requestRate), c);
    return m;
  }, [result]);

  // Summary stats
  const summary = useMemo(() => {
    if (!result) return null;
    const cells = result.grid;
    const greenNo = cells.filter(c => c.lossProb < 0.05).length;
    const yellowNo = cells.filter(c => c.lossProb >= 0.05 && c.lossProb < 0.15).length;
    const redNo = cells.filter(c => c.lossProb >= 0.15).length;
    // Rescued: danger (≥15%) → below danger (<15%) with breakers
    const rescued = cells.filter(c => c.lossProb >= 0.15 && c.breakerLossProb < 0.15).length;
    // Breaker-dependent: caution (5–15%) → safe (<5%) only with breakers
    const breakerDependent = cells.filter(c => c.lossProb >= 0.05 && c.lossProb < 0.15 && c.breakerLossProb < 0.05).length;
    const highL2 = cells.filter(c => c.breakerL2Pct > 0.10).length;

    const redPasses = [...new Set(cells.filter(c => c.lossProb >= 0.15).map(c => c.passRate))].sort((a, b) => a - b);
    const yellowPasses = [...new Set(cells.filter(c => c.lossProb >= 0.05).map(c => c.passRate))].sort((a, b) => a - b);

    return {
      greenNo, yellowNo, redNo, rescued, breakerDependent, highL2,
      insolvencyStart: redPasses[0] ?? null,
      cautionStart: yellowPasses[0] ?? null,
    };
  }, [result]);

  const currentPass = DEFAULT_ASSUMPTIONS.passRate.mode;
  const currentRequest = DEFAULT_ASSUMPTIONS.payoutRequestRate.mode;
  const showBreakers = viewMode === 'with-breaker';

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
            {totalSims} sims × {clustering ? '350' : '250'} iter.
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
              {(result.elapsed / 1000).toFixed(1)}s · {PASS_RATES.length}×{REQUEST_RATES.length}
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
                    const cell = gridMap.get(gridKey(pr, rr));
                    if (!cell) return <td key={rr} />;

                    const lp = showBreakers ? cell.breakerLossProb : cell.lossProb;
                    const mg = showBreakers ? cell.breakerMargin : cell.margin;
                    const profit = showBreakers ? cell.breakerProfitMean : cell.profitMean;

                    const isCurrent =
                      Math.abs(pr - currentPass) < 0.005 &&
                      Math.abs(rr - currentRequest) < 0.005;

                    // Rescued: danger → below danger with breakers
                    const isRescued = cell.lossProb >= 0.15 && cell.breakerLossProb < 0.15;
                    // Breaker-dependent: caution → safe only with breakers
                    const isBreakerDep = cell.lossProb >= 0.05 && cell.lossProb < 0.15 && cell.breakerLossProb < 0.05;

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
                        {showBreakers && isBreakerDep && !isRescued && (
                          <div className="text-[10px] text-warning font-semibold">dep</div>
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
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
              <div className="rounded-lg bg-success/10 p-2.5 text-center">
                <div className="text-lg font-bold text-success">{summary.greenNo}</div>
                <div className="text-xs text-muted-foreground">Safe (&lt;5%)</div>
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
                <div className="text-xs text-muted-foreground">Rescued</div>
              </div>
              <div className="rounded-lg bg-warning/10 p-2.5 text-center">
                <div className="text-lg font-bold text-warning">{summary.breakerDependent}</div>
                <div className="text-xs text-muted-foreground">Breaker-dep</div>
              </div>
            </div>

            {/* Breaker dependency insight */}
            {(summary.breakerDependent > 0 || summary.rescued > 0) && (
              <div className="rounded-lg bg-warning/10 border border-warning/30 p-3 text-sm">
                <strong>Breaker analysis:</strong>{' '}
                {summary.rescued > 0 && (
                  <>{summary.rescued} cell{summary.rescued > 1 ? 's' : ''} rescued from danger → below danger. </>
                )}
                {summary.breakerDependent > 0 && (
                  <>{summary.breakerDependent} cell{summary.breakerDependent > 1 ? 's are' : ' is'} safe <em>only</em> with breakers (caution → safe). </>
                )}
                {summary.highL2 > 0 && (
                  <>⚠ {summary.highL2} cell{summary.highL2 > 1 ? 's have' : ' has'} L2 &gt;10% — breakers doing life support, not safety-netting.</>
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
                    <span>Loss &lt;5% — structurally safe</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="inline-block w-3 h-3 rounded bg-warning/20" />
                    <span>5–15% — caution</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="inline-block w-3 h-3 rounded bg-destructive/20" />
                    <span>15–30% — danger</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="inline-block w-3 h-3 rounded bg-destructive/30" />
                    <span>&gt;30% — structurally broken</span>
                  </div>
                  <div className="flex items-center gap-2 mt-1">
                    <span className="text-primary font-semibold text-[10px]">rescued</span>
                    <span>= danger → below danger with breakers</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-warning font-semibold text-[10px]">dep</span>
                    <span>= caution → safe only with breakers</span>
                  </div>
                </div>
              </div>
              <div>
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">How To Read</p>
                <ul className="space-y-1 text-xs text-muted-foreground list-disc pl-4">
                  <li>Top = monthly loss probability</li>
                  <li>Middle = effective margin</li>
                  <li>Bottom = avg profit/mo ($)</li>
                  <li><span className="text-primary font-medium">Ringed</span> = your current config</li>
                  <li>L2% = breaker freeze engagement</li>
                  <li>Run Normal → Clustering to see timing-correlated risk</li>
                </ul>
              </div>
            </div>

            {/* Executive insight */}
            <div className="rounded-lg bg-muted/50 p-3 text-xs text-muted-foreground">
              <strong>Executive takeaway:</strong>{' '}
              {result.clustering
                ? 'With payout clustering, correlated timing creates tail risk that parameter drift alone cannot. Red cells here identify your true insolvency boundary. If breakers rescue those cells but L2% is high, your product experience degrades under sustained stress — that\'s a structural design problem, not a safety net.'
                : 'Without clustering, margins degrade smoothly — no hidden cliff. If the grid is all green, your insolvency risk comes from correlated payout timing, not pass/request drift. Run with Clustering ON to surface the real frontier.'}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Actions */}
      <div className="flex items-center gap-2 justify-end">
        <Button
          variant="outline"
          size="sm"
          onClick={() => setClustering(!result.clustering)}
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
