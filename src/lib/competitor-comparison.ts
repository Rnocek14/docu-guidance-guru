/**
 * Competitor comparison engine.
 *
 * Pure functions — no UI, no network. Consumes the latest snapshot per firm
 * (as fetched by /admin/intel) plus our canonical Starter tier and produces:
 *
 *   1. A normalized comparison matrix (rows × firms)
 *   2. A plain-English scorecard for where Meridian stands
 *   3. A ranked list of strategic recommendations
 *
 * Verdicts are RULE-BASED on purpose — every recommendation is traceable to
 * a specific cell, no LLM, fully auditable.
 */

import type { PricingTier } from './pricing-data';

// ─── Public types ────────────────────────────────────────────────────────

export type FirmId = string;

export interface SnapshotInput {
  firm_id: FirmId;
  firm_name: string;
  captured_at: string;
  payload: {
    pricing?: Array<{
      account_size_label?: string | null;
      list_price_usd?: number | null;
      promo_price_usd?: number | null;
    }>;
    active_promo_banner?: string | null;
    promo_code?: string | null;
    rules?: {
      profit_target_usd?: number | null;
      daily_loss_usd?: number | null;
      max_drawdown_usd?: number | null;
      drawdown_type?: string | null;
      payout_split_pct?: number | null;
      first_payout_cap_usd?: number | null;
      first_payout_cap_count?: number | null;
      min_trading_days?: number | null;
      consistency_rule_pct?: number | null;
      payout_cadence_days?: number | null;
      reset_fee_usd?: number | null;
      activation_fee_usd?: number | null;
      activation_fee_cadence?: string | null;
      phase_count?: number | null;
      accounts_allowed_max?: number | null;
      trailing_dd_lock_usd?: number | null;
      news_trading_allowed?: boolean | null;
      payout_methods?: string | null;
      scaling_plan_summary?: string | null;
      country_restrictions?: string | null;
      account_size_usd?: number | null;
    };
    _fallback_used?: string | null;
    _fetch_strategy?: string | null;
  };
}

// ─── Comparability allowlist ─────────────────────────────────────────────
//
// Meridian is a US-style FUTURES prop firm. Only futures firms with
// directly-verified scrapes are apples-to-apples competitors. Anything else
// (CFD/forex products, curated-reference fallbacks) gets dropped from the
// comparison matrix so we never publish a misleading number.

/** Firm IDs whose primary product line is US futures and is comparable to Meridian. */
export const FUTURES_FIRM_IDS = new Set<FirmId>([
  'apex',
  'topstep',
  'bulenox',
  'mffu',
  'tradeify',
  'tpt',
]);

/** Firms whose default scrape target serves a non-futures product (CFD/forex). */
export const NON_FUTURES_FIRMS: Record<FirmId, string> = {
  ftmo: 'FTMO\u2019s landing page serves their CFD/forex eval, not their US futures product.',
  fundednext: 'FundedNext\u2019s scrape returns Stellar CFD pricing (6K/15K accounts), not futures.',
};

export interface ExcludedFirm {
  firm_id: FirmId;
  firm_name: string;
  reason: string;
  category: 'non_futures' | 'unverified' | 'no_snapshot';
}

export interface ComparableFilterResult {
  comparable: SnapshotInput[];
  excluded: ExcludedFirm[];
}

/**
 * Strict filter: keep only futures firms whose latest snapshot was directly
 * verified (not a curated_reference fallback) and contains real rules + pricing.
 * Everything else is surfaced in `excluded` with a reason.
 */
export function filterComparableSnapshots(snapshots: SnapshotInput[]): ComparableFilterResult {
  const comparable: SnapshotInput[] = [];
  const excluded: ExcludedFirm[] = [];

  for (const s of snapshots) {
    if (NON_FUTURES_FIRMS[s.firm_id]) {
      excluded.push({
        firm_id: s.firm_id,
        firm_name: s.firm_name,
        reason: NON_FUTURES_FIRMS[s.firm_id],
        category: 'non_futures',
      });
      continue;
    }
    if (!FUTURES_FIRM_IDS.has(s.firm_id)) {
      excluded.push({
        firm_id: s.firm_id,
        firm_name: s.firm_name,
        reason: 'Not on the futures allowlist — product line not yet verified as comparable.',
        category: 'non_futures',
      });
      continue;
    }
    const fallback = s.payload?._fallback_used;
    // Only exclude FULL curated_reference fallbacks (scraper got nothing).
    // Partial gap-fills on top of a real scrape are still comparable; the UI
    // surfaces a "partially enriched" badge for transparency.
    if (fallback === 'curated_reference') {
      excluded.push({
        firm_id: s.firm_id,
        firm_name: s.firm_name,
        reason: 'Scraper returned no usable data — entire snapshot is curated reference, not verified live.',
        category: 'unverified',
      });
      continue;
    }
    const rules = s.payload?.rules ?? {};
    const pricing = s.payload?.pricing ?? [];
    const hasRules = Object.values(rules).some((v) => v != null);
    const hasPricing = pricing.some((p) => p.list_price_usd != null || p.promo_price_usd != null);
    if (!hasRules || !hasPricing) {
      excluded.push({
        firm_id: s.firm_id,
        firm_name: s.firm_name,
        reason: 'Snapshot missing either rules or pricing — not enough data to compare honestly.',
        category: 'unverified',
      });
      continue;
    }
    comparable.push(s);
  }

  return { comparable, excluded };
}

export type MetricKey =
  | 'entry_price_50k'
  | 'profit_target'
  | 'daily_loss'
  | 'max_drawdown'
  | 'payout_split'
  | 'first_payout_cap'
  | 'lifetime_cap_structure'
  | 'cooldown_days'
  | 'min_trading_days'
  | 'consistency_pct'
  | 'reset_fee'
  | 'activation_fee'
  | 'phase_count'
  | 'accounts_allowed'
  | 'news_trading'
  | 'payout_methods'
  | 'scaling_plan'
  | 'active_promo';

export type Direction = 'higher_better' | 'lower_better' | 'neutral';

export interface MetricCell {
  value: number | null;
  display: string;
  qualifier?: string;
}

export interface MatrixRow {
  key: MetricKey;
  label: string;
  direction: Direction;
  cells: Record<FirmId, MetricCell>;
}

export interface ComparisonMatrix {
  firmOrder: FirmId[];
  firmNames: Record<FirmId, string>;
  rows: MatrixRow[];
}

export interface ScorecardVerdict {
  key: 'price' | 'generosity' | 'strictness' | 'unique' | 'gaps';
  title: string;
  tone: 'friendly' | 'neutral' | 'harsh';
  summary: string;
  details: string[];
}

export interface Recommendation {
  id: string;
  priority: 'high' | 'medium' | 'low';
  title: string;
  rationale: string;
  evidence: string[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────

const MERIDIAN: FirmId = 'meridian';

function fmtUsd(n: number | null | undefined): string {
  if (n == null) return '—';
  return `$${Math.round(n).toLocaleString('en-US')}`;
}
function fmtPct(n: number | null | undefined): string {
  if (n == null) return '—';
  return `${n}%`;
}
function fmtDays(n: number | null | undefined): string {
  if (n == null) return '—';
  return `${n}d`;
}

function pick50kPrice(snap: SnapshotInput): { price: number | null; isPromo: boolean } {
  const rows = snap.payload?.pricing ?? [];
  const matches = rows.filter((r) => {
    const l = (r.account_size_label ?? '').toLowerCase().replace(/[\s,$]/g, '');
    return l.includes('50k') || l === '50000' || l === '50';
  });
  const row = matches[0] ?? rows[0];
  if (!row) return { price: null, isPromo: false };
  if (row.promo_price_usd != null) return { price: row.promo_price_usd, isPromo: true };
  if (row.list_price_usd != null) return { price: row.list_price_usd, isPromo: false };
  return { price: null, isPromo: false };
}

function median(values: number[]): number | null {
  const xs = values.filter((v) => Number.isFinite(v)).slice().sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

function meridianStarterFromTiers(tiers: PricingTier[]): PricingTier {
  return tiers.find((t) => t.id === 'starter') ?? tiers[0];
}

// ─── 1. Build the matrix ─────────────────────────────────────────────────

export function buildComparisonMatrix(
  meridianTiers: PricingTier[],
  snapshots: SnapshotInput[],
): ComparisonMatrix {
  const meridian = meridianStarterFromTiers(meridianTiers);

  const firmOrder: FirmId[] = [MERIDIAN, ...snapshots.map((s) => s.firm_id)];
  const firmNames: Record<FirmId, string> = { [MERIDIAN]: 'Meridian' };
  for (const s of snapshots) firmNames[s.firm_id] = s.firm_name;

  const meridianTarget = meridian.accountSizeNum * (meridian.profitTarget / 100);
  const meridianDaily = meridian.accountSizeNum * (meridian.maxDailyLoss / 100);
  const meridianDD = meridian.accountSizeNum * (meridian.maxTotalDrawdown / 100);

  const cell = (
    rowMap: Record<FirmId, MetricCell>,
    firmId: FirmId,
    value: number | null,
    display: string,
    qualifier?: string,
  ) => {
    rowMap[firmId] = { value, display, qualifier };
  };

  const rows: MatrixRow[] = [];

  {
    const cells: Record<FirmId, MetricCell> = {};
    cell(cells, MERIDIAN, meridian.price, fmtUsd(meridian.price));
    for (const s of snapshots) {
      const { price, isPromo } = pick50kPrice(s);
      cell(cells, s.firm_id, price, fmtUsd(price), isPromo ? 'promo' : undefined);
    }
    rows.push({ key: 'entry_price_50k', label: 'Entry price (50K)', direction: 'lower_better', cells });
  }

  {
    const cells: Record<FirmId, MetricCell> = {};
    cell(cells, MERIDIAN, meridianTarget, fmtUsd(meridianTarget));
    for (const s of snapshots) {
      const v = s.payload?.rules?.profit_target_usd ?? null;
      cell(cells, s.firm_id, v, fmtUsd(v));
    }
    rows.push({ key: 'profit_target', label: 'Profit target', direction: 'lower_better', cells });
  }

  {
    const cells: Record<FirmId, MetricCell> = {};
    cell(cells, MERIDIAN, meridianDaily, fmtUsd(meridianDaily));
    for (const s of snapshots) {
      const v = s.payload?.rules?.daily_loss_usd ?? null;
      cell(cells, s.firm_id, v, fmtUsd(v));
    }
    rows.push({ key: 'daily_loss', label: 'Daily loss limit', direction: 'higher_better', cells });
  }

  {
    const cells: Record<FirmId, MetricCell> = {};
    cell(cells, MERIDIAN, meridianDD, fmtUsd(meridianDD));
    for (const s of snapshots) {
      const v = s.payload?.rules?.max_drawdown_usd ?? null;
      cell(cells, s.firm_id, v, fmtUsd(v));
    }
    rows.push({ key: 'max_drawdown', label: 'Max drawdown', direction: 'higher_better', cells });
  }

  {
    const cells: Record<FirmId, MetricCell> = {};
    cell(cells, MERIDIAN, meridian.splitPercent, fmtPct(meridian.splitPercent));
    for (const s of snapshots) {
      const v = s.payload?.rules?.payout_split_pct ?? null;
      cell(cells, s.firm_id, v, fmtPct(v));
    }
    rows.push({ key: 'payout_split', label: 'Payout split', direction: 'higher_better', cells });
  }

  {
    const cells: Record<FirmId, MetricCell> = {};
    cell(cells, MERIDIAN, meridian.firstPayoutCap, fmtUsd(meridian.firstPayoutCap), '× 1');
    for (const s of snapshots) {
      const v = s.payload?.rules?.first_payout_cap_usd ?? null;
      const n = s.payload?.rules?.first_payout_cap_count ?? null;
      cell(cells, s.firm_id, v, fmtUsd(v), n ? `× ${n}` : undefined);
    }
    rows.push({ key: 'first_payout_cap', label: 'First payout cap', direction: 'higher_better', cells });
  }

  // Qualitative row: what happens AFTER the first-payout cap window expires.
  // None of the surveyed competitors advertise a lifetime/hard max payout —
  // they cap the first N payouts then go uncapped per cycle. Meridian's
  // structure is honest: pacing + reserve + breaker gates, no "uncapped" claim.
  {
    const cells: Record<FirmId, MetricCell> = {};
    cell(cells, MERIDIAN, null, 'Pacing + reserve gated', 'no lifetime cap');
    for (const s of snapshots) {
      const capCount = s.payload?.rules?.first_payout_cap_count ?? null;
      const capUsd = s.payload?.rules?.first_payout_cap_usd ?? null;
      const hasFirstCap = capCount != null || capUsd != null;
      const display = hasFirstCap ? 'Uncapped after first N' : 'Uncapped per cycle';
      cell(cells, s.firm_id, null, display, 'no lifetime cap');
    }
    rows.push({ key: 'lifetime_cap_structure', label: 'Lifetime cap structure', direction: 'neutral', cells });
  }

  {
    const cells: Record<FirmId, MetricCell> = {};
    cell(cells, MERIDIAN, meridian.payoutCooldown, fmtDays(meridian.payoutCooldown));
    for (const s of snapshots) {
      const v = s.payload?.rules?.payout_cadence_days ?? null;
      cell(cells, s.firm_id, v, fmtDays(v));
    }
    rows.push({ key: 'cooldown_days', label: 'Payout cooldown', direction: 'lower_better', cells });
  }

  {
    const cells: Record<FirmId, MetricCell> = {};
    cell(cells, MERIDIAN, meridian.minTradingDays, `${meridian.minTradingDays}`);
    for (const s of snapshots) {
      const v = s.payload?.rules?.min_trading_days ?? null;
      cell(cells, s.firm_id, v, v == null ? '—' : `${v}`);
    }
    rows.push({ key: 'min_trading_days', label: 'Min trading days', direction: 'lower_better', cells });
  }

  {
    const cells: Record<FirmId, MetricCell> = {};
    cell(cells, MERIDIAN, null, '—');
    for (const s of snapshots) {
      const v = s.payload?.rules?.consistency_rule_pct ?? null;
      cell(cells, s.firm_id, v, fmtPct(v));
    }
    rows.push({ key: 'consistency_pct', label: 'Consistency rule', direction: 'neutral', cells });
  }

  {
    const cells: Record<FirmId, MetricCell> = {};
    cell(cells, MERIDIAN, meridian.resetFee, fmtUsd(meridian.resetFee));
    for (const s of snapshots) {
      const v = s.payload?.rules?.reset_fee_usd ?? null;
      cell(cells, s.firm_id, v, fmtUsd(v));
    }
    rows.push({ key: 'reset_fee', label: 'Reset fee', direction: 'lower_better', cells });
  }

  // Activation / monthly fee on funded accounts (often hidden cost)
  {
    const cells: Record<FirmId, MetricCell> = {};
    cell(cells, MERIDIAN, 0, fmtUsd(0), 'none');
    for (const s of snapshots) {
      const v = s.payload?.rules?.activation_fee_usd ?? null;
      const cadence = s.payload?.rules?.activation_fee_cadence;
      const qualifier = v && cadence ? cadence.replace('_', ' ') : undefined;
      cell(cells, s.firm_id, v, fmtUsd(v), qualifier);
    }
    rows.push({ key: 'activation_fee', label: 'Activation fee', direction: 'lower_better', cells });
  }

  // Phase count: 1 = instant/eval-only, 2 = eval + verification
  {
    const cells: Record<FirmId, MetricCell> = {};
    cell(cells, MERIDIAN, 1, '1', 'eval only');
    for (const s of snapshots) {
      const v = s.payload?.rules?.phase_count ?? null;
      cell(cells, s.firm_id, v, v == null ? '—' : `${v}`);
    }
    rows.push({ key: 'phase_count', label: 'Eval phases', direction: 'lower_better', cells });
  }

  // Max concurrent accounts a trader can hold
  {
    const cells: Record<FirmId, MetricCell> = {};
    cell(cells, MERIDIAN, null, '—');
    for (const s of snapshots) {
      const v = s.payload?.rules?.accounts_allowed_max ?? null;
      cell(cells, s.firm_id, v, v == null ? '—' : `${v}`);
    }
    rows.push({ key: 'accounts_allowed', label: 'Max accounts', direction: 'higher_better', cells });
  }

  // News trading allowed?
  {
    const cells: Record<FirmId, MetricCell> = {};
    cell(cells, MERIDIAN, null, '—');
    for (const s of snapshots) {
      const v = s.payload?.rules?.news_trading_allowed;
      const display = v == null ? '—' : v ? 'Allowed' : 'Banned';
      cell(cells, s.firm_id, v == null ? null : v ? 1 : 0, display);
    }
    rows.push({ key: 'news_trading', label: 'News trading', direction: 'higher_better', cells });
  }

  // Payout methods (qualitative)
  {
    const cells: Record<FirmId, MetricCell> = {};
    cell(cells, MERIDIAN, null, '—');
    for (const s of snapshots) {
      const v = s.payload?.rules?.payout_methods ?? null;
      cell(cells, s.firm_id, null, v ?? '—');
    }
    rows.push({ key: 'payout_methods', label: 'Payout methods', direction: 'neutral', cells });
  }

  // Scaling plan summary (qualitative)
  {
    const cells: Record<FirmId, MetricCell> = {};
    cell(cells, MERIDIAN, null, '—');
    for (const s of snapshots) {
      const v = s.payload?.rules?.scaling_plan_summary ?? null;
      cell(cells, s.firm_id, null, v ?? '—');
    }
    rows.push({ key: 'scaling_plan', label: 'Scaling plan', direction: 'neutral', cells });
  }

  {
    const cells: Record<FirmId, MetricCell> = {};
    cell(cells, MERIDIAN, null, 'none');
    for (const s of snapshots) {
      const banner = s.payload?.active_promo_banner;
      const code = s.payload?.promo_code;
      const display = banner ? (code ? `${banner} (${code})` : banner) : code ? code : '—';
      cell(cells, s.firm_id, banner || code ? 1 : null, display);
    }
    rows.push({ key: 'active_promo', label: 'Live promo', direction: 'neutral', cells });
  }

  return { firmOrder, firmNames, rows };
}

export function cellSignal(row: MatrixRow, firmId: FirmId): 'friendly' | 'harsh' | 'neutral' {
  if (row.direction === 'neutral') return 'neutral';
  const c = row.cells[firmId];
  if (!c || c.value == null) return 'neutral';
  const others = Object.entries(row.cells)
    .filter(([id]) => id !== firmId)
    .map(([, x]) => x.value)
    .filter((v): v is number => v != null);
  const m = median(others);
  if (m == null || c.value === m) return 'neutral';
  const above = c.value > m;
  if (row.direction === 'higher_better') return above ? 'friendly' : 'harsh';
  return above ? 'harsh' : 'friendly';
}

// ─── 2. Scorecard ────────────────────────────────────────────────────────

export function scoreMeridianPosition(matrix: ComparisonMatrix): ScorecardVerdict[] {
  const verdicts: ScorecardVerdict[] = [];
  const row = (key: MetricKey) => matrix.rows.find((r) => r.key === key);
  const competitorValues = (key: MetricKey): number[] => {
    const r = row(key);
    if (!r) return [];
    return matrix.firmOrder
      .filter((id) => id !== MERIDIAN)
      .map((id) => r.cells[id]?.value)
      .filter((v): v is number => v != null);
  };
  const meridianValue = (key: MetricKey): number | null => row(key)?.cells[MERIDIAN]?.value ?? null;

  {
    const us = meridianValue('entry_price_50k');
    const others = competitorValues('entry_price_50k');
    const med = median(others);
    const min = others.length ? Math.min(...others) : null;
    const max = others.length ? Math.max(...others) : null;
    let tone: ScorecardVerdict['tone'] = 'neutral';
    let summary = 'No competitor pricing captured yet.';
    const details: string[] = [];
    if (us != null && med != null && min != null && max != null) {
      const ratio = us / med;
      if (ratio > 1.2) {
        tone = 'harsh';
        summary = `Premium-priced: $${us} is ${Math.round((ratio - 1) * 100)}% above competitor median ($${med}).`;
      } else if (ratio < 0.8) {
        tone = 'friendly';
        summary = `Aggressively priced: $${us} is ${Math.round((1 - ratio) * 100)}% below competitor median ($${med}).`;
      } else {
        summary = `Mid-market price: $${us} vs competitor median $${med}.`;
      }
      details.push(`Competitor range: $${min} – $${max} (n=${others.length}).`);
    }
    verdicts.push({ key: 'price', title: 'Price position', tone, summary, details });
  }

  {
    const details: string[] = [];
    let harshHits = 0;
    const ourSplit = meridianValue('payout_split');
    const splitMed = median(competitorValues('payout_split'));
    if (ourSplit != null && splitMed != null) {
      if (ourSplit < splitMed) {
        details.push(`Payout split ${ourSplit}% is below competitor median ${splitMed}%.`);
        harshHits++;
      } else {
        details.push(`Payout split ${ourSplit}% meets or beats competitor median ${splitMed}%.`);
      }
    }
    const ourCap = meridianValue('first_payout_cap');
    const capMed = median(competitorValues('first_payout_cap'));
    if (ourCap != null && capMed != null) {
      if (ourCap < capMed) {
        const ratio = capMed / ourCap;
        details.push(`First payout cap $${ourCap} is ${ratio.toFixed(1)}× tighter than competitor median $${capMed}.`);
        harshHits++;
      } else {
        details.push(`First payout cap $${ourCap} is at or above competitor median $${capMed}.`);
      }
    }
    verdicts.push({
      key: 'generosity',
      title: 'Payout generosity',
      tone: harshHits >= 2 ? 'harsh' : harshHits === 1 ? 'neutral' : 'friendly',
      summary:
        harshHits >= 2
          ? 'Less trader-friendly than the market on both split and first-cap.'
          : harshHits === 1
          ? 'Mixed — one dimension below market, one at par.'
          : 'At or above the market on payout generosity.',
      details,
    });
  }

  {
    const checks: Array<[MetricKey, 'lower_better' | 'higher_better', string]> = [
      ['daily_loss', 'higher_better', 'daily loss'],
      ['max_drawdown', 'higher_better', 'max drawdown'],
      ['cooldown_days', 'lower_better', 'cooldown'],
      ['min_trading_days', 'lower_better', 'min trading days'],
    ];
    let harsh = 0;
    let friendly = 0;
    const details: string[] = [];
    for (const [k, dir, label] of checks) {
      const us = meridianValue(k);
      const m = median(competitorValues(k));
      if (us == null || m == null) continue;
      const usHarsher = dir === 'higher_better' ? us < m : us > m;
      const usFriendlier = dir === 'higher_better' ? us > m : us < m;
      if (usHarsher) {
        harsh++;
        details.push(`${label}: stricter than competitor median.`);
      } else if (usFriendlier) {
        friendly++;
        details.push(`${label}: looser than competitor median.`);
      }
    }
    verdicts.push({
      key: 'strictness',
      title: 'Rule strictness',
      tone: harsh > friendly ? 'harsh' : friendly > harsh ? 'friendly' : 'neutral',
      summary:
        harsh > friendly
          ? `${harsh} rule${harsh === 1 ? '' : 's'} stricter than median, ${friendly} looser.`
          : friendly > harsh
          ? `${friendly} rule${friendly === 1 ? '' : 's'} looser than median.`
          : 'Rules sit roughly at the market median.',
      details,
    });
  }

  {
    const details: string[] = [
      'Lifetime payout cap (10× entry) — no scraped competitor advertises one.',
      'Reset fee published on pricing page — most competitors do not disclose this up-front.',
    ];
    verdicts.push({
      key: 'unique',
      title: 'Unique constraints',
      tone: 'neutral',
      summary: 'Meridian carries structural protections no competitor advertises.',
      details,
    });
  }

  {
    const details: string[] = [];
    const promoRow = row('active_promo');
    if (promoRow) {
      const livePromos = matrix.firmOrder
        .filter((id) => id !== MERIDIAN)
        .filter((id) => promoRow.cells[id]?.value != null);
      if (livePromos.length > 0) {
        const names = livePromos.map((id) => matrix.firmNames[id]).join(', ');
        details.push(
          `${livePromos.length} competitor${livePromos.length === 1 ? ' has' : 's have'} a live promo (${names}). Meridian does not.`,
        );
      }
    }
    const splitVals = competitorValues('payout_split');
    const splitMax = splitVals.length ? Math.max(...splitVals) : 0;
    if (splitMax >= 100 && (meridianValue('payout_split') ?? 0) < 100) {
      details.push(`At least one competitor advertises a 100% split tier. Meridian tops out at ${meridianValue('payout_split')}%.`);
    }
    const cdVals = competitorValues('cooldown_days');
    const cdMin = cdVals.length ? Math.min(...cdVals) : Infinity;
    if (cdMin <= 1 && (meridianValue('cooldown_days') ?? 0) > 1) {
      details.push(`At least one competitor offers ${cdMin}-day payout cooldown. Meridian requires ${meridianValue('cooldown_days')}d.`);
    }
    verdicts.push({
      key: 'gaps',
      title: 'What Meridian lacks',
      tone: details.length >= 2 ? 'harsh' : 'neutral',
      summary:
        details.length === 0
          ? 'No notable feature gaps detected from current snapshots.'
          : `${details.length} feature gap${details.length === 1 ? '' : 's'} vs competitors.`,
      details,
    });
  }

  return verdicts;
}

// ─── 3. Recommendations ──────────────────────────────────────────────────

export function generateRecommendations(
  matrix: ComparisonMatrix,
  scorecard: ScorecardVerdict[],
): Recommendation[] {
  const recs: Recommendation[] = [];
  const row = (key: MetricKey) => matrix.rows.find((r) => r.key === key);
  const competitorValues = (key: MetricKey): number[] =>
    row(key)
      ? matrix.firmOrder
          .filter((id) => id !== MERIDIAN)
          .map((id) => row(key)!.cells[id]?.value)
          .filter((v): v is number => v != null)
      : [];
  const meridianValue = (key: MetricKey): number | null => row(key)?.cells[MERIDIAN]?.value ?? null;

  const us = meridianValue('entry_price_50k');
  const others = competitorValues('entry_price_50k');
  const med = median(others);
  if (us != null && med != null && us > med * 1.2) {
    const cheaper = matrix.firmOrder
      .filter((id) => id !== MERIDIAN)
      .filter((id) => {
        const v = row('entry_price_50k')?.cells[id]?.value;
        return v != null && v < us * 0.7;
      })
      .map((id) => matrix.firmNames[id]);
    recs.push({
      id: 'price_premium',
      priority: 'high',
      title: 'You are priced as a premium brand — own it or close the gap',
      rationale:
        'Entry price is well above competitor median. Either time-box a Founder promo to compete on price for cold traffic, or double down on premium messaging (lifetime cap, verified payouts, staff review) so the price difference reads as quality, not friction.',
      evidence: [
        `Meridian $${us} vs competitor median $${med} (${Math.round((us / med - 1) * 100)}% higher).`,
        cheaper.length ? `Significantly cheaper alternatives: ${cheaper.join(', ')}.` : '',
      ].filter(Boolean),
    });
  }

  const promoRow = row('active_promo');
  if (promoRow) {
    const live = matrix.firmOrder
      .filter((id) => id !== MERIDIAN)
      .filter((id) => promoRow.cells[id]?.value != null);
    if (live.length >= 2) {
      recs.push({
        id: 'promo_pressure',
        priority: 'medium',
        title: 'Multiple competitors are running live promos right now',
        rationale:
          'Discount pressure is active in the market. A short Founder-tier promo can capture price-sensitive traffic without permanently repricing the product.',
        evidence: live.map((id) => `${matrix.firmNames[id]}: ${promoRow.cells[id]?.display}`),
      });
    }
  }

  const ourCap = meridianValue('first_payout_cap');
  const capMed = median(competitorValues('first_payout_cap'));
  if (ourCap != null && capMed != null && ourCap < capMed / 2) {
    recs.push({
      id: 'first_cap_tight',
      priority: 'high',
      title: 'First-payout cap is materially tighter than the market — defend it in copy',
      rationale:
        'The first-payout cap is the single biggest cause of "I thought I could withdraw more" friction. Either keep it and own the narrative (smaller, predictable, paid), or raise it on the Pro tier to remove the comparison objection.',
      evidence: [`Meridian $${ourCap} vs competitor median $${capMed} (${(capMed / ourCap).toFixed(1)}× tighter).`],
    });
  }

  const ourCd = meridianValue('cooldown_days');
  const cds = competitorValues('cooldown_days');
  const fastCount = cds.filter((d) => d <= 1).length;
  if (ourCd != null && ourCd >= 14 && fastCount >= 2) {
    const fastFirms = matrix.firmOrder
      .filter((id) => id !== MERIDIAN)
      .filter((id) => {
        const v = row('cooldown_days')?.cells[id]?.value;
        return v != null && v <= 1;
      })
      .map((id) => matrix.firmNames[id]);
    recs.push({
      id: 'cooldown_friction',
      priority: 'medium',
      title: 'Consider a faster-payout option for active traders',
      rationale:
        'Several competitors advertise zero- or near-zero-day cooldowns. Active traders perceive a 14-day cooldown as a hard friction point. A Pro-tier 7-day cooldown closes the gap without abandoning the cashflow discipline cooldowns provide.',
      evidence: [`Fast-payout competitors: ${fastFirms.join(', ')}.`, `Meridian cooldown: ${ourCd}d.`],
    });
  }

  const ourSplit = meridianValue('payout_split');
  const splitVals = competitorValues('payout_split');
  const splitMax = splitVals.length ? Math.max(...splitVals) : 0;
  if (ourSplit != null && splitMax >= 100 && ourSplit < 100) {
    recs.push({
      id: 'split_ceiling',
      priority: 'low',
      title: 'Publish a visible split ceiling for the Elite tier',
      rationale:
        'A 100% split headline is table-stakes marketing in this market. You do not have to give every account 100%, but publishing a "90% at Pro, 95% at Elite" ladder neutralises the side-by-side comparison without changing economics for new traders.',
      evidence: [`Top competitor split: ${splitMax}%. Meridian: ${ourSplit}%.`],
    });
  }

  void scorecard;
  const order = { high: 0, medium: 1, low: 2 };
  recs.sort((a, b) => order[a.priority] - order[b.priority]);
  return recs;
}

export const __test__ = { median, pick50kPrice };
