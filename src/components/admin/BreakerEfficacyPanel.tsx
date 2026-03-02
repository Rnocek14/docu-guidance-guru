/**
 * Breaker Efficacy Panel — A/B comparison: No Breakers vs Pay/Rev Guardrail v1
 * Shows whether dynamic breakers stabilize tails or just delay insolvency.
 */

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { CheckCircle, XCircle, Shield, ShieldAlert } from 'lucide-react';
import type { BreakerDiagnostics } from '@/lib/breaker-policy';

export interface BreakerComparisonRow {
  scenarioName: string;
  noBreaker: {
    maxDD: number;
    cumP5: number;
    payRevP95: number;
    payRevP99: number;
    margin: number;
    lossProb: number;
  };
  withBreaker: {
    maxDD: number;
    cumP5: number;
    payRevP95: number;
    payRevP99: number;
    margin: number;
    lossProb: number;
    diagnostics: BreakerDiagnostics;
  };
}

interface Props {
  comparisons: BreakerComparisonRow[];
}

export function BreakerEfficacyPanel({ comparisons }: Props) {
  if (comparisons.length === 0) return null;

  const fmt = (v: number) => '$' + Math.round(v).toLocaleString();
  const pct = (v: number) => (v * 100).toFixed(1) + '%';

  // Determine overall: do breakers stabilize tails?
  const allStabilize = comparisons.every(c => {
    const ddImproved = c.withBreaker.maxDD <= c.noBreaker.maxDD;
    const p5Improved = c.withBreaker.cumP5 >= c.noBreaker.cumP5;
    return ddImproved || p5Improved;
  });

  const anyL2Explosion = comparisons.some(c =>
    c.withBreaker.diagnostics.timeInL2Pct > 0.20
  );

  const verdictLabel = allStabilize && !anyL2Explosion
    ? 'Breakers STABILIZE tails'
    : anyL2Explosion
      ? 'Breakers buy time but L2 engagement is excessive'
      : 'Breakers have limited effect — check thresholds';

  const verdictPass = allStabilize && !anyL2Explosion;

  return (
    <Card className={verdictPass ? 'border-success/50' : 'border-warning/50'}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {verdictPass ? <Shield className="h-5 w-5 text-success" /> : <ShieldAlert className="h-5 w-5 text-warning" />}
          Breaker Efficacy: No Breakers vs Pay/Rev Guardrail v1
        </CardTitle>
        <CardDescription>
          Same assumptions, same seed. Breaker policy tightens velocity at Pay/Rev &gt; 45%, freezes at &gt; 60%.
          Hysteresis prevents thrash (release requires sustained recovery).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Verdict */}
        <div className={`flex items-center gap-2 text-sm font-medium ${verdictPass ? 'text-success' : 'text-warning'}`}>
          {verdictPass ? <CheckCircle className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
          {verdictLabel}
        </div>

        {/* Comparison table */}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="pb-2 pr-4" rowSpan={2}>Scenario</th>
                <th className="pb-1 pr-4 text-center border-b" colSpan={4}>No Breakers</th>
                <th className="pb-1 pr-4 text-center border-b" colSpan={4}>With Breakers</th>
                <th className="pb-1 text-center border-b" colSpan={3}>Breaker Activity</th>
              </tr>
              <tr className="border-b text-muted-foreground text-xs">
                <th className="pb-2 pr-3 text-right">DD</th>
                <th className="pb-2 pr-3 text-right">P5</th>
                <th className="pb-2 pr-3 text-right">P/R 95</th>
                <th className="pb-2 pr-3 text-right">P/R 99</th>
                <th className="pb-2 pr-3 text-right">DD</th>
                <th className="pb-2 pr-3 text-right">P5</th>
                <th className="pb-2 pr-3 text-right">P/R 95</th>
                <th className="pb-2 pr-3 text-right">P/R 99</th>
                <th className="pb-2 pr-3 text-right">L1%</th>
                <th className="pb-2 pr-3 text-right">L2%</th>
                <th className="pb-2 text-right">Supp.</th>
              </tr>
            </thead>
            <tbody>
              {comparisons.map((c, i) => {
                const ddImproved = c.withBreaker.maxDD < c.noBreaker.maxDD;
                const p5Improved = c.withBreaker.cumP5 > c.noBreaker.cumP5;
                const diag = c.withBreaker.diagnostics;

                return (
                  <tr key={i} className="border-b last:border-0">
                    <td className="py-2 pr-4 font-medium">{c.scenarioName}</td>
                    {/* No breaker */}
                    <td className="py-2 pr-3 text-right font-mono">{fmt(c.noBreaker.maxDD)}</td>
                    <td className={`py-2 pr-3 text-right font-mono ${c.noBreaker.cumP5 < 0 ? 'text-destructive' : ''}`}>{fmt(c.noBreaker.cumP5)}</td>
                    <td className={`py-2 pr-3 text-right font-mono ${c.noBreaker.payRevP95 > 0.45 ? 'text-destructive' : ''}`}>{pct(c.noBreaker.payRevP95)}</td>
                    <td className={`py-2 pr-3 text-right font-mono ${c.noBreaker.payRevP99 > 0.60 ? 'text-destructive' : ''}`}>{pct(c.noBreaker.payRevP99)}</td>
                    {/* With breaker */}
                    <td className={`py-2 pr-3 text-right font-mono ${ddImproved ? 'text-success' : ''}`}>{fmt(c.withBreaker.maxDD)}</td>
                    <td className={`py-2 pr-3 text-right font-mono ${p5Improved ? 'text-success' : c.withBreaker.cumP5 < 0 ? 'text-destructive' : ''}`}>{fmt(c.withBreaker.cumP5)}</td>
                    <td className={`py-2 pr-3 text-right font-mono ${c.withBreaker.payRevP95 < c.noBreaker.payRevP95 ? 'text-success' : ''}`}>{pct(c.withBreaker.payRevP95)}</td>
                    <td className="py-2 pr-3 text-right font-mono">{pct(c.withBreaker.payRevP99)}</td>
                    {/* Breaker activity */}
                    <td className="py-2 pr-3 text-right font-mono">{pct(diag.timeInL1Pct)}</td>
                    <td className={`py-2 pr-3 text-right font-mono ${diag.timeInL2Pct > 0.10 ? 'text-destructive font-bold' : diag.timeInL2Pct > 0.02 ? 'text-warning' : ''}`}>
                      {pct(diag.timeInL2Pct)}
                    </td>
                    <td className="py-2 text-right font-mono">
                      {Math.round(diag.avgPayoutsSuppressedPerIteration)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Summary badges */}
        <div className="flex flex-wrap gap-2">
          {comparisons.map((c, i) => {
            const diag = c.withBreaker.diagnostics;
            return (
              <div key={i} className="flex items-center gap-1.5 text-xs">
                <Badge variant="outline">{c.scenarioName}</Badge>
                <span className="text-muted-foreground">
                  L1: {pct(diag.timeInL1Pct)} · L2: {pct(diag.timeInL2Pct)} · 
                  Max consec L2: {diag.maxConsecutiveL2Months}mo · 
                  Iters w/ breaker: {diag.iterationsWithAnyBreaker}
                </span>
              </div>
            );
          })}
        </div>

        <div className="rounded-lg bg-muted/50 p-3 text-xs text-muted-foreground">
          <strong>Reading this table:</strong> If DD and P5 improve with breakers AND L2% is low (&lt;5%), 
          breakers are a real stabilizer. If L2% is high (&gt;20%) or payouts suppressed are large, 
          breakers are "buying time" — the product experience degrades under sustained stress.
        </div>
      </CardContent>
    </Card>
  );
}
