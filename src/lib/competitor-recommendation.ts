/**
 * Cohort recommendation engine.
 *
 * Pure functions. Given competitor snapshots and our current tier, produce
 *  - "match the median" config (pure positioning)
 *  - "competitive & solvent" config (median clamped by solvency floors)
 *
 * Each clamped value carries the reason so the UI can defend every number.
 * No Monte Carlo at render time — floors are static constants sourced from
 * `tier-economics.ts` / `pricing-data.ts` so they cannot drift.
 */

import { TIERS, type PricingTier } from './pricing-data';
import type { SnapshotInput } from './competitor-comparison';

export type TierId = 'starter' | 'pro' | 'elite';

/**
 * Per-(firm, account-size) rules row. Comes from `competitor_firm_rules`
 * (one row per size we've scraped). When provided to `recommendCohort`,
 * the engine matches each firm's rules at a size inside the tier bucket
 * instead of relying on whatever single size the snapshot happened to
 * scrape. Pro and Elite tiers were starving for samples without this.
 */
export type CompetitorRules = NonNullable<SnapshotInput['payload']['rules']>;
export type RulesByFirmSize = Record<string, Record<number, CompetitorRules>>;

/** Account-size buckets used to match competitor pricing rows per tier. */
const TIER_BUCKETS: Record<TierId, { target: number; min: number; max: number }> = {
  starter: { target: 50_000, min: 25_000, max: 75_000 },
  pro: { target: 100_000, min: 75_001, max: 125_000 },
  elite: { target: 200_000, min: 125_001, max: 300_000 },
};

/**
 * NOTE: These are NOT Monte-Carlo–derived solvency floors. They are the
 * *current* `TIER_ECONOMICS` values, used as "do not loosen below today"
 * guards until a real MC-derived floor table lands. Tooltip copy must say
 * "current floor", not "solvency floor", to avoid implying false rigor.
 * TODO(meridian): replace with `monte-carlo.ts` ruin-probability lookups.
 */
const CURRENT_FLOORS: Record<TierId, { splitPct: number; firstPayoutCap: number }> = {
  starter: { splitPct: 80, firstPayoutCap: 500 },
  pro: { splitPct: 80, firstPayoutCap: 750 },
  elite: { splitPct: 80, firstPayoutCap: 1000 },
};

/** Minimum competitor snapshots required before we publish a numeric recommendation. */
export const MIN_SAMPLE_SIZE = 3;
/** % drift below which a field is considered "no meaningful change". */
const NO_CHANGE_EPSILON = 0.5;

export interface RecommendationRow {
  field: string;
  label: string;
  format: 'usd' | 'pct' | 'days';
  current: number | null;
  median: number | null;
  solvent: number | null;
  sampleSize: number;
  /** Firms in the tier bucket (denominator for sampleSize). */
  totalFirms: number;
  clamped: boolean;
  clampReason?: string;
  medianSource?: string;
  /** Optional note explaining excluded snapshots (e.g. trailing-only firms). */
  exclusionNote?: string;
  /** Whether the solvent value differs meaningfully from current. */
  changed?: boolean;
}

export interface ProposedCohort {
  tier_id: TierId;
  name: string;
  cohort_phase: 'performance';
  entry_fee: number;
  profit_target_percent: number;
  max_daily_loss_percent: number;
  max_total_drawdown_percent: number;
  min_trading_days: number;
  payout_split_percent: number;
  first_payout_cap_amount: number;
  lifetime_cap_multiple: number;
  payout_cooldown_days: number;
  description: string;
}

export interface CohortRecommendation {
  tierId: TierId;
  tierName: string;
  accountSize: number;
  rows: RecommendationRow[];
  proposedCohort: ProposedCohort;
  sourceSnapshotIds: string[];
  sourceFirms: string[];
  /** Overall recommendation state. Drives UI banner + button enable. */
  status: 'ok' | 'insufficient_data' | 'no_change';
  /** Fields where solvent differs meaningfully from current. */
  changedFields: string[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function median(values: Array<number | null | undefined>): number | null {
  const xs = values
    .filter((v): v is number => v != null && Number.isFinite(v))
    .slice()
    .sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

/**
 * Treat 0 / negative as missing for fields where 0 is structurally not a
 * real rule (a scrape miss almost always shows up as 0 or null). Without
 * this, a handful of junk zeros drag the cohort median toward zero and
 * the recommendation tells you to drop your daily-loss / drawdown /
 * split to absurd levels.
 */
function nonZeroOrNull(v: number | null | undefined): number | null {
  if (v == null || !Number.isFinite(v) || v <= 0) return null;
  return v;
}

function clamp(value: number, lo: number | null, hi: number | null): { v: number; clamped: 'lo' | 'hi' | null } {
  if (lo != null && value < lo) return { v: lo, clamped: 'lo' };
  if (hi != null && value > hi) return { v: hi, clamped: 'hi' };
  return { v: value, clamped: null };
}

function tierFromTiers(tierId: TierId): PricingTier {
  return TIERS.find((t) => t.id === tierId) ?? TIERS[0];
}

/** Pick the pricing row whose account size best matches a tier bucket. */
function pickPriceForTier(snap: SnapshotInput, tierId: TierId): number | null {
  const bucket = TIER_BUCKETS[tierId];
  const rows = snap.payload?.pricing ?? [];
  // Try label match first
  const targetK = `${bucket.target / 1000}k`;
  for (const r of rows) {
    const l = (r.account_size_label ?? '').toLowerCase().replace(/[\s,$]/g, '');
    if (l.includes(targetK)) {
      return r.promo_price_usd ?? r.list_price_usd ?? null;
    }
  }
  return null;
}

/**
 * Build the per-tier comparable set.
 *
 * When `rulesByFirmSize` is provided we pick, for each firm, the rules row
 * whose `account_size_usd` falls inside the tier bucket — closest to the
 * tier target — and stitch that into a synthetic snapshot (keeping the
 * firm's pricing array intact). Without the map we fall back to the legacy
 * "use whatever size the single snapshot happens to be" behavior.
 */
function snapshotsInBucket(
  snapshots: SnapshotInput[],
  tierId: TierId,
  rulesByFirmSize?: RulesByFirmSize,
): SnapshotInput[] {
  const bucket = TIER_BUCKETS[tierId];
  if (rulesByFirmSize) {
    const out: SnapshotInput[] = [];
    for (const s of snapshots) {
      const byCount = rulesByFirmSize[s.firm_id];
      if (!byCount) continue;
      // Pick the size in this bucket closest to the tier target.
      let bestSize: number | null = null;
      let bestDist = Infinity;
      for (const k of Object.keys(byCount)) {
        const sz = Number(k);
        if (!Number.isFinite(sz) || sz < bucket.min || sz > bucket.max) continue;
        const d = Math.abs(sz - bucket.target);
        if (d < bestDist) {
          bestDist = d;
          bestSize = sz;
        }
      }
      if (bestSize == null) continue;
      const rules = byCount[bestSize];
      out.push({
        ...s,
        payload: {
          ...s.payload,
          rules: { ...rules, account_size_usd: bestSize },
        },
      });
    }
    return out;
  }
  return snapshots.filter((s) => {
    const sz = s.payload?.rules?.account_size_usd;
    return sz != null && sz >= bucket.min && sz <= bucket.max;
  });
}

// ─── Main API ────────────────────────────────────────────────────────────

export function recommendCohort(
  tierId: TierId,
  comparableSnapshots: SnapshotInput[],
  rulesByFirmSize?: RulesByFirmSize,
): CohortRecommendation {
  const tier = tierFromTiers(tierId);
  const bucket = TIER_BUCKETS[tierId];
  const floors = CURRENT_FLOORS[tierId];

  const inBucket = snapshotsInBucket(comparableSnapshots, tierId, rulesByFirmSize);
  const sourceFirms = inBucket.map((s) => s.firm_name);
  const sourceSnapshotIds = inBucket.map((s) => `${s.firm_id}@${s.captured_at}`);
  const medianSrc =
    sourceFirms.length > 0
      ? `Median of ${sourceFirms.join(', ')} (${bucket.target / 1000}K)`
      : 'No competitor data in this account-size bucket';

  // Per-field median + clamp definitions
  const totalFirms = inBucket.length;

  // Build per-field value arrays so we can derive both median and an
  // honest per-field sample count (after dropping implausible zeros).
  const profitTargetPctValues = inBucket.map((s) => {
    const tgt = nonZeroOrNull(s.payload?.rules?.profit_target_usd);
    const sz = s.payload?.rules?.account_size_usd;
    return tgt != null && sz ? (tgt / sz) * 100 : null;
  });
  const dailyLossPctValues = inBucket.map((s) => {
    const v = nonZeroOrNull(s.payload?.rules?.daily_loss_usd);
    const sz = s.payload?.rules?.account_size_usd;
    return v != null && sz ? (v / sz) * 100 : null;
  });
  const maxDrawdownPctValues = inBucket.map((s) => {
    const v = nonZeroOrNull(s.payload?.rules?.max_drawdown_usd);
    const sz = s.payload?.rules?.account_size_usd;
    return v != null && sz ? (v / sz) * 100 : null;
  });
  const splitValues = inBucket.map((s) => nonZeroOrNull(s.payload?.rules?.payout_split_pct));
  const firstCapValues = inBucket.map((s) => nonZeroOrNull(s.payload?.rules?.first_payout_cap_usd));
  // Cooldown of 0d (instant payouts) is valid — keep zeros.
  const cooldownValues = inBucket.map((s) => {
    const v = s.payload?.rules?.payout_cadence_days;
    return v != null && Number.isFinite(v) && v >= 0 ? v : null;
  });
  // Reset fee of $0 (free reset) is a real product choice — keep zeros.
  const resetValues = inBucket.map((s) => {
    const v = s.payload?.rules?.reset_fee_usd;
    return v != null && Number.isFinite(v) && v >= 0 ? v : null;
  });
  const entryValues = inBucket.map((s) => nonZeroOrNull(pickPriceForTier(s, tierId)));

  const profitTargetPctMedian = median(profitTargetPctValues);
  const dailyLossPctMedian = median(dailyLossPctValues);
  const maxDrawdownPctMedian = median(maxDrawdownPctValues);
  const splitMedian = median(splitValues);
  const firstCapMedian = median(firstCapValues);
  const cooldownMedian = median(cooldownValues);
  const resetMedian = median(resetValues);
  const entryMedian = median(entryValues);

  const countUsable = (arr: Array<number | null>) =>
    arr.filter((v) => v != null && Number.isFinite(v)).length;

  function coverageNote(usable: number, fieldName: string): string | undefined {
    if (totalFirms === 0 || usable === totalFirms) return undefined;
    if (usable * 2 >= totalFirms) return undefined;
    return `Only ${usable} of ${totalFirms} firms in this bucket publish ${fieldName} — median may not be representative.`;
  }

  const sampleCount = totalFirms;
  const insufficient = sampleCount > 0 && sampleCount < MIN_SAMPLE_SIZE;

  // Build rows + the solvent-clamped cohort in one pass
  const rows: RecommendationRow[] = [];

  function row(
    field: string,
    label: string,
    format: 'usd' | 'pct' | 'days',
    current: number | null,
    medianValue: number | null,
    lo: number | null,
    hi: number | null,
    loReason: string,
    hiReason: string,
    extra: { exclusionNote?: string; usableCount?: number } = {},
  ): number | null {
    let solvent: number | null = null;
    let clamped = false;
    let clampReason: string | undefined;
    if (medianValue != null) {
      const c = clamp(medianValue, lo, hi);
      solvent = c.v;
      if (c.clamped === 'lo') {
        clamped = true;
        clampReason = loReason;
      } else if (c.clamped === 'hi') {
        clamped = true;
        clampReason = hiReason;
      }
    } else if (current != null) {
      // No competitor data → keep current value as the solvent recommendation.
      solvent = current;
    }
    const changed =
      solvent != null && current != null
        ? Math.abs(solvent - current) > Math.max(NO_CHANGE_EPSILON, Math.abs(current) * 0.01)
        : false;
    rows.push({
      field,
      label,
      format,
      current,
      median: medianValue,
      solvent,
      sampleSize: extra.usableCount ?? sampleCount,
      totalFirms,
      clamped,
      clampReason,
      medianSource: medianSrc,
      exclusionNote: extra.exclusionNote,
      changed,
    });
    return solvent;
  }

  const entryFee = row(
    'entry_fee',
    'Entry fee',
    'usd',
    tier.price,
    entryMedian,
    Math.round(tier.price * 0.7),
    Math.round(tier.price * 1.2),
    'Pricing whiplash guardrail: cannot drop below 70% of current entry fee.',
    'Pricing whiplash guardrail: cannot exceed 120% of current entry fee.',
  );
  const profitTargetPct = row(
    'profit_target_percent',
    'Profit target',
    'pct',
    tier.profitTarget,
    profitTargetPctMedian,
    8,
    12,
    'Min target band: <8% is too easy to pass and breaks reserve assumptions.',
    'Max target band: >12% pushes pass rate below break-even.',
  );
  const dailyLossPct = row(
    'max_daily_loss_percent',
    'Daily loss',
    'pct',
    tier.maxDailyLoss,
    dailyLossPctMedian,
    3,
    5,
    'Cannot drop below 3% — trader churn spikes on tight intraday limits.',
    'Cannot exceed 5% — current cohort spec ceiling.',
    dailyLossExcluded > 0
      ? { exclusionNote: `${dailyLossExcluded} of ${sampleCount} firms have no daily-loss rule (trailing-only) and were excluded — median is biased toward stricter firms.` }
      : {},
  );
  const maxDrawdownPct = row(
    'max_total_drawdown_percent',
    'Max drawdown',
    'pct',
    tier.maxTotalDrawdown,
    maxDrawdownPctMedian,
    4,
    10,
    'Cannot drop below 4% — survivability collapses.',
    'Cannot exceed 10% — current cohort spec ceiling.',
  );
  const splitPct = row(
    'payout_split_percent',
    'Payout split',
    'pct',
    tier.splitPercent,
    splitMedian,
    floors.splitPct,
    95,
    `Cannot drop below ${floors.splitPct}% — current floor (today's TIER_ECONOMICS value, not MC-derived).`,
    'Cap at 95% — anything higher leaves no margin for breaker reserves.',
  );
  const firstCap = row(
    'first_payout_cap_amount',
    'First payout cap',
    'usd',
    tier.firstPayoutCap,
    firstCapMedian,
    floors.firstPayoutCap,
    tier.price * 15,
    `Cannot drop below $${floors.firstPayoutCap} — current floor (today's TIER_ECONOMICS value, not MC-derived).`,
    `Cap at 15× entry fee — beyond this, lifetime ratio breaks.`,
  );
  const cooldownDays = row(
    'payout_cooldown_days',
    'Payout cooldown',
    'days',
    tier.payoutCooldown,
    cooldownMedian,
    7,
    21,
    'Cannot drop below 7d — ops capacity floor.',
    'Cap at 21d — anything longer becomes user-hostile.',
  );
  // Reset fee intentionally omitted from this table: it lives on the
  // `reset-bundles.ts` SSOT, not the `cohorts` row, so a recommendation
  // here would be cosmetic and misleading. Add a paired reset-bundles
  // draft tool separately if/when that's needed.
  void resetMedian;

  const todayIso = new Date().toISOString().slice(0, 10);

  const proposedCohort: ProposedCohort = {
    tier_id: tierId,
    name: `Recommended ${tier.name} — ${todayIso}`,
    cohort_phase: 'performance',
    entry_fee: entryFee ?? tier.price,
    profit_target_percent: profitTargetPct ?? tier.profitTarget,
    max_daily_loss_percent: dailyLossPct ?? tier.maxDailyLoss,
    max_total_drawdown_percent: maxDrawdownPct ?? tier.maxTotalDrawdown,
    min_trading_days: tier.minTradingDays,
    payout_split_percent: splitPct ?? tier.splitPercent,
    first_payout_cap_amount: firstCap ?? tier.firstPayoutCap,
    lifetime_cap_multiple: tier.lifetimeCapMultiple,
    payout_cooldown_days: cooldownDays ?? tier.payoutCooldown,
    description: `Recommendation derived from ${sampleCount} competitor snapshot(s) in the ${bucket.target / 1000}K bucket on ${todayIso}. Clamped to current solvency floors.`,
  };

  const changedFields = rows.filter((r) => r.changed).map((r) => r.field);
  const status: CohortRecommendation['status'] = insufficient
    ? 'insufficient_data'
    : changedFields.length === 0
      ? 'no_change'
      : 'ok';

  return {
    tierId,
    tierName: tier.name,
    accountSize: tier.accountSizeNum,
    rows,
    proposedCohort,
    sourceSnapshotIds,
    sourceFirms,
    status,
    changedFields,
  };
}

export const _internal = { median, clamp, TIER_BUCKETS, CURRENT_FLOORS };
