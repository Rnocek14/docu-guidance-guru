import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import Stripe from 'https://esm.sh/stripe@18.5.0'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
}

// ============================================================
// Tier → Stripe price mapping (created in Stripe dashboard)
// Product descriptions: "Simulated trading evaluation access"
// ============================================================
const TIER_CONFIG: Record<string, {
  priceId: string
  productId: string
  name: string
  accountSize: number
  entryFee: number
  isLive: boolean
}> = {
  starter: {
    priceId: 'price_1SxvRoLH4HmFKO8KSW3FUPzA',
    productId: 'prod_Tvn1elGTRKWmdC',
    name: 'Starter Evaluation',
    accountSize: 50_000,
    entryFee: 149,
    isLive: true,
  },
  pro: {
    priceId: 'price_1SxvRpLH4HmFKO8KfvQtaGTV',
    productId: 'prod_Tvn1sJVvjM0QoF',
    name: 'Pro Evaluation',
    accountSize: 100_000,
    entryFee: 199,
    isLive: false,
  },
  elite: {
    priceId: 'price_1SxvRqLH4HmFKO8KwCfeCx1C',
    productId: 'prod_Tvn1vcoJGH3uwR',
    name: 'Elite Evaluation',
    accountSize: 200_000,
    entryFee: 349,
    isLive: false,
  },
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
    const { tierId, disclaimerAccepted, rulesAcknowledged, rulesVersion } = body as {
      tierId?: string
      disclaimerAccepted?: boolean
      rulesAcknowledged?: boolean
      rulesVersion?: string
    }

    if (!tierId || !TIER_CONFIG[tierId]) {
      return new Response(JSON.stringify({ error: 'Invalid tier' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const tier = TIER_CONFIG[tierId]

    // Server-side gate: reject non-live tiers
    if (!tier.isLive) {
      return new Response(
        JSON.stringify({ error: 'This tier is not yet available for purchase' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // P0 RELEASE BLOCKER: disclaimer must be accepted
    if (!disclaimerAccepted) {
      return new Response(
        JSON.stringify({ error: 'Disclaimer must be accepted before purchase' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // P0: Rules acknowledgement must be accepted (chargeback defense)
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

    // ── 3. Stripe customer lookup / reuse ────────────────────
    const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, {
      apiVersion: '2025-08-27.basil',
    })

    const customers = userEmail
      ? await stripe.customers.list({ email: userEmail, limit: 1 })
      : { data: [] }

    let customerId: string | undefined
    if (customers.data.length > 0) {
      customerId = customers.data[0].id
    }

    // ── 4. Resolve redirect origin (fail-closed) ──────────
    // APP_ORIGIN is REQUIRED. All Stripe redirect URLs point here.
    // Never trust browser Origin header for money-touching flows.
    const APP_ORIGIN = Deno.env.get('APP_ORIGIN')

    if (!APP_ORIGIN) {
      console.error('FATAL: APP_ORIGIN not configured. Cannot create checkout session.')
      return new Response(
        JSON.stringify({ error: 'Server misconfiguration' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Log & warn if request origin doesn't match (informational only)
    const originHeader = req.headers.get('origin')
    const forwardedHost = req.headers.get('x-forwarded-host')
    const forwardedProto = req.headers.get('x-forwarded-proto')

    let requestOrigin: string | null = null
    if (originHeader) {
      requestOrigin = originHeader
    } else if (forwardedHost && forwardedProto) {
      requestOrigin = `${forwardedProto}://${forwardedHost}`
    }

    if (requestOrigin && requestOrigin !== APP_ORIGIN) {
      console.warn(`Origin mismatch: request=${requestOrigin}, APP_ORIGIN=${APP_ORIGIN}. Using APP_ORIGIN for redirects.`)
    }

    // Stripe redirect URLs ALWAYS use APP_ORIGIN — never request origin
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      customer_email: customerId ? undefined : (userEmail || undefined),
      line_items: [{ price: tier.priceId, quantity: 1 }],
      mode: 'payment',
      metadata: {
        user_id: userId,
        tier_id: tierId,
        account_size: String(tier.accountSize),
        entry_fee: String(tier.entryFee),
        disclaimer_accepted: 'true',
        disclaimer_version: 'v1',
        rules_acknowledged: 'true',
        rules_acknowledged_at: new Date().toISOString(),
        rules_version: rulesVersion || 'v1.0',
        product_description: 'Simulated trading evaluation access',
      },
      payment_intent_data: {
        metadata: {
          user_id: userId,
          tier_id: tierId,
        },
      },
      success_url: `${APP_ORIGIN}/trader?session_id={CHECKOUT_SESSION_ID}&payment=success`,
      cancel_url: `${APP_ORIGIN}/checkout?payment=cancelled`,
    })

    console.log(`Checkout session created: ${session.id} for user=${userId} tier=${tierId} origin=${APP_ORIGIN}`)

    return new Response(JSON.stringify({ url: session.url }), {
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
