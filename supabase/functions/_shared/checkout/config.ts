// ============================================================
// Provider-independent tier configuration
// Stripe price IDs, Paddle product IDs, etc. are stored
// per-provider, NOT here. This is the canonical source of truth
// for tier definitions.
// ============================================================

import type { CheckoutTierConfig } from './types.ts'

export const TIERS: Record<string, CheckoutTierConfig> = {
  starter: {
    tierId: 'starter',
    name: 'Starter Evaluation',
    accountSize: 50_000,
    entryFee: 149,
    isLive: true,
  },
  pro: {
    tierId: 'pro',
    name: 'Pro Evaluation',
    accountSize: 100_000,
    entryFee: 199,
    isLive: false,
  },
  elite: {
    tierId: 'elite',
    name: 'Elite Evaluation',
    accountSize: 200_000,
    entryFee: 349,
    isLive: false,
  },
}

// Tier → Cohort mapping for fulfillment (provider-independent)
export const TIER_COHORT_MAP: Record<string, { accountSize: number; cohortName: string }> = {
  starter: { accountSize: 50_000, cohortName: 'Starter' },
  pro: { accountSize: 100_000, cohortName: 'Pro' },
  elite: { accountSize: 200_000, cohortName: 'Elite' },
}

// Server-authoritative rules version — never trust client value
export const RULES_VERSION = 'v1.0'
