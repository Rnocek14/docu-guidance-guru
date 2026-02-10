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
    const { tierId, disclaimerAccepted } = body as {
      tierId?: string
      disclaimerAccepted?: boolean
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
    // Priority: APP_ORIGIN env > Origin header (validated against allowlist)
    const APP_ORIGIN = Deno.env.get('APP_ORIGIN')
    
    // Build allowlist from APP_ORIGIN (always) + known domains
    const ALLOWED_ORIGINS: string[] = []
    if (APP_ORIGIN) ALLOWED_ORIGINS.push(APP_ORIGIN)
    // Add any additional known production domains here
    
    const requestOrigin = req.headers.get('origin')
    
    let resolvedOrigin: string | null = null
    
    if (APP_ORIGIN) {
      // Production mode: always use APP_ORIGIN regardless of request origin
      resolvedOrigin = APP_ORIGIN
    } else if (requestOrigin && ALLOWED_ORIGINS.length > 0 && ALLOWED_ORIGINS.includes(requestOrigin)) {
      // Allowlisted origin
      resolvedOrigin = requestOrigin
    } else if (requestOrigin && ALLOWED_ORIGINS.length === 0) {
      // No allowlist configured and no APP_ORIGIN — development fallback
      // Still reject preview domains
      if (requestOrigin.includes('id-preview--') || requestOrigin.includes('localhost')) {
        console.warn(`Checkout origin rejected (preview/localhost): ${requestOrigin}`)
        resolvedOrigin = null
      } else {
        resolvedOrigin = requestOrigin
      }
    }
    
    if (!resolvedOrigin) {
      console.error(`Checkout origin resolution failed. APP_ORIGIN=${APP_ORIGIN || 'unset'}, request_origin=${requestOrigin || 'absent'}`)
      return new Response(
        JSON.stringify({ 
          error: 'Unable to determine redirect origin',
          hint: APP_ORIGIN ? undefined : 'Set APP_ORIGIN env var for production deployments'
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

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
        product_description: 'Simulated trading evaluation access',
      },
      payment_intent_data: {
        metadata: {
          user_id: userId,
          tier_id: tierId,
        },
      },
      success_url: `${resolvedOrigin}/trader?session_id={CHECKOUT_SESSION_ID}&payment=success`,
      cancel_url: `${resolvedOrigin}/checkout?payment=cancelled`,
    })

    console.log(`Checkout session created: ${session.id} for user=${userId} tier=${tierId} origin=${resolvedOrigin}`)

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
