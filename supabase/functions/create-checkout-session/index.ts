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
}> = {
  starter: {
    priceId: 'price_1SxvRoLH4HmFKO8KSW3FUPzA',
    productId: 'prod_Tvn1elGTRKWmdC',
    name: 'Starter Evaluation',
    accountSize: 50_000,
    entryFee: 149,
  },
  pro: {
    priceId: 'price_1SxvRpLH4HmFKO8KfvQtaGTV',
    productId: 'prod_Tvn1sJVvjM0QoF',
    name: 'Pro Evaluation',
    accountSize: 100_000,
    entryFee: 199,
  },
  elite: {
    priceId: 'price_1SxvRqLH4HmFKO8KwCfeCx1C',
    productId: 'prod_Tvn1vcoJGH3uwR',
    name: 'Elite Evaluation',
    accountSize: 200_000,
    entryFee: 349,
  },
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  try {
    // ── 1. Auth ──────────────────────────────────────────────
    const authHeader = req.headers.get('Authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } }
    )

    const token = authHeader.replace('Bearer ', '')
    const { data: userData, error: userError } = await supabase.auth.getUser(token)
    if (userError || !userData.user) {
      return new Response(JSON.stringify({ error: 'Invalid token' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }
    const user = userData.user

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

    // P0 RELEASE BLOCKER: disclaimer must be accepted
    if (!disclaimerAccepted) {
      return new Response(
        JSON.stringify({ error: 'Disclaimer must be accepted before purchase' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const tier = TIER_CONFIG[tierId]

    // ── 3. Stripe customer lookup / reuse ────────────────────
    const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, {
      apiVersion: '2025-08-27.basil',
    })

    const customers = await stripe.customers.list({
      email: user.email!,
      limit: 1,
    })

    let customerId: string | undefined
    if (customers.data.length > 0) {
      customerId = customers.data[0].id
    }

    // ── 4. Create checkout session ──────────────────────────
    const origin = req.headers.get('origin') || 'https://id-preview--670d7a23-850f-41f2-bb87-32a472cdcbc3.lovable.app'

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      customer_email: customerId ? undefined : user.email!,
      line_items: [{ price: tier.priceId, quantity: 1 }],
      mode: 'payment',
      // Dispute-readiness: store what was presented at checkout
      metadata: {
        user_id: user.id,
        tier_id: tierId,
        account_size: String(tier.accountSize),
        entry_fee: String(tier.entryFee),
        disclaimer_accepted: 'true',
        disclaimer_version: 'v1',
        product_description: 'Simulated trading evaluation access',
      },
      payment_intent_data: {
        metadata: {
          user_id: user.id,
          tier_id: tierId,
        },
      },
      success_url: `${origin}/trader?session_id={CHECKOUT_SESSION_ID}&payment=success`,
      cancel_url: `${origin}/checkout?payment=cancelled`,
    })

    console.log(`Checkout session created: ${session.id} for user=${user.id} tier=${tierId}`)

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
