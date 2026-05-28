import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { CheckCircle2, DollarSign, Minus, AlertTriangle } from 'lucide-react';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import type { SnapshotInput } from '@/lib/competitor-comparison';
import { _internal, MIN_SAMPLE_SIZE, type TierId, type RulesByFirmSize } from '@/lib/competitor-recommendation';

const { TIER_BUCKETS } = _internal;

const TIERS: { id: TierId; label: string; target: number }[] = [
  { id: 'starter', label: 'Starter (50K)', target: 50_000 },
  { id: 'pro', label: 'Pro (100K)', target: 100_000 },
  { id: 'elite', label: 'Elite (200K)', target: 200_000 },
];

/** Parse account-size labels like "50K", "100,000", "25k", "$50K" → USD. */
function parseSize(label?: string | null): number | null {
  if (!label) return null;
  const cleaned = label.toLowerCase().replace(/[\s,$]/g, '');
  const m = cleaned.match(/(\d+(?:\.\d+)?)(k|m)?/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  const mult = m[2] === 'm' ? 1_000_000 : m[2] === 'k' ? 1_000 : n < 1000 ? 1_000 : 1;
  return Math.round(n * mult);
}

function inBucket(size: number, tier: TierId): boolean {
  const b = TIER_BUCKETS[tier];
  return size >= b.min && size <= b.max;
}

type Coverage = 'rules' | 'price' | 'none';

function coverage(
  snap: SnapshotInput,
  tier: TierId,
  rulesByFirmSize?: RulesByFirmSize,
): Coverage {
  // Prefer the new per-(firm, size) rules table when available.
  const sizes = Object.keys(rulesByFirmSize?.[snap.firm_id] ?? {})
    .map((k) => Number(k))
    .filter((n) => Number.isFinite(n));
  if (sizes.some((s) => inBucket(s, tier))) return 'rules';
  // Legacy fallback: snapshot's single bundled rules row.
  const rulesSize = snap.payload?.rules?.account_size_usd ?? null;
  if (rulesSize != null && inBucket(rulesSize, tier)) return 'rules';
  const sizes = (snap.payload?.pricing ?? [])
    .map((p) => parseSize(p.account_size_label))
    .filter((n): n is number => n != null);
  if (sizes.some((s) => inBucket(s, tier))) return 'price';
  return 'none';
}

export function ScraperCoverageCard({
  snapshots,
  rulesByFirmSize,
}: {
  snapshots: SnapshotInput[];
  rulesByFirmSize?: RulesByFirmSize;
}) {
  const rows = snapshots.map((s) => ({
    snap: s,
    cells: TIERS.map((t) => ({ tier: t.id, status: coverage(s, t.id, rulesByFirmSize) })),
  }));

  const tierCounts = TIERS.map((t) => ({
    id: t.id,
    label: t.label,
    rulesCount: rows.filter((r) => r.cells.find((c) => c.tier === t.id)?.status === 'rules').length,
    priceOnly: rows.filter((r) => r.cells.find((c) => c.tier === t.id)?.status === 'price').length,
  }));

  return (
    <Card>
      <CardHeader className="py-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <AlertTriangle className="h-4 w-4 text-amber-400" />
          Scraper coverage by tier bucket
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Each firm is scraped at only one account size (whichever page the scraper landed on).
          Cells show whether <b>full rules</b> were captured at that size, or only the{' '}
          <b>price row</b>, or nothing. Recommendations need ≥ {MIN_SAMPLE_SIZE} rules-cells per tier.
        </p>
      </CardHeader>
      <CardContent className="space-y-3 overflow-x-auto p-0">
        <TooltipProvider delayDuration={150}>
          <table className="w-full min-w-[520px] text-sm">
            <thead className="text-left text-xs uppercase text-muted-foreground">
              <tr className="border-b border-border">
                <th className="px-4 py-2">Firm</th>
                <th className="px-3 py-2">Scraped @</th>
                {TIERS.map((t) => (
                  <th key={t.id} className="px-3 py-2 text-center">
                    {t.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(({ snap, cells }) => {
                const sz = snap.payload?.rules?.account_size_usd;
                return (
                  <tr key={snap.firm_id} className="border-b border-border/40">
                    <td className="px-4 py-2 font-medium">{snap.firm_name}</td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      {sz ? `$${(sz / 1000).toFixed(0)}K` : <span className="text-rose-400">missing</span>}
                    </td>
                    {cells.map((c) => (
                      <td key={c.tier} className="px-3 py-2 text-center">
                        <CoverageCell status={c.status} />
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="border-t border-border bg-card/40 text-xs">
                <td className="px-4 py-2 font-medium" colSpan={2}>
                  Rules-cells per tier
                </td>
                {tierCounts.map((t) => {
                  const ok = t.rulesCount >= MIN_SAMPLE_SIZE;
                  return (
                    <td key={t.id} className="px-3 py-2 text-center">
                      <Badge
                        variant="outline"
                        className={
                          ok
                            ? 'border-emerald-500/40 text-emerald-300'
                            : 'border-rose-500/40 text-rose-300'
                        }
                      >
                        {t.rulesCount} / {MIN_SAMPLE_SIZE}
                      </Badge>
                      {t.priceOnly > 0 && (
                        <div className="mt-1 text-[10px] text-muted-foreground">
                          +{t.priceOnly} price-only
                        </div>
                      )}
                    </td>
                  );
                })}
              </tr>
            </tfoot>
          </table>
        </TooltipProvider>

        <div className="flex flex-wrap gap-3 px-4 pb-3 text-xs text-muted-foreground">
          <Legend status="rules" label="Full rules captured at a size in this bucket" />
          <Legend status="price" label="Price-only (rules not extracted at this size — re-scrape needed)" />
          <Legend status="none" label="No coverage in this bucket" />
        </div>
      </CardContent>
    </Card>
  );
}

function CoverageCell({ status }: { status: Coverage }) {
  if (status === 'rules') {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <CheckCircle2 className="mx-auto h-4 w-4 text-emerald-400" />
        </TooltipTrigger>
        <TooltipContent>Full rules captured at a size inside this bucket.</TooltipContent>
      </Tooltip>
    );
  }
  if (status === 'price') {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <DollarSign className="mx-auto h-4 w-4 text-amber-400" />
        </TooltipTrigger>
        <TooltipContent>
          Pricing page lists this size, but rules weren't extracted. Re-scrape pointing the firm's URL at this account-size page.
        </TooltipContent>
      </Tooltip>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Minus className="mx-auto h-4 w-4 text-muted-foreground" />
      </TooltipTrigger>
      <TooltipContent>Firm doesn't offer this size, or scraper has no signal of it.</TooltipContent>
    </Tooltip>
  );
}

function Legend({ status, label }: { status: Coverage; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <CoverageCell status={status} />
      <span>{label}</span>
    </span>
  );
}
