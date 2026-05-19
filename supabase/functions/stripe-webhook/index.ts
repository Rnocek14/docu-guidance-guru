import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import Stripe from 'https://esm.sh/stripe@18.5.0'
import { handleChargeRefunded } from './refund-handler.ts'
import { handleResetBundleCompleted } from './reset-handler.ts'

// No CORS needed — called by Stripe servers, not browsers
// verify_jwt = false — we verify Stripe's webhook signature instead

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, {
    apiVersion: '2025-08-27.basil',
  })

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const supabase = createClient(supabaseUrl, serviceRoleKey)

  const webhookSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET')
  if (!webhookSecret) {
    console.error('STRIPE_WEBHOOK_SECRET not configured')
    return new Response(JSON.stringify({ error: 'Webhook secret not configured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  try {
    // ── 1. Verify Stripe signature ───────────────────────────
    const rawBody = await req.text()
    const signature = req.headers.get('stripe-signature')

    if (!signature) {
      return new Response(JSON.stringify({ error: 'Missing stripe-signature' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    let event: Stripe.Event
    try {
      event = await stripe.webhooks.constructEventAsync(rawBody, signature, webhookSecret)
    } catch (err) {
      console.error('Webhook signature verification failed:', (err as Error).message)
      return new Response(JSON.stringify({ error: 'Invalid signature' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    console.log(`Stripe webhook: type=${event.type} id=${event.id}`)

    // ── 2. Handle events ────────────────────────────────────
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session
        if (session.metadata?.purchase_type === 'reset_bundle') {
          await handleResetBundleCompleted(supabase, session, event.id)
        } else {
          // NOTE: Evaluation purchases are now fulfilled exclusively by the
          // provider-agnostic `payment-webhook` function to prevent a
          // double-receiver race against checkout_fulfillment_queue.
          // We keep `reset_bundle` handling here until payment-webhook gains
          // reset support; everything else short-circuits as a no-op.
          console.log(
            `stripe-webhook: ignoring checkout.session.completed eventId=${event.id} ` +
            `session=${session.id} — routed via payment-webhook`
          )
        }
        break
      }
      case 'charge.refunded': {
        await handleChargeRefunded(supabase, stripe, event.data.object as Stripe.Charge)
        break
      }
      default: {
        console.log(`Unhandled event type: ${event.type}`)
      }
    }

    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (err) {
    const error = err as Error
    console.error('Stripe webhook handler error:', error)
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
})
