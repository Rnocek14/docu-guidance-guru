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
    // ── 1. Auth (optional — supports guest checkout) ───────
    const authHeader = req.headers.get('Authorization')
    let userId: string | null = null
    let userEmail: string | null = null

    if (authHeader?.startsWith('Bearer ')) {
      const supabase = createClient(
        Deno.env.get('SUPABASE_URL')!,
        Deno.env.get('SUPABASE_ANON_KEY')!,
        { global: { headers: { Authorization: authHeader } } }
      )

      const token = authHeader.replace('Bearer ', '')
      const { data: claimsData, error: claimsError } = await supabase.auth.getClaims(token)
      if (!claimsError && claimsData?.claims?.sub) {
        userId = claimsData.claims.sub as string
        userEmail = (claimsData.claims.email as string) || null
      }
    }

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

    // ── 4. Create checkout session ──────────────────────────
    const origin = req.headers.get('origin') || 'https://id-preview--670d7a23-850f-41f2-bb87-32a472cdcbc3.lovable.app'

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      customer_email: customerId ? undefined : (userEmail || undefined),
      line_items: [{ price: tier.priceId, quantity: 1 }],
      mode: 'payment',
      metadata: {
        user_id: userId || 'guest',
        tier_id: tierId,
        account_size: String(tier.accountSize),
        entry_fee: String(tier.entryFee),
        disclaimer_accepted: 'true',
        disclaimer_version: 'v1',
        product_description: 'Simulated trading evaluation access',
      },
      payment_intent_data: {
        metadata: {
          user_id: userId || 'guest',
          tier_id: tierId,
        },
      },
      success_url: `${origin}/trader?session_id={CHECKOUT_SESSION_ID}&payment=success`,
      cancel_url: `${origin}/checkout?payment=cancelled`,
    })

    console.log(`Checkout session created: ${session.id} for user=${userId || 'guest'} tier=${tierId}`)

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
