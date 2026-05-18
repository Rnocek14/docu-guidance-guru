/**
 * Qualitative headroom band for trader-facing UI.
 * Trader UI never shows exact lifetime-headroom dollars — only bands + copy.
 * Admin / internal UI keeps exact dollars and ratios. See mem://design/trader-vs-admin-precision.
 */

export type HeadroomBand =
  | 'plenty_remaining'
  | 'healthy_usage'
  | 'well_used'
  | 'nearing_limit'
  | 'at_review_threshold';

export interface HeadroomBandInfo {
  band: HeadroomBand;
  label: string;
  copy: string;
  /** Tailwind variant hint for the badge */
  tone: 'success' | 'default' | 'secondary' | 'warning' | 'destructive';
}

/**
 * Map cap-usage percent (0–100) to a qualitative band.
 * Returns null when usage is unknown / no cap configured.
 */
export function getHeadroomBand(usagePct: number | null | undefined): HeadroomBandInfo | null {
  if (usagePct === null || usagePct === undefined || !Number.isFinite(usagePct)) return null;
  const pct = Math.max(0, Math.min(100, usagePct));

  if (pct < 25) {
    return {
      band: 'plenty_remaining',
      label: 'Plenty Remaining',
      copy: "You're comfortably within payout pacing.",
      tone: 'success',
    };
  }
  if (pct < 50) {
    return {
      band: 'healthy_usage',
      label: 'Healthy Usage',
      copy: 'Steady progress — keep trading cleanly.',
      tone: 'default',
    };
  }
  if (pct < 75) {
    return {
      band: 'well_used',
      label: 'Well Used',
      copy: "You've used a healthy portion of this account.",
      tone: 'secondary',
    };
  }
  if (pct < 90) {
    return {
      band: 'nearing_limit',
      label: 'Nearing Limit',
      copy: 'Recent withdrawals are approaching your pacing band.',
      tone: 'warning',
    };
  }
  return {
    band: 'at_review_threshold',
    label: 'At Review Threshold',
    copy: 'Maintain clean trading to continue expanding headroom.',
    tone: 'destructive',
  };
}
