/**
 * Structural Risk Map — Pass Rate × Request Rate grid
 * Shows loss probability, margin, and breaker dependency per cell.
 * Turns anxiety into geometry.
 */

import { useState, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Play, Loader2, Grid3X3 } from 'lucide-react';
import {
  runMonteCarlo,
  DEFAULT_ASSUMPTIONS,
  type MonteCarloAssumptions,
  type MonteCarloConfig,
  type MonteCarloResult,
} from '@/lib/monte-carlo';
import { PAY_REV_GUARDRAIL_V1 } from '@/lib/breaker-policy';

// ============================================================================
// CONFIG
// ============================================================================

const PASS_RATES = [0.05, 0.06, 0.07, 0.08, 0.09, 0.10];
const REQUEST_RATES = [0.20, 0.25, 0.30, 0.35];

const CONFIG: MonteCarloConfig = { iterations: 300, monthsPerIteration: 12, seed: 42 };
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
  breakerL2Pct: number;
}

interface RiskMapResult {
  grid: GridCell[];
  elapsed: number;
}

// ============================================================================
// HELPERS
// ============================================================================

function deepClone(base: MonteCarloAssumptions): MonteCarloAssumptions {
  return JSON.parse(JSON.stringify(base));
}

function buildAssumptions(passMode: number, requestMode: number): MonteCarloAssumptions {
  const a = deepClone(DEFAULT_ASSUMPTIONS);
  a.passRate = { min: Math.max(0.02, passMode - 0.02), mode: passMode, max: passMode + 0.03 };
  a.payoutRequestRate = {
    min: Math.max(0.05, requestMode - 0.05),
    mode: requestMode,
    max: Math.min(0.95, requestMode + 0.10),
  };
  return a;
}

function runGrid(): RiskMapResult {
  const start = Date.now();
  const grid: GridCell[] = [];

  for (const pr of PASS_RATES) {
    for (const rr of REQUEST_RATES) {
      const assumptions = buildAssumptions(pr, rr);
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
        breakerL2Pct: rWith.breakerDiagnostics?.timeInL2Pct ?? 0,
      });
    }
  }

  return { grid, elapsed: Date.now() - start };
}

// ============================================================================
// COLOR LOGIC
// ============================================================================

function lossColor(lossProb: number): string {
  if (lossProb <= 0) return 'bg-success/20 text-success';
  if (lossProb < 0.05) return 'bg-success/10 text-success';
  if (lossProb < 0.15) return 'bg-warning/20 text-warning';
  if (lossProb < 0.30) return 'bg-destructive/20 text-destructive';
  return 'bg-destructive/30 text-destructive font-bold';
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

export function StructuralRiskMap() {
  const [result, setResult] = useState<RiskMapResult | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [showBreakers, setShowBreakers] = useState(false);

  const handleRun = useCallback(() => {
    setIsRunning(true);
    setTimeout(() => {
      try {
        setResult(runGrid());
      } finally {
        setIsRunning(false);
      }
    }, 50);
  }, []);

  const fmt = (v: number) => '$' + Math.round(v).toLocaleString();
  const pct = (v: number) => (v * 100).toFixed(1) + '%';

  if (!result) {
    return (
      <Card className="border-dashed">
        <CardContent className="flex flex-col items-center justify-center py-16">
          <Grid3X3 className="h-12 w-12 text-muted-foreground mb-4" />
          <h3 className="text-lg font-medium mb-2">Structural Risk Map</h3>
          <p className="text-muted-foreground text-center mb-2 max-w-md">
            Runs {PASS_RATES.length} × {REQUEST_RATES.length} = {PASS_RATES.length * REQUEST_RATES.length} scenarios
            across pass rate ({pct(PASS_RATES[0])}–{pct(PASS_RATES[PASS_RATES.length - 1])}) and
            request rate ({pct(REQUEST_RATES[0])}–{pct(REQUEST_RATES[REQUEST_RATES.length - 1])}).
            Each cell runs with and without breakers.
          </p>
          <p className="text-xs text-muted-foreground mb-4">
            {PASS_RATES.length * REQUEST_RATES.length * 2} simulations × 300 iterations each. ~60–120s.
          </p>
          <Button onClick={handleRun} disabled={isRunning} size="lg">
            {isRunning ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
            {isRunning ? 'Computing Grid…' : 'Build Risk Map'}
          </Button>
        </CardContent>
      </Card>
    );
  }

  // Find current config position
  const currentPass = DEFAULT_ASSUMPTIONS.passRate.mode;
  const currentRequest = DEFAULT_ASSUMPTIONS.payoutRequestRate.mode;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Grid3X3 className="h-5 w-5" />
            Structural Risk Map
          </CardTitle>
          <CardDescription>
            Each cell: {showBreakers ? 'WITH breakers' : 'NO breakers'}.
            Shows loss probability (bg color) + margin + profit/mo.
            Your current config is highlighted with a ring.
          </CardDescription>
          <div className="flex gap-2 pt-2">
            <Button
              variant={showBreakers ? 'outline' : 'default'}
              size="sm"
              onClick={() => setShowBreakers(false)}
            >
              No Breakers
            </Button>
            <Button
              variant={showBreakers ? 'default' : 'outline'}
              size="sm"
              onClick={() => setShowBreakers(true)}
            >
              With Breakers
            </Button>
            <Badge variant="secondary" className="ml-auto">
              {(result.elapsed / 1000).toFixed(1)}s
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr>
                <th className="pb-2 pr-2 text-left text-xs text-muted-foreground">
                  Pass ↓ / Request →
                </th>
                {REQUEST_RATES.map(rr => (
                  <th key={rr} className="pb-2 px-2 text-center text-xs text-muted-foreground">
                    {pct(rr)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {PASS_RATES.map(pr => (
                <tr key={pr}>
                  <td className="py-1 pr-2 text-xs font-medium text-muted-foreground whitespace-nowrap">
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

                    return (
                      <td
                        key={rr}
                        className={`py-2 px-2 text-center rounded-md ${lossColor(lp)} ${
                          isCurrent ? 'ring-2 ring-primary ring-offset-2 ring-offset-background' : ''
                        }`}
                      >
                        <div className="text-xs font-bold">{pct(lp)}</div>
                        <div className={`text-[11px] font-mono ${marginColor(mg)}`}>
                          {pct(mg)}
                        </div>
                        <div className="text-[10px] font-mono text-muted-foreground">
                          {fmt(profit)}/mo
                        </div>
                        {showBreakers && cell.breakerL2Pct > 0.01 && (
                          <div className="text-[10px] font-mono text-destructive">
                            L2: {pct(cell.breakerL2Pct)}
                          </div>
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

      {/* Legend + interpretation */}
      <Card className="border-muted">
        <CardContent className="pt-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Cell Legend</p>
              <div className="space-y-1 text-xs">
                <div className="flex items-center gap-2">
                  <span className="inline-block w-3 h-3 rounded bg-success/20" />
                  <span>Loss prob ≤ 5% — structurally safe</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="inline-block w-3 h-3 rounded bg-warning/20" />
                  <span>Loss prob 5–15% — caution zone</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="inline-block w-3 h-3 rounded bg-destructive/20" />
                  <span>Loss prob 15–30% — danger</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="inline-block w-3 h-3 rounded bg-destructive/30" />
                  <span>Loss prob &gt;30% — structurally broken</span>
                </div>
              </div>
            </div>
            <div>
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Reading This Map</p>
              <ul className="space-y-1 text-xs text-muted-foreground list-disc pl-4">
                <li>Top number = monthly loss probability (how often you lose money)</li>
                <li>Middle = effective margin (revenue after all costs)</li>
                <li>Bottom = average monthly profit in dollars</li>
                <li>Toggle "With Breakers" to see how breakers shift the red zone</li>
                <li>Your current config is <span className="font-medium text-primary">ringed</span></li>
                <li>If breaker L2% shows, it means breakers are actively intervening</li>
              </ul>
            </div>
          </div>

          {/* Key insight */}
          {(() => {
            const redCells = result.grid.filter(c => c.lossProb >= 0.15);
            const greenCells = result.grid.filter(c => c.lossProb < 0.05);
            const breakerSaved = result.grid.filter(
              c => c.lossProb >= 0.15 && c.breakerLossProb < 0.15
            );
            return (
              <div className="mt-4 rounded-lg bg-muted/50 p-3 text-sm">
                <strong>Summary:</strong>{' '}
                <span className="text-success font-medium">{greenCells.length}</span> cells structurally safe,{' '}
                <span className="text-destructive font-medium">{redCells.length}</span> in danger zone
                {breakerSaved.length > 0 && (
                  <>, <span className="text-primary font-medium">{breakerSaved.length}</span> rescued by breakers</>
                )}
                . Insolvency begins at{' '}
                {(() => {
                  // Find the lowest pass rate that has a red cell
                  const redPasses = [...new Set(redCells.map(c => c.passRate))].sort();
                  if (redPasses.length === 0) return 'no tested combination (you are structurally safe everywhere)';
                  return `~${pct(redPasses[0])} pass rate`;
                })()}.
              </div>
            );
          })()}
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button onClick={handleRun} disabled={isRunning} variant="outline" size="sm">
          {isRunning ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
          Re-compute
        </Button>
      </div>
    </div>
  );
}
