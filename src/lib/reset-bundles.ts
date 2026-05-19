/**
 * Reset bundle pricing.
 *
 * SSOT: base reset fee lives in src/lib/pricing-data.ts (PricingTier.resetFee = $99).
 * Bundles are marketing-layer products that wrap N resets with discount.
 *
 * Urgency window: 24h from breach detection. After expiry, single reset reverts to $99.
 *
 * Server-side mirror: supabase/functions/_shared/reset-bundles.ts must match.
 */
export type ResetBundleId = 'single' | 'urgency_single' | 'three_pack';

export interface ResetBundle {
  id: ResetBundleId;
  label: string;
  resetCount: number;
  priceUsd: number;
  perResetUsd: number;
  savingsUsd: number;
  badge?: string;
  /** Only offered while urgency window is active (within 24h of breach). */
  urgencyOnly?: boolean;
  description: string;
}

export const RESET_BUNDLES: Record<ResetBundleId, ResetBundle> = {
  single: {
    id: 'single',
    label: 'Single Reset',
    resetCount: 1,
    priceUsd: 99,
    perResetUsd: 99,
    savingsUsd: 0,
    description: 'Reset your account and pick up where the rules let you continue.',
  },
  urgency_single: {
    id: 'urgency_single',
    label: '24h Comeback Discount',
    resetCount: 1,
    priceUsd: 79,
    perResetUsd: 79,
    savingsUsd: 20,
    badge: 'Time-Limited',
    urgencyOnly: true,
    description: 'Available for 24 hours after your breach. One-time use per account.',
  },
  three_pack: {
    id: 'three_pack',
    label: '3-Pack Resets',
    resetCount: 3,
    priceUsd: 199,
    perResetUsd: Math.round((199 / 3) * 100) / 100,
    savingsUsd: 99 * 3 - 199,
    badge: 'Best Value',
    description: 'Three resets banked to your account. Use them whenever you breach.',
  },
};

export const URGENCY_WINDOW_MS = 24 * 60 * 60 * 1000;

export function isUrgencyActive(breachAt: string | Date | null | undefined): boolean {
  if (!breachAt) return false;
  const ts = typeof breachAt === 'string' ? new Date(breachAt).getTime() : breachAt.getTime();
  return Date.now() - ts < URGENCY_WINDOW_MS;
}

export function urgencyMsRemaining(breachAt: string | Date): number {
  const ts = typeof breachAt === 'string' ? new Date(breachAt).getTime() : breachAt.getTime();
  return Math.max(0, URGENCY_WINDOW_MS - (Date.now() - ts));
}

export function formatCountdown(ms: number): string {
  if (ms <= 0) return '00:00:00';
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':');
}
