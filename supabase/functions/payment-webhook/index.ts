import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getCheckoutProvider } from '../_shared/checkout/registry.ts'

// ============================================================
// Provider-Agnostic Payment Webhook Router
//
// Single endpoint that detects the payment provider by
// request signature headers and routes to the appropriate adapter.
//
// verify_jwt = false — we verify provider signatures instead
// No CORS — called by provider servers, not browsers
// ============================================================

const PROVIDER_DETECTION: Array<{
  headerKey: string
  railKey: string
}> = [
  { headerKey: 'stripe-signature', railKey: 'stripe_card' },
  // { headerKey: 'paddle-signature', railKey: 'paddle_card' },
  // { headerKey: 'x-lemon-squeezy-signature', railKey: 'lemonsqueezy_card' },
]

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const supabase = createClient(supabaseUrl, serviceRoleKey)

  try {
    // ── 1. Detect provider by signature header ─────────────
    let detectedRailKey: string | null = null
    for (const { headerKey, railKey } of PROVIDER_DETECTION) {
      if (req.headers.get(headerKey)) {
        detectedRailKey = railKey
        break
      }
    }

    if (!detectedRailKey) {
      console.warn('payment-webhook: no recognized provider signature header')
      // Return 200 to prevent retry storms from unknown sources
      return new Response(JSON.stringify({ received: true, handled: false, reason: 'unknown_provider' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // ── 2. Get adapter and verify + parse webhook ──────────
    let adapter
    try {
      adapter = getCheckoutProvider(detectedRailKey)
    } catch (adapterErr) {
      console.error(`payment-webhook: adapter init failed for ${detectedRailKey}:`, (adapterErr as Error).message)
      return new Response(JSON.stringify({ error: 'Provider configuration error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const event = await adapter.parseWebhook(req)

    if (!event) {
      console.warn(`payment-webhook: signature verification failed for ${detectedRailKey}`)
      return new Response(JSON.stringify({ error: 'Invalid signature' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    console.log(`payment-webhook: provider=${event.provider} type=${event.eventType} session=${event.sessionId}`)

    // ── 3. Route by normalized event type ──────────────────
    switch (event.eventType) {
      case 'checkout_completed': {
        // Write canonical provider fields to queue row
        const { error: updateErr } = await supabase
          .from('checkout_fulfillment_queue')
          .update({
            provider: event.provider,
            provider_session_id: event.sessionId,
            provider_event_id: event.metadata?.event_id || null,
            provider_payment_id: event.paymentIntent,
            status: 'queued',
            payment_intent: event.paymentIntent, // Legacy
            amount_cents: event.amountCents,
            currency: event.currency,
            updated_at: new Date().toISOString(),
          })
          .eq('stripe_session_id', event.sessionId) // Legacy lookup
          .in('status', ['session_created'])

        if (updateErr) {
          console.error(`payment-webhook: queue update failed: ${updateErr.message}`)
        }

        // The existing stripe-webhook checkout-handler does the heavy lifting
        // (claim + fulfill). For now, we invoke it via the same logic.
        // In the future, fulfillment logic moves here entirely.
        console.log(`payment-webhook: checkout_completed routed for session=${event.sessionId}`)
        break
      }

      case 'charge_refunded': {
        console.log(`payment-webhook: charge_refunded for pi=${event.paymentIntent}`)
        // Refund handling remains in stripe-webhook for now (complex logic)
        // Will be migrated here when second provider is added
        break
      }

      default: {
        console.log(`payment-webhook: unhandled event type: ${event.eventType}`)
      }
    }

    // Always return 200 to prevent retry storms
    return new Response(JSON.stringify({ received: true, provider: event.provider, eventType: event.eventType }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (err) {
    const error = err as Error
    console.error('payment-webhook error:', error)
    // Return 200 even on internal errors to prevent provider retry storms
    // Log the error for investigation
    return new Response(JSON.stringify({ received: true, error: error.message }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
})
