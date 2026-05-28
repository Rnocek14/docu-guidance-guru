import { useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ArrowRight, CheckCircle2, Info, Lock, Sparkles } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { supabase } from '@/integrations/supabase/client';
import { MIN_SAMPLE_SIZE, recommendCohort, type TierId, type RecommendationRow, type RulesByFirmSize } from '@/lib/competitor-recommendation';
import type { SnapshotInput } from '@/lib/competitor-comparison';

const TIERS: TierId[] = ['starter', 'pro', 'elite'];

function formatValue(v: number | null, format: RecommendationRow['format']): string {
  if (v == null) return '—';
  if (format === 'usd') return `$${Math.round(v).toLocaleString('en-US')}`;
  if (format === 'pct') return `${v.toFixed(v % 1 === 0 ? 0 : 1)}%`;
  return `${v}d`;
}

export function RecommendedCohortCard({
  snapshots,
  rulesByFirmSize,
}: {
  snapshots: SnapshotInput[];
  rulesByFirmSize?: RulesByFirmSize;
}) {
  const [tierId, setTierId] = useState<TierId>('starter');
  const [modalOpen, setModalOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const { toast } = useToast();

  const rec = useMemo(
    () => recommendCohort(tierId, snapshots, rulesByFirmSize),
    [tierId, snapshots, rulesByFirmSize],
  );

  async function handleApply() {
    setSubmitting(true);
    try {
      const { data, error } = await supabase.functions.invoke('recommend-cohort-draft', {
        body: {
          tier_id: rec.tierId,
          proposed_cohort: rec.proposedCohort,
          source_snapshot_ids: rec.sourceSnapshotIds,
          source_firms: rec.sourceFirms,
        },
      });
      if (error) throw error;
      toast({
        title: 'Draft cohort created',
        description: `Review it in Cohorts Management before activating.`,
      });
      setModalOpen(false);
    } catch (err) {
      toast({
        title: 'Could not create draft cohort',
        description: err instanceof Error ? err.message : 'Unknown error',
        variant: 'destructive',
      });
    } finally {
      setSubmitting(false);
    }
  }

  const sampleN = rec.sourceFirms.length;
  const noData = sampleN === 0;
  const insufficient = rec.status === 'insufficient_data';
  const noChange = rec.status === 'no_change';
  const canApply = rec.status === 'ok';

  return (
    <TooltipProvider delayDuration={150}>
      <Card>
        <CardHeader className="py-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2 text-sm">
                <Sparkles className="h-4 w-4 text-primary" />
                Recommended cohort
              </CardTitle>
              <p className="mt-1 text-xs text-muted-foreground">
                Median = pure positioning. Solvent = median clamped by your reserve / cohort floors.
              </p>
            </div>
            <div className="flex gap-1 rounded-md border border-border bg-card/40 p-0.5">
              {TIERS.map((t) => (
                <button
                  key={t}
                  onClick={() => setTierId(t)}
                  className={`rounded px-3 py-1 text-xs font-medium capitalize transition ${
                    tierId === t
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3 p-0">
          {noData && (
            <div className="mx-4 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-xs text-amber-200">
              No competitor snapshots match the {rec.accountSize.toLocaleString()} bucket. Re-run scrapes to get a real recommendation.
            </div>
          )}
          {insufficient && (
            <div className="mx-4 flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-xs text-amber-200">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <div>
                Insufficient data: only {sampleN} comparable firm{sampleN === 1 ? '' : 's'} in this bucket (need ≥{MIN_SAMPLE_SIZE}).
                Medians off a tiny sample are noise, not signal. Recommendation disabled.
              </div>
            </div>
          )}
          {noChange && (
            <div className="mx-4 flex items-start gap-2 rounded-md border border-emerald-500/40 bg-emerald-500/5 p-3 text-xs text-emerald-300">
              <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <div>
                You're already inside the competitive band on every field. No cohort change recommended.
              </div>
            </div>
          )}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead className="text-left text-xs uppercase text-muted-foreground">
                <tr className="border-b border-border">
                  <th className="px-4 py-2">Field</th>
                  <th className="px-3 py-2">Your current</th>
                  <th className="px-3 py-2">Match the median</th>
                  <th className="px-3 py-2 text-primary">Competitive &amp; solvent</th>
                </tr>
              </thead>
              <tbody>
                {rec.rows.map((r) => (
                  <tr key={r.field} className="border-b border-border/40">
                    <td className="px-4 py-2 font-medium">{r.label}</td>
                    <td className="px-3 py-2 text-muted-foreground">{formatValue(r.current, r.format)}</td>
                    <td className="px-3 py-2">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="cursor-help underline decoration-dotted decoration-muted-foreground/40 underline-offset-4">
                            {formatValue(r.median, r.format)}
                          </span>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="max-w-xs text-xs">
                          <div>{r.medianSource}{r.sampleSize > 0 ? ` · n=${r.sampleSize}` : ''}</div>
                          {r.exclusionNote && (
                            <div className="mt-1 text-amber-300">{r.exclusionNote}</div>
                          )}
                        </TooltipContent>
                      </Tooltip>
                    </td>
                    <td className="bg-primary/5 px-3 py-2">
                      <div className={`flex items-center gap-1.5 ${r.changed ? 'text-primary' : 'text-muted-foreground'}`}>
                        <span className="font-medium">{formatValue(r.solvent, r.format)}</span>
                        {r.clamped && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Lock className="h-3 w-3 cursor-help text-amber-400" />
                            </TooltipTrigger>
                            <TooltipContent side="top" className="max-w-xs text-xs">
                              {r.clampReason}
                            </TooltipContent>
                          </Tooltip>
                        )}
                        {r.changed && !r.clamped && (
                          <Badge variant="outline" className="h-4 px-1 text-[10px]">Δ</Badge>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-3">
            <div className="text-xs text-muted-foreground">
              {sampleN > 0
                ? `Based on n=${sampleN}: ${rec.sourceFirms.join(', ')}`
                : 'No comparable competitor data in this bucket.'}
            </div>
            <Button size="sm" onClick={() => setModalOpen(true)} disabled={!canApply}>
              Preview {rec.changedFields.length} change{rec.changedFields.length === 1 ? '' : 's'}
              <ArrowRight className="ml-1 h-3 w-3" />
            </Button>
          </div>
        </CardContent>
      </Card>

      <Dialog open={modalOpen} onOpenChange={setModalOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Create draft cohort</DialogTitle>
            <DialogDescription>
              Inserts a dormant row into <code>cohorts</code> (<Badge variant="outline" className="ml-1">is_active=false</Badge>{' '}
              <Badge variant="outline">intake_active=false</Badge>). Nothing live changes until you activate it in Cohorts Management.
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[400px] overflow-auto rounded-md border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/30 text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-3 py-2">Field</th>
                  <th className="px-3 py-2">Current</th>
                  <th className="px-3 py-2"></th>
                  <th className="px-3 py-2">Proposed</th>
                </tr>
              </thead>
              <tbody>
                {rec.rows.filter((r) => r.changed).map((r) => (
                  <tr key={r.field} className="border-t border-border/40">
                    <td className="px-3 py-2 font-medium">{r.label}</td>
                    <td className="px-3 py-2 text-muted-foreground">{formatValue(r.current, r.format)}</td>
                    <td className="px-3 py-2 text-muted-foreground">→</td>
                    <td className="px-3 py-2 font-medium text-primary">{formatValue(r.solvent, r.format)}</td>
                  </tr>
                ))}
                {rec.rows.filter((r) => r.changed).length === 0 && (
                  <tr><td colSpan={4} className="px-3 py-3 text-xs text-muted-foreground">No field changes.</td></tr>
                )}
              </tbody>
            </table>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setModalOpen(false)} disabled={submitting}>
              Cancel
            </Button>
            <Button onClick={handleApply} disabled={submitting || !canApply}>
              {submitting ? 'Creating…' : 'Create draft cohort'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </TooltipProvider>
  );
}
