/**
 * Server-side mirror of src/lib/reset-bundles.ts.
 * Keep in sync. Used by create-reset-checkout for price authority.
 */
export type ResetBundleId = 'single' | 'urgency_single' | 'three_pack';

export interface ResetBundle {
  id: ResetBundleId;
  label: string;
  resetCount: number;
  priceUsd: number;
  urgencyOnly?: boolean;
}

export const RESET_BUNDLES: Record<ResetBundleId, ResetBundle> = {
  single: { id: 'single', label: 'Single Reset', resetCount: 1, priceUsd: 99 },
  urgency_single: { id: 'urgency_single', label: '24h Comeback Discount', resetCount: 1, priceUsd: 79, urgencyOnly: true },
  three_pack: { id: 'three_pack', label: '3-Pack Resets', resetCount: 3, priceUsd: 199 },
};

export const URGENCY_WINDOW_MS = 24 * 60 * 60 * 1000;
