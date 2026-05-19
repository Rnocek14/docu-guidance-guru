/**
 * SSOT: server-authoritative reset-bundle pricing.
 *
 * Used by create-reset-checkout to set Stripe line-item amounts. The
 * client mirror (src/lib/reset-bundles.ts) MUST keep id/resetCount/
 * priceUsd/urgencyOnly in sync — verified by
 * src/lib/reset-bundles-ssot.test.ts on every CI run.
 *
 * Marketing fields (label, badge, savings, description) live on the
 * client. Keep them out of here so the server schema stays minimal
 * and there's no marketing-copy drift between billing and UI.
 */
export type ResetBundleId = 'single' | 'urgency_single' | 'three_pack';

export interface ResetBundle {
  id: ResetBundleId;
  resetCount: number;
  priceUsd: number;
  /** Only offered while the 24h post-breach urgency window is active. */
  urgencyOnly?: boolean;
}

export const RESET_BUNDLES: Record<ResetBundleId, ResetBundle> = {
  single:         { id: 'single',         resetCount: 1, priceUsd: 99 },
  urgency_single: { id: 'urgency_single', resetCount: 1, priceUsd: 79, urgencyOnly: true },
  three_pack:     { id: 'three_pack',     resetCount: 3, priceUsd: 199 },
};

export const URGENCY_WINDOW_MS = 24 * 60 * 60 * 1000;
