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
    case 'stripe_card':
      return new StripeCheckoutAdapter(
        Deno.env.get('STRIPE_SECRET_KEY')!,
        Deno.env.get('STRIPE_WEBHOOK_SECRET')!
      )

    // ── Future providers ──────────────────────────────
    // case 'paddle_card':
    //   return new PaddleCheckoutAdapter(
    //     Deno.env.get('PADDLE_API_KEY')!,
    //     Deno.env.get('PADDLE_WEBHOOK_SECRET')!
    //   )
    //
    // case 'lemonsqueezy_card':
    //   return new LemonSqueezyCheckoutAdapter(...)

    default:
      throw new Error(`Unknown checkout rail: ${railKey}`)
  }
}

/**
 * Resolve the active inbound payment rail from the database.
 * Uses priority ordering: lowest priority number = preferred.
 * Falls back to 'stripe_card' if no rails configured.
 */
export async function resolveActiveInboundRail(
  supabase: { from: (table: string) => any }
): Promise<string> {
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

  // Fail-closed: if no rails configured, default to stripe
  console.warn('No active inbound payment rail found, defaulting to stripe_card')
  return 'stripe_card'
}
