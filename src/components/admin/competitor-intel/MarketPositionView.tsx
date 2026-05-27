import { useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { TrendingUp, TrendingDown, Minus, Lightbulb } from 'lucide-react';
import { TIERS } from '@/lib/pricing-data';
import {
  buildComparisonMatrix,
  scoreMeridianPosition,
  generateRecommendations,
  cellSignal,
  type SnapshotInput,
} from '@/lib/competitor-comparison';

const SIGNAL_CLASS = {
  friendly: 'text-emerald-400',
  harsh: 'text-rose-400',
  neutral: 'text-foreground',
} as const;

const TONE_CLASS = {
  friendly: 'border-emerald-500/30 bg-emerald-500/5',
  harsh: 'border-rose-500/30 bg-rose-500/5',
  neutral: 'border-border bg-card/40',
} as const;

const PRIORITY_CLASS = {
  high: 'border-rose-500/40 text-rose-300 bg-rose-500/10',
  medium: 'border-amber-500/40 text-amber-300 bg-amber-500/10',
  low: 'border-slate-500/40 text-slate-300 bg-slate-500/10',
} as const;

export function MarketPositionView({ snapshots }: { snapshots: SnapshotInput[] }) {
  const matrix = useMemo(() => buildComparisonMatrix(TIERS, snapshots), [snapshots]);
  const scorecard = useMemo(() => scoreMeridianPosition(matrix), [matrix]);
  const recs = useMemo(() => generateRecommendations(matrix, scorecard), [matrix, scorecard]);

  if (snapshots.length === 0) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-sm text-muted-foreground">
          No competitor snapshots yet — run a scrape first to unlock market position analysis.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {/* Comparison matrix */}
      <Card>
        <CardHeader className="py-3">
          <CardTitle className="text-sm">Side-by-side comparison</CardTitle>
          <p className="text-xs text-muted-foreground">
            Green = friendlier than competitor median. Red = harsher. Based on the latest snapshot per firm.
          </p>
        </CardHeader>
        <CardContent className="overflow-x-auto p-0">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="text-left text-xs uppercase text-muted-foreground">
              <tr className="border-b border-border">
                <th className="sticky left-0 z-10 bg-card px-4 py-2">Metric</th>
                {matrix.firmOrder.map((id) => (
                  <th
                    key={id}
                    className={`px-3 py-2 ${id === 'meridian' ? 'bg-primary/5 text-primary' : ''}`}
                  >
                    {matrix.firmNames[id]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {matrix.rows.map((r) => (
                <tr key={r.key} className="border-b border-border/40">
                  <td className="sticky left-0 z-10 bg-card px-4 py-2 font-medium">{r.label}</td>
                  {matrix.firmOrder.map((id) => {
                    const c = r.cells[id];
                    const sig = id === 'meridian' ? cellSignal(r, id) : 'neutral';
                    return (
                      <td
                        key={id}
                        className={`px-3 py-2 ${id === 'meridian' ? 'bg-primary/5' : ''} ${
                          id === 'meridian' ? SIGNAL_CLASS[sig] : 'text-foreground'
                        }`}
                      >
                        <div className="flex items-baseline gap-1">
                          <span>{c?.display ?? '—'}</span>
                          {c?.qualifier && (
                            <span className="text-xs text-muted-foreground">{c.qualifier}</span>
                          )}
                        </div>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {/* Scorecard */}
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {scorecard.map((v) => {
          const Icon = v.tone === 'friendly' ? TrendingUp : v.tone === 'harsh' ? TrendingDown : Minus;
          return (
            <Card key={v.key} className={TONE_CLASS[v.tone]}>
              <CardHeader className="py-3">
                <CardTitle className="flex items-center gap-2 text-sm">
                  <Icon className="h-4 w-4" />
                  {v.title}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <p className="font-medium">{v.summary}</p>
                {v.details.length > 0 && (
                  <ul className="space-y-1 text-xs text-muted-foreground">
                    {v.details.map((d, i) => (
                      <li key={i} className="flex gap-1.5">
                        <span>•</span>
                        <span>{d}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Recommendations */}
      <Card>
        <CardHeader className="py-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Lightbulb className="h-4 w-4" />
            Strategic recommendations
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Rule-based — every recommendation cites the cells that triggered it.
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          {recs.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No high-signal gaps detected. Meridian sits within competitive range on the captured metrics.
            </p>
          ) : (
            recs.map((r) => (
              <div key={r.id} className="rounded-md border border-border bg-card/40 p-3">
                <div className="mb-1 flex items-center gap-2">
                  <Badge variant="outline" className={`text-xs ${PRIORITY_CLASS[r.priority]}`}>
                    {r.priority}
                  </Badge>
                  <span className="font-medium">{r.title}</span>
                </div>
                <p className="text-sm text-muted-foreground">{r.rationale}</p>
                {r.evidence.length > 0 && (
                  <ul className="mt-2 space-y-0.5 text-xs text-muted-foreground/80">
                    {r.evidence.map((e, i) => (
                      <li key={i} className="font-mono">› {e}</li>
                    ))}
                  </ul>
                )}
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}
