import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { TIERS, RULES_VERSION } from '../_shared/checkout/config.ts'
import { getCheckoutProvider, resolveActiveInboundRail } from '../_shared/checkout/registry.ts'
import type { CheckoutMetadata } from '../_shared/checkout/types.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  try {
    // ── 1. Auth (REQUIRED — no guest checkout) ────────────
    const authHeader = req.headers.get('Authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      return new Response(JSON.stringify({ error: 'Authentication required' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } }
    )

    const { data: userData, error: userError } = await supabase.auth.getUser()
    if (userError || !userData?.user) {
      return new Response(JSON.stringify({ error: 'Invalid or expired token' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const userId = userData.user.id
    const userEmail = userData.user.email || null

    // ── 2. Parse & validate request ─────────────────────────
    const body = await req.json()
    const { tierId, disclaimerAccepted, rulesAcknowledged } = body as {
      tierId?: string
      disclaimerAccepted?: boolean
      rulesAcknowledged?: boolean
    }

    if (!tierId || !TIERS[tierId]) {
      return new Response(JSON.stringify({ error: 'Invalid tier' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const tier = TIERS[tierId]

    if (!tier.isLive) {
      return new Response(
        JSON.stringify({ error: 'This tier is not yet available for purchase' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    if (!disclaimerAccepted) {
      return new Response(
        JSON.stringify({ error: 'Disclaimer must be accepted before purchase' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    if (!rulesAcknowledged) {
      return new Response(
        JSON.stringify({ error: 'Rules acknowledgement required before purchase' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // ── 2b. Risk throttle gate ─────────────────────────────
    const serviceClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    const { data: throttle } = await serviceClient
      .from('risk_throttle_state')
      .select('purchase_enabled, state')
      .eq('id', '00000000-0000-0000-0000-000000000002')
      .single()

    if (throttle && !throttle.purchase_enabled) {
      console.warn(`Checkout blocked by risk throttle: state=${throttle.state}`)
      return new Response(
        JSON.stringify({ error: 'New purchases are temporarily paused. Please try again later.' }),
        { status: 503, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // ── 3. Resolve active payment rail ──────────────────────
    const railKey = await resolveActiveInboundRail(serviceClient)
    const provider = getCheckoutProvider(railKey)

    console.log(`Using checkout provider: ${provider.providerId} (rail: ${railKey})`)

    // ── 4. Resolve redirect origin (fail-closed) ──────────
    const APP_ORIGIN = Deno.env.get('APP_ORIGIN')
    if (!APP_ORIGIN) {
      console.error('FATAL: APP_ORIGIN not configured. Cannot create checkout session.')
      return new Response(
        JSON.stringify({ error: 'Server misconfiguration' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Log origin mismatch (informational only — redirects always use APP_ORIGIN)
    const originHeader = req.headers.get('origin')
    const forwardedHost = req.headers.get('x-forwarded-host')
    const forwardedProto = req.headers.get('x-forwarded-proto')
    let requestOrigin: string | null = originHeader || (forwardedHost && forwardedProto ? `${forwardedProto}://${forwardedHost}` : null)
    if (requestOrigin && requestOrigin !== APP_ORIGIN) {
      console.warn(`Origin mismatch: request=${requestOrigin}, APP_ORIGIN=${APP_ORIGIN}. Using APP_ORIGIN for redirects.`)
    }

    // ── 5. Create checkout session via provider adapter ────
    const metadata: CheckoutMetadata = {
      disclaimerAccepted: true,
      disclaimerVersion: 'v1',
      rulesAcknowledged: true,
      rulesAcknowledgedAt: new Date().toISOString(),
      rulesVersion: RULES_VERSION,
      productDescription: 'Simulated trading evaluation access',
    }

    const result = await provider.createSession({
      tier,
      userId,
      userEmail,
      metadata,
      appOrigin: APP_ORIGIN,
    })

    // ── 6. Persist queue row BEFORE returning URL ──────────
    const { error: queueInsertErr } = await serviceClient
      .from('checkout_fulfillment_queue')
      .insert({
        stripe_session_id: result.sessionId, // Legacy column — kept for backward compat
        user_id: userId,
        tier_id: tierId,
        payment_intent: result.paymentIntent || null,
        amount_cents: tier.entryFee * 100,
        currency: 'usd',
        status: 'session_created',
        rules_acknowledged: true,
        rules_acknowledged_at: new Date().toISOString(),
        rules_version: RULES_VERSION,
        // Canonical provider-agnostic fields
        provider: result.provider,
        provider_session_id: result.sessionId,
        provider_payment_id: result.paymentIntent || null,
        rail_key: railKey,
      })

    if (queueInsertErr && !queueInsertErr.code?.includes('23505')) {
      console.error(`QUEUE_PRECREATE_FAILED: ${queueInsertErr.message}`, {
        sessionId: result.sessionId, userId, tierId,
      })
      await serviceClient.from('staff_notifications').insert({
        notification_type: 'queue_precreate_failed',
        title: '⚠️ Checkout queue pre-insert failed',
        body: `Pre-insert failed for session=${result.sessionId} user=${userId} tier=${tierId}. Error: ${queueInsertErr.message}. Webhook fallback will attempt insert.`,
        data: { stripe_session_id: result.sessionId, user_id: userId, tier_id: tierId, error: queueInsertErr.message },
        idempotency_key: `queue_precreate_failed:${result.sessionId}`,
      }).catch(() => { /* best-effort */ })
    }

    console.log(`Checkout session created: ${result.sessionId} provider=${result.provider} user=${userId} tier=${tierId} origin=${APP_ORIGIN}`)

    return new Response(JSON.stringify({
      url: result.checkoutUrl,
      provider: result.provider,
      sessionId: result.sessionId,
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (err) {
    const error = err as Error
    console.error('create-checkout-session error:', error)
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
