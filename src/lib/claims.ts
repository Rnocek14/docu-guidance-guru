/**
 * Centralized marketing claims & disclaimers.
 *
 * SINGLE SOURCE OF TRUTH for all public-facing copy that makes
 * verifiable or legally-sensitive statements. Landing components,
 * pricing cards, checkout, and rules pages should import from here
 * rather than hardcoding claims inline.
 *
 * Content policy: No absolute claims (always, never, every, guarantee).
 * See scripts/lint-copy.sh for automated enforcement.
 */

// ── Trust badges (used in pricing, footer, final CTA) ──────────────────

export const TRUST_BADGES = [
  { label: 'Simulated Environment', emoji: '🎯' },
  { label: 'Approved Payouts Paid', emoji: '💰' },
  { label: 'Staff-Reviewed Decisions', emoji: '👤' },
  { label: 'Published Rules', emoji: '🔒' },
] as const;

// ── Stats bar claims (StatsCounter) ─────────────────────────────────────

export const STATS = [
  { value: 'Early Access', label: 'Platform Status' },
  { value: 'Staff-Reviewed', label: 'Payout Decisions' },
  { value: '3–5 Days', label: 'Typical Review Time' },
  { value: 'Published', label: 'Rules at Purchase' },
] as const;

// ── Comparison table claims (ComparisonTable) ───────────────────────────

export const COMPARISON_HEADER = {
  title: 'Us vs. The Industry',
  subtitle: 'We chose tighter rules and lower splits so we can reliably pay approved requests.',
} as const;

// ── Hero section ────────────────────────────────────────────────────────

export const HERO_TAGLINE = 'Your Fixed Point in Trading.';

export const HERO_BADGES = [
  'Published Rules',
  'Staff-Reviewed',
  'Decisions Logged',
] as const;

export const HERO_SUBTITLE =
  'Prove your skill on a simulated account. Meet the rules. Earn performance-based rewards. Published rules, disclosed caps, staff-reviewed decisions.';

// ── Disclaimers ─────────────────────────────────────────────────────────

export const PRICING_DISCLAIMER =
  'All trading activity is simulated. Payouts are performance-based rewards, not profit withdrawals or investment returns. Rules are published at the time of purchase and versioned.';

export const PAYOUT_DISCLAIMER =
  'Payout requests are reviewed by staff. Approved refunds are returned to the original payment method when possible.';

// ── Earnings framing ────────────────────────────────────────────────────

/** Generates the "Earn up to $X" string for a tier. */
export function earningsLabel(lifetimeCapAmount: number): string {
  return `Earn up to $${lifetimeCapAmount.toLocaleString()}`;
}

/** Generates the multiplier label for a tier. */
export function multiplierLabel(multiple: number): string {
  return `Up to ${multiple}×\u00A0entry`;
}
