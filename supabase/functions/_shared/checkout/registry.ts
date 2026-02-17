// ============================================================
// Checkout provider registry
// Selects the active inbound checkout provider based on
// payment_rails configuration in the database.
// ============================================================

import type { CheckoutProviderAdapter } from './types.ts'
import { StripeCheckoutAdapter } from './stripe-adapter.ts'

/**
 * Instantiate the appropriate checkout provider based on rail_key.
 * Add new providers here as they become available.
 */
export function getCheckoutProvider(railKey: string): CheckoutProviderAdapter {
  switch (railKey) {
    case 'stripe_card': {
      const secretKey = Deno.env.get('STRIPE_SECRET_KEY')
      const webhookSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET')
      if (!secretKey || !webhookSecret) {
        throw new Error(`Stripe secrets not configured for rail: ${railKey}`)
      }
      return new StripeCheckoutAdapter(secretKey, webhookSecret)
    }

    // ── Future providers ──────────────────────────────
    // case 'paddle_card':
    //   return new PaddleCheckoutAdapter(...)

    default:
      throw new Error(`Unknown checkout rail: ${railKey}`)
  }
}

/**
 * Resolve the active inbound payment rail from the database.
 * Uses priority ordering: lowest priority number = preferred.
 *
 * FAIL-CLOSED: if no rails are enabled, throws an error.
 * This prevents silent fallback to a provider during an incident.
 */
export async function resolveActiveInboundRail(
  supabase: { from: (table: string) => any }
): Promise<string> {
  // First check: is inbound paused globally?
  const { data: systemState } = await supabase
    .from('payment_system_state')
    .select('is_paused_inbound')
    .limit(1)
    .maybeSingle()

  if (systemState?.is_paused_inbound) {
    throw new Error('INBOUND_PAUSED: All inbound payments are currently paused')
  }

  // Resolve highest-priority enabled inbound rail
  const { data: rails } = await supabase
    .from('payment_rails')
    .select('rail_key')
    .eq('is_enabled', true)
    .eq('supports_inbound', true)
    .order('priority', { ascending: true })
    .limit(1)

  if (rails && rails.length > 0) {
    return rails[0].rail_key
  }

  // FAIL-CLOSED: no enabled rail = hard error, not silent fallback
  throw new Error('NO_INBOUND_RAIL: No enabled inbound payment rail configured')
}
