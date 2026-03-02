/**
 * Competitor Overlay Panel — renders competitor scenario markers
 * on the Structural Risk Map grid and a summary comparison table.
 *
 * Runs each competitor scenario through the Monte Carlo engine at their
 * specific (passRate, requestRate) point, with firm-specific clustering.
 */

import { useMemo, useState, useCallback } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Play, Loader2, Building2, Eye, EyeOff } from 'lucide-react';
import {
  runMonteCarlo,
  type MonteCarloConfig,
  type MonteCarloAssumptions,
} from '@/lib/monte-carlo';
import { PAY_REV_GUARDRAIL_V1 } from '@/lib/breaker-policy';
import {
  ALL_COMPETITOR_SCENARIOS,
  type CompetitorScenario,
} from '@/lib/competitor-profiles';

// ============================================================================
// TYPES
// ============================================================================

export interface CompetitorResult {
  scenario: CompetitorScenario;
  lossProb: number;
  margin: number;
  profitMean: number;
  breakerLossProb: number;
  breakerMargin: number;
  breakerProfitMean: number;
  breakerL2Pct: number;
  payRevRatio: number;
  capCount: number;
  capHits: number;
  capEligiblePayouts: number;
  avgGrossInCapRegime: number;
  avgNetInCapRegime: number;
}

export interface CompetitorOverlayState {
  results: CompetitorResult[];
  elapsed: number;
  runId: number;
  seed: number;
}

// ============================================================================
// RUNNER
// ============================================================================

function applyClusteringToAssumptions(
  base: MonteCarloAssumptions,
  intensity: number,
): MonteCarloAssumptions {
  if (intensity <= 0) return base;
  const a: MonteCarloAssumptions = JSON.parse(JSON.stringify(base));
  // Scale clustering knobs by intensity (1.0 = full, 0.8 = reduced)
  a.payoutsPerPaidAccountPerMonth = {
    min: 0.4 + (0.4 * intensity),   // baseline 0.4 → 0.8 at full
    mode: 0.7 + (0.7 * intensity),  // baseline 0.7 → 1.4 at full
    max: 1.2 + (0.8 * intensity),   // baseline 1.2 → 2.0 at full
  };
  a.avgPayoutAmount = {
    mean: a.avgPayoutAmount.mean * (1 + 0.15 * intensity),
    stdDev: a.avgPayoutAmount.stdDev * (1 + 0.15 * intensity),
  };
  return a;
}

function runCompetitorOverlay(clustering: boolean, runId: number): CompetitorOverlayState {
  const start = Date.now();
  const results: CompetitorResult[] = [];
  const iterations = clustering ? 350 : 250;
  const seed = 42;

  for (const scenario of ALL_COMPETITOR_SCENARIOS) {
    let assumptions = scenario.assumptions;

    if (clustering) {
      assumptions = applyClusteringToAssumptions(
        assumptions,
        scenario.clusteringIntensity,
      );
    }

    const baseConfig: MonteCarloConfig = { iterations, monthsPerIteration: 12, seed };
    const breakerConfig: MonteCarloConfig = { ...baseConfig, breakerPolicy: PAY_REV_GUARDRAIL_V1 };

    const rNo = runMonteCarlo(baseConfig, assumptions);
    const rWith = runMonteCarlo(breakerConfig, assumptions);

    results.push({
      scenario,
      lossProb: rNo.risk.probabilityOfLoss,
      margin: rNo.diagnostics.effectiveMargin,
      profitMean: rNo.profit.mean,
      breakerLossProb: rWith.risk.probabilityOfLoss,
      breakerMargin: rWith.diagnostics.effectiveMargin,
      breakerProfitMean: rWith.profit.mean,
      breakerL2Pct: rWith.breakerDiagnostics?.timeInL2Pct ?? 0,
      payRevRatio: rNo.diagnostics.payoutToRevenueRatio,
      capCount: rNo.payoutDiagnostics.firstPayoutCapConfiguredCount,
      capHits: rNo.payoutDiagnostics.capHits,
      capEligiblePayouts: rNo.payoutDiagnostics.capEligiblePayouts,
      avgGrossInCapRegime: rNo.payoutDiagnostics.avgGrossInCapRegime,
      avgNetInCapRegime: rNo.payoutDiagnostics.avgNetInCapRegime,
    });
  }

  return { results, elapsed: Date.now() - start, runId, seed };
}

// ============================================================================
// ZONE CLASSIFICATION
// ============================================================================

function zoneLabel(lossProb: number): { label: string; className: string } {
  if (lossProb < 0.05) return { label: 'Safe', className: 'text-success' };
  if (lossProb < 0.15) return { label: 'Caution', className: 'text-warning' };
  if (lossProb < 0.30) return { label: 'Danger', className: 'text-destructive' };
  return { label: 'Broken', className: 'text-destructive font-bold' };
}

function dependencyLabel(r: CompetitorResult): string {
  if (r.lossProb >= 0.15 && r.breakerLossProb < 0.15) return 'Rescued';
  if (r.lossProb >= 0.05 && r.breakerLossProb < 0.05) return 'Breaker-dep';
  if (r.breakerL2Pct > 0.10) return 'Life support';
  return '—';
}

// ============================================================================
// COMPONENTS
// ============================================================================

const pct = (v: number) => (v * 100).toFixed(1) + '%';
const fmt = (v: number) => '$' + Math.round(v).toLocaleString();

/** Grid markers: positioned on the risk map grid */
export function CompetitorGridMarkers({
  results,
  passRates,
  requestRates,
  showBreakers,
}: {
  results: CompetitorResult[];
  passRates: number[];
  requestRates: number[];
  showBreakers: boolean;
}) {
  // Find closest grid cell for each competitor
  const findClosest = (val: number, axis: number[]) =>
    axis.reduce((prev, curr) =>
      Math.abs(curr - val) < Math.abs(prev - val) ? curr : prev
    );

  // Group by grid position
  const markersByCell = new Map<string, CompetitorResult[]>();
  for (const r of results) {
    const closestPass = findClosest(r.scenario.passRate, passRates);
    const closestReq = findClosest(r.scenario.requestRate, requestRates);
    const key = `${closestPass.toFixed(4)}|${closestReq.toFixed(4)}`;
    const existing = markersByCell.get(key) ?? [];
    existing.push(r);
    markersByCell.set(key, existing);
  }

  return { markersByCell };
}

/** Summary panel shown below the grid */
export function CompetitorOverlayPanel({
  clustering,
}: {
  clustering: boolean;
}) {
  const [state, setState] = useState<CompetitorOverlayState | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [showDetails, setShowDetails] = useState(true);
  const [runIdCounter, setRunIdCounter] = useState(0);

  const handleRun = useCallback(() => {
    setIsRunning(true);
    const nextRunId = runIdCounter + 1;
    setRunIdCounter(nextRunId);
    setTimeout(() => {
      try {
        setState(runCompetitorOverlay(clustering, nextRunId));
      } finally {
        setIsRunning(false);
      }
    }, 50);
  }, [clustering, runIdCounter]);

  // Group by firm
  const grouped = useMemo(() => {
    if (!state) return null;
    const apex = state.results.filter(r => r.scenario.firmId === 'apex');
    const ftmo = state.results.filter(r => r.scenario.firmId === 'ftmo');
    return { apex, ftmo };
  }, [state]);

  if (!state) {
    return (
      <Card className="border-dashed border-muted-foreground/30">
        <CardContent className="flex flex-col items-center justify-center py-8">
          <Building2 className="h-8 w-8 text-muted-foreground mb-3" />
          <h4 className="text-sm font-medium mb-1">Competitor Overlay</h4>
          <p className="text-xs text-muted-foreground text-center max-w-sm mb-3">
            Drop Apex (3 scenarios) and FTMO (3 scenarios) on the risk map.
            {clustering ? ' Clustering ON — firm-specific intensity applied.' : ''}
          </p>
          <p className="text-[11px] text-muted-foreground mb-3">
            6 scenarios × 2 (±breakers) × {clustering ? '350' : '250'} iter. ~30–90s.
          </p>
          <Button onClick={handleRun} disabled={isRunning} size="sm">
            {isRunning ? <Loader2 className="mr-2 h-3 w-3 animate-spin" /> : <Play className="mr-2 h-3 w-3" />}
            {isRunning ? 'Simulating…' : 'Run Competitor Overlay'}
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="pt-4 space-y-4">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Building2 className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium">Competitor Overlay</span>
            <Badge variant="secondary" className="text-[10px]">
              Run #{state.runId}
            </Badge>
            <Badge variant="secondary" className="text-[10px]">
              {(state.elapsed / 1000).toFixed(1)}s
            </Badge>
            <Badge variant="outline" className="text-[10px]">
              seed {state.seed}
            </Badge>
            {clustering && (
              <Badge variant="outline" className="text-[10px]">
                Firm-specific clustering
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowDetails(d => !d)}
            >
              {showDetails ? <EyeOff className="h-3 w-3 mr-1" /> : <Eye className="h-3 w-3 mr-1" />}
              {showDetails ? 'Collapse' : 'Expand'}
            </Button>
            <Button onClick={handleRun} disabled={isRunning} variant="outline" size="sm">
              {isRunning ? <Loader2 className="mr-2 h-3 w-3 animate-spin" /> : <Play className="mr-2 h-3 w-3" />}
              Re-run
            </Button>
          </div>
        </div>

        {showDetails && grouped && (
          <>
            {/* Apex table */}
            <FirmTable
              firmLabel="Apex"
              firmColor="text-orange-500"
              results={grouped.apex}
            />

            {/* FTMO table */}
            <FirmTable
              firmLabel="FTMO"
              firmColor="text-blue-500"
              results={grouped.ftmo}
            />

            <ApexCapDiagnostics results={grouped.apex} />

            {/* Executive insight */}
            <CompetitorInsight results={state.results} clustering={clustering} />
          </>
        )}
      </CardContent>
    </Card>
  );
}

function FirmTable({
  firmLabel,
  firmColor,
  results,
}: {
  firmLabel: string;
  firmColor: string;
  results: CompetitorResult[];
}) {
  return (
    <div>
      <p className={`text-xs font-semibold uppercase tracking-wide mb-2 ${firmColor}`}>
        {firmLabel}
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-xs border-collapse">
          <thead>
            <tr className="border-b border-border">
              <th className="text-left py-1.5 pr-2 text-muted-foreground font-medium">Scenario</th>
              <th className="text-center py-1.5 px-2 text-muted-foreground font-medium">Cap</th>
              <th className="text-center py-1.5 px-2 text-muted-foreground font-medium">Cap N</th>
              <th className="text-center py-1.5 px-2 text-muted-foreground font-medium">Split</th>
              <th className="text-center py-1.5 px-2 text-muted-foreground font-medium">Life Cap</th>
              <th className="text-center py-1.5 px-2 text-muted-foreground font-medium">Pass</th>
              <th className="text-center py-1.5 px-2 text-muted-foreground font-medium">Req</th>
              <th className="text-center py-1.5 px-2 text-muted-foreground font-medium">Loss%</th>
              <th className="text-center py-1.5 px-2 text-muted-foreground font-medium">Margin</th>
              <th className="text-center py-1.5 px-2 text-muted-foreground font-medium">Profit/mo</th>
              <th className="text-center py-1.5 px-2 text-muted-foreground font-medium">+Breaker</th>
              <th className="text-center py-1.5 px-2 text-muted-foreground font-medium">L2%</th>
              <th className="text-center py-1.5 px-2 text-muted-foreground font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {results.map(r => {
              const zone = zoneLabel(r.lossProb);
              const bZone = zoneLabel(r.breakerLossProb);
              const dep = dependencyLabel(r);
              return (
                <tr key={r.scenario.label} className="border-b border-border/50">
                  <td className="py-1.5 pr-2 font-medium">{r.scenario.variant}</td>
                  <td className="text-center py-1.5 px-2 font-mono">
                    {r.scenario.assumptions.knobs.firstPayoutCap == null ? '—' : fmt(r.scenario.assumptions.knobs.firstPayoutCap)}
                  </td>
                  <td className="text-center py-1.5 px-2 font-mono">{r.scenario.assumptions.knobs.firstPayoutCapCount ?? 0}</td>
                  <td className="text-center py-1.5 px-2 font-mono">{pct(r.scenario.assumptions.knobs.payoutSplitPercent)}</td>
                  <td className="text-center py-1.5 px-2 font-mono">
                    {r.scenario.assumptions.knobs.lifetimeCapPerUser == null ? '∞' : fmt(r.scenario.assumptions.knobs.lifetimeCapPerUser)}
                  </td>
                  <td className="text-center py-1.5 px-2">{pct(r.scenario.passRate)}</td>
                  <td className="text-center py-1.5 px-2">{pct(r.scenario.requestRate)}</td>
                  <td className={`text-center py-1.5 px-2 font-bold ${zone.className}`}>
                    {pct(r.lossProb)}
                  </td>
                  <td className="text-center py-1.5 px-2 font-mono">{pct(r.margin)}</td>
                  <td className="text-center py-1.5 px-2 font-mono">{fmt(r.profitMean)}</td>
                  <td className={`text-center py-1.5 px-2 font-bold ${bZone.className}`}>
                    {pct(r.breakerLossProb)}
                  </td>
                  <td className={`text-center py-1.5 px-2 font-mono ${r.breakerL2Pct > 0.10 ? 'text-destructive font-bold' : ''}`}>
                    {r.breakerL2Pct > 0.01 ? pct(r.breakerL2Pct) : '—'}
                  </td>
                  <td className="text-center py-1.5 px-2">
                    <span className={`text-[10px] font-semibold ${
                      dep === 'Rescued' ? 'text-primary' :
                      dep === 'Breaker-dep' ? 'text-warning' :
                      dep === 'Life support' ? 'text-destructive' :
                      'text-muted-foreground'
                    }`}>
                      {dep}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ApexCapDiagnostics({
  results,
}: {
  results: CompetitorResult[];
}) {
  return (
    <div className="rounded-lg bg-muted/50 p-3 text-xs text-muted-foreground space-y-2">
      <p className="font-semibold text-foreground">Apex Cap Binding Check</p>
      <div className="overflow-x-auto">
        <table className="w-full text-xs border-collapse">
          <thead>
            <tr className="border-b border-border/60">
              <th className="text-left py-1.5 pr-2 font-medium">Scenario</th>
              <th className="text-center py-1.5 px-2 font-medium">Cap N</th>
              <th className="text-center py-1.5 px-2 font-medium">Cap Hits</th>
              <th className="text-center py-1.5 px-2 font-medium">Cap Eligible</th>
              <th className="text-center py-1.5 px-2 font-medium">Avg Gross (cap)</th>
              <th className="text-center py-1.5 px-2 font-medium">Avg Net (cap)</th>
            </tr>
          </thead>
          <tbody>
            {results.map((r) => (
              <tr key={`apex-cap-${r.scenario.label}`} className="border-b border-border/40">
                <td className="py-1.5 pr-2 font-medium">{r.scenario.variant}</td>
                <td className="text-center py-1.5 px-2 font-mono">{r.capCount}</td>
                <td className="text-center py-1.5 px-2 font-mono">{r.capHits}</td>
                <td className="text-center py-1.5 px-2 font-mono">{r.capEligiblePayouts}</td>
                <td className="text-center py-1.5 px-2 font-mono">{fmt(r.avgGrossInCapRegime)}</td>
                <td className="text-center py-1.5 px-2 font-mono">{fmt(r.avgNetInCapRegime)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CompetitorInsight({
  results,
  clustering,
}: {
  results: CompetitorResult[];
  clustering: boolean;
}) {
  const apex = results.filter(r => r.scenario.firmId === 'apex');
  const ftmo = results.filter(r => r.scenario.firmId === 'ftmo');

  const apexRedCount = apex.filter(r => r.lossProb >= 0.15).length;
  const apexRescued = apex.filter(r => r.lossProb >= 0.15 && r.breakerLossProb < 0.15).length;
  const ftmoSafe = ftmo.filter(r => r.lossProb < 0.05).length;

  return (
    <div className="rounded-lg bg-muted/50 p-3 text-xs text-muted-foreground space-y-2">
      <p className="font-semibold text-foreground">Executive Takeaway</p>
      <p>
        <span className="text-orange-500 font-semibold">Apex:</span>{' '}
        {apexRedCount === 0
          ? 'All scenarios survive without breakers — their implicit throttles ($2k cap, consistency rule) are doing the work. Your config is not overly conservative relative to Apex.'
          : apexRedCount === apex.length
            ? `All ${apex.length} scenarios land in danger without breakers. ${apexRescued > 0 ? `${apexRescued} rescued with breakers.` : ''} Their survival requires either much lower real pass rates or heavy implicit throttling.`
            : `${apexRedCount}/${apex.length} scenarios in danger zone. Their $2k first-5 cap acts as a structural breaker — without it they'd be deeper in red.`
        }
      </p>
      <p>
        <span className="text-blue-500 font-semibold">FTMO:</span>{' '}
        {ftmoSafe === ftmo.length
          ? 'All scenarios land safely — their premium pricing + 2-step filter + refund model creates a wide safety margin. They\'re structurally conservative.'
          : `${ftmoSafe}/${ftmo.length} safe. Despite premium pricing, higher pass/request rates push them toward caution. The refund model reduces effective revenue more than headline pricing suggests.`
        }
      </p>
      {clustering && (
        <p className="text-[11px]">
          <strong>Clustering note:</strong> Apex runs at full clustering intensity (8-day cycles, multi-account culture). FTMO at 0.8× (14-day cycles, institutional discipline). This differential is critical — Apex's geometry is more sensitive to correlated timing.
        </p>
      )}
    </div>
  );
}
