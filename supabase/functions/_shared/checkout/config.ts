// ============================================================
// Checkout-specific config — re-exports from canonical source.
// This file exists for backward compatibility with
// create-checkout-session and stripe-webhook imports.
// ============================================================

import { TIER_ECONOMICS, TIER_COHORT_MAP, RULES_VERSION } from './tier-economics.ts'
import type { CheckoutTierConfig } from './types.ts'

// Re-export canonical values
export { TIER_COHORT_MAP, RULES_VERSION }

/**
 * TIERS map used by create-checkout-session.
 * Derived from TIER_ECONOMICS — do NOT add values here.
 */
export const TIERS: Record<string, CheckoutTierConfig> = Object.fromEntries(
  Object.entries(TIER_ECONOMICS).map(([id, t]) => [id, {
    tierId: t.tierId,
    name: t.name,
    accountSize: t.accountSize,
    entryFee: t.entryFee,
    isLive: t.isLive,
  }])
)
