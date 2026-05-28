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

/** Account-size buckets used to match competitor pricing rows per tier. */
const TIER_BUCKETS: Record<TierId, { target: number; min: number; max: number }> = {
  starter: { target: 50_000, min: 25_000, max: 75_000 },
  pro: { target: 100_000, min: 75_001, max: 125_000 },
  elite: { target: 200_000, min: 125_001, max: 300_000 },
};

/** Solvency floors derived from current `TIER_ECONOMICS` — cannot drop below these. */
const SOLVENCY_FLOORS: Record<TierId, { splitPct: number; firstPayoutCap: number }> = {
  starter: { splitPct: 80, firstPayoutCap: 500 },
  pro: { splitPct: 80, firstPayoutCap: 750 },
  elite: { splitPct: 80, firstPayoutCap: 1000 },
};

export interface RecommendationRow {
  field: string;
  label: string;
  format: 'usd' | 'pct' | 'days';
  current: number | null;
  median: number | null;
  solvent: number | null;
  sampleSize: number;
  clamped: boolean;
  clampReason?: string;
  medianSource?: string;
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

/** Snapshots whose rules.account_size_usd falls inside the tier bucket. */
function snapshotsInBucket(snapshots: SnapshotInput[], tierId: TierId): SnapshotInput[] {
  const bucket = TIER_BUCKETS[tierId];
  return snapshots.filter((s) => {
    const sz = s.payload?.rules?.account_size_usd;
    return sz != null && sz >= bucket.min && sz <= bucket.max;
  });
}

// ─── Main API ────────────────────────────────────────────────────────────

export function recommendCohort(
  tierId: TierId,
  comparableSnapshots: SnapshotInput[],
): CohortRecommendation {
  const tier = tierFromTiers(tierId);
  const bucket = TIER_BUCKETS[tierId];
  const floors = SOLVENCY_FLOORS[tierId];

  const inBucket = snapshotsInBucket(comparableSnapshots, tierId);
  const sourceFirms = inBucket.map((s) => s.firm_name);
  const sourceSnapshotIds = inBucket.map((s) => `${s.firm_id}@${s.captured_at}`);
  const medianSrc =
    sourceFirms.length > 0
      ? `Median of ${sourceFirms.join(', ')} (${bucket.target / 1000}K)`
      : 'No competitor data in this account-size bucket';

  // Per-field median + clamp definitions
  const profitTargetPctMedian = median(
    inBucket.map((s) => {
      const tgt = s.payload?.rules?.profit_target_usd;
      const sz = s.payload?.rules?.account_size_usd;
      return tgt != null && sz ? (tgt / sz) * 100 : null;
    }),
  );
  const dailyLossPctMedian = median(
    inBucket.map((s) => {
      const v = s.payload?.rules?.daily_loss_usd;
      const sz = s.payload?.rules?.account_size_usd;
      // Trailing-only firms genuinely have no daily-loss rule — exclude from median.
      return v != null && sz ? (v / sz) * 100 : null;
    }),
  );
  const maxDrawdownPctMedian = median(
    inBucket.map((s) => {
      const v = s.payload?.rules?.max_drawdown_usd;
      const sz = s.payload?.rules?.account_size_usd;
      return v != null && sz ? (v / sz) * 100 : null;
    }),
  );
  const splitMedian = median(inBucket.map((s) => s.payload?.rules?.payout_split_pct));
  const firstCapMedian = median(inBucket.map((s) => s.payload?.rules?.first_payout_cap_usd));
  const cooldownMedian = median(inBucket.map((s) => s.payload?.rules?.payout_cadence_days));
  const resetMedian = median(inBucket.map((s) => s.payload?.rules?.reset_fee_usd));
  const entryMedian = median(inBucket.map((s) => pickPriceForTier(s, tierId)));

  const sampleCount = inBucket.length;

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
    rows.push({
      field,
      label,
      format,
      current,
      median: medianValue,
      solvent,
      sampleSize: sampleCount,
      clamped,
      clampReason,
      medianSource: medianSrc,
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
    `Cannot drop below ${floors.splitPct}% — current solvency floor (see tier-economics.ts).`,
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
    `Cannot drop below $${floors.firstPayoutCap} — current solvency floor.`,
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
  const resetFee = row(
    'reset_fee',
    'Reset fee',
    'usd',
    tier.resetFee,
    resetMedian,
    50,
    99,
    'Cannot drop below $50 — margin floor.',
    'Cap at $99 — pricing parity ceiling.',
  );

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
  // Silence unused warnings — reset fee is intentionally not part of the cohort row
  // (it lives on a separate reset-bundles SSOT), but it's surfaced in the table.
  void resetFee;

  return {
    tierId,
    tierName: tier.name,
    accountSize: tier.accountSizeNum,
    rows,
    proposedCohort,
    sourceSnapshotIds,
    sourceFirms,
  };
}

export const _internal = { median, clamp, TIER_BUCKETS, SOLVENCY_FLOORS };
