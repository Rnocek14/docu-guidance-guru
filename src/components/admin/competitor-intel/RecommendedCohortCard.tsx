import { useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ArrowRight, Lock, Sparkles } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { supabase } from '@/integrations/supabase/client';
import { recommendCohort, type TierId, type RecommendationRow } from '@/lib/competitor-recommendation';
import type { SnapshotInput } from '@/lib/competitor-comparison';

const TIERS: TierId[] = ['starter', 'pro', 'elite'];

function formatValue(v: number | null, format: RecommendationRow['format']): string {
  if (v == null) return '—';
  if (format === 'usd') return `$${Math.round(v).toLocaleString('en-US')}`;
  if (format === 'pct') return `${v.toFixed(v % 1 === 0 ? 0 : 1)}%`;
  return `${v}d`;
}

export function RecommendedCohortCard({ snapshots }: { snapshots: SnapshotInput[] }) {
  const [tierId, setTierId] = useState<TierId>('starter');
  const [modalOpen, setModalOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const { toast } = useToast();

  const rec = useMemo(() => recommendCohort(tierId, snapshots), [tierId, snapshots]);

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

  const noData = rec.sourceFirms.length === 0;

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
              No competitor snapshots match the {rec.accountSize.toLocaleString()} bucket. The solvent
              column falls back to your current config — re-run scrapes to get a real recommendation.
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
                          {r.medianSource}
                          {r.sampleSize > 0 && ` · n=${r.sampleSize}`}
                        </TooltipContent>
                      </Tooltip>
                    </td>
                    <td className="bg-primary/5 px-3 py-2">
                      <div className="flex items-center gap-1.5 text-primary">
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
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-3">
            <div className="text-xs text-muted-foreground">
              {rec.sourceFirms.length > 0
                ? `Based on ${rec.sourceFirms.length} firm(s): ${rec.sourceFirms.join(', ')}`
                : 'No comparable competitor data in this bucket.'}
            </div>
            <Button size="sm" onClick={() => setModalOpen(true)} disabled={noData}>
              Preview as draft cohort
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
          <pre className="max-h-[400px] overflow-auto rounded-md border border-border bg-muted/30 p-3 text-xs">
            {JSON.stringify(rec.proposedCohort, null, 2)}
          </pre>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setModalOpen(false)} disabled={submitting}>
              Cancel
            </Button>
            <Button onClick={handleApply} disabled={submitting}>
              {submitting ? 'Creating…' : 'Create draft cohort'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </TooltipProvider>
  );
}
