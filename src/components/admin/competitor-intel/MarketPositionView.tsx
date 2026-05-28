import { useEffect, useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { TrendingUp, TrendingDown, Minus, Lightbulb, ShieldAlert } from 'lucide-react';
import { TIERS } from '@/lib/pricing-data';
import {
  buildComparisonMatrix,
  scoreMeridianPosition,
  generateRecommendations,
  cellSignal,
  filterComparableSnapshots,
  type SnapshotInput,
} from '@/lib/competitor-comparison';
import { supabase } from '@/integrations/supabase/client';
import type { RulesByFirmSize, CompetitorRules } from '@/lib/competitor-recommendation';
import { RecommendedCohortCard } from './RecommendedCohortCard';
import { ScraperCoverageCard } from './ScraperCoverageCard';

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
  const { comparable, excluded } = useMemo(
    () => filterComparableSnapshots(snapshots),
    [snapshots],
  );
  const matrix = useMemo(() => buildComparisonMatrix(TIERS, comparable), [comparable]);
  const scorecard = useMemo(() => scoreMeridianPosition(matrix), [matrix]);
  const recs = useMemo(() => generateRecommendations(matrix, scorecard), [matrix, scorecard]);

  // Per-(firm, size) rules powering Pro/Elite tier recommendations.
  // Falls back to legacy snapshot.rules when this map is empty.
  const [rulesByFirmSize, setRulesByFirmSize] = useState<RulesByFirmSize>({});
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from('competitor_firm_rules')
        .select('firm_id, account_size_usd, rules');
      if (cancelled || error || !data) return;
      const map: RulesByFirmSize = {};
      for (const row of data) {
        const firm = row.firm_id as string;
        const size = row.account_size_usd as number;
        const rules = (row.rules ?? {}) as CompetitorRules;
        if (!map[firm]) map[firm] = {};
        map[firm][size] = rules;
      }
      setRulesByFirmSize(map);
    })();
    return () => { cancelled = true; };
  }, []);

  if (snapshots.length === 0) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-sm text-muted-foreground">
          No competitor snapshots yet — run a scrape first to unlock market position analysis.
        </CardContent>
      </Card>
    );
  }

  if (comparable.length === 0) {
    return (
      <div className="space-y-4">
        <Card className="border-amber-500/40 bg-amber-500/5">
          <CardHeader className="py-3">
            <CardTitle className="flex items-center gap-2 text-sm">
              <ShieldAlert className="h-4 w-4 text-amber-400" />
              No directly-verified futures competitors available
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-muted-foreground">
            <p>
              The market-position comparison is intentionally strict: only US-futures firms with a
              directly-verified scrape are included. Everything currently on file either targets a
              different product (CFD/forex) or fell back to curated reference values that haven&rsquo;t
              been re-verified.
            </p>
            <p>Re-run scrapes from the Firms tab to refresh verification, or update the source URLs to point at futures-specific pages.</p>
          </CardContent>
        </Card>
        {excluded.length > 0 && <ExcludedList excluded={excluded} />}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Scraper coverage — surface data gaps BEFORE trusting recommendations */}
      <ScraperCoverageCard snapshots={comparable} rulesByFirmSize={rulesByFirmSize} />

      {/* Recommended cohort */}
      <RecommendedCohortCard snapshots={comparable} rulesByFirmSize={rulesByFirmSize} />

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

      {excluded.length > 0 && <ExcludedList excluded={excluded} />}
    </div>
  );
}

function ExcludedList({
  excluded,
}: {
  excluded: ReturnType<typeof filterComparableSnapshots>['excluded'];
}) {
  return (
    <Card>
      <CardHeader className="py-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <ShieldAlert className="h-4 w-4 text-amber-400" />
          Excluded from comparison ({excluded.length})
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          These firms are on file but were dropped from the matrix to keep every number honest.
        </p>
      </CardHeader>
      <CardContent className="space-y-2">
        {excluded.map((e) => (
          <div
            key={e.firm_id}
            className="flex items-start justify-between gap-3 rounded-md border border-border/60 bg-card/40 p-3 text-sm"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="font-medium">{e.firm_name}</span>
                <Badge
                  variant="outline"
                  className={
                    e.category === 'non_futures'
                      ? 'border-purple-500/40 text-purple-300'
                      : e.category === 'unverified'
                      ? 'border-amber-500/40 text-amber-300'
                      : 'border-slate-500/40 text-slate-300'
                  }
                >
                  {e.category === 'non_futures' ? 'wrong product' : e.category === 'unverified' ? 'unverified' : 'no snapshot'}
                </Badge>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{e.reason}</p>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
