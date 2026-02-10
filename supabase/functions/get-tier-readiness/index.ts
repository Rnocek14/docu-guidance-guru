import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import Stripe from 'https://esm.sh/stripe@18.5.0'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
}

// ── Canonical tier config (mirrors create-checkout-session) ──────────
const TIER_CONFIG: Record<string, {
  priceId: string
  productId: string
  name: string
  accountSize: number
  entryFee: number
  isLive: boolean
  firstPayoutCap: number
  splitPercent: number
  lifetimeCapMultiple: number
}> = {
  starter: {
    priceId: 'price_1SxvRoLH4HmFKO8KSW3FUPzA',
    productId: 'prod_Tvn1elGTRKWmdC',
    name: 'Starter Evaluation',
    accountSize: 50_000,
    entryFee: 149,
    isLive: true,
    firstPayoutCap: 300,
    splitPercent: 80,
    lifetimeCapMultiple: 7,
  },
  pro: {
    priceId: 'price_1SxvRpLH4HmFKO8KfvQtaGTV',
    productId: 'prod_Tvn1sJVvjM0QoF',
    name: 'Pro Evaluation',
    accountSize: 100_000,
    entryFee: 199,
    isLive: false,
    firstPayoutCap: 500,
    splitPercent: 82,
    lifetimeCapMultiple: 9,
  },
  elite: {
    priceId: 'price_1SxvRqLH4HmFKO8KwCfeCx1C',
    productId: 'prod_Tvn1vcoJGH3uwR',
    name: 'Elite Evaluation',
    accountSize: 200_000,
    entryFee: 349,
    isLive: false,
    firstPayoutCap: 750,
    splitPercent: 85,
    lifetimeCapMultiple: 12,
  },
}

interface TierReadiness {
  id: string
  name: string
  isLive: boolean
  entryFee: number
  accountSize: number
  firstPayoutCap: number
  splitPercent: number
  lifetimeCapMultiple: number
  checks: {
    purchasable: { ok: boolean; detail: string }
    stripeWired: { ok: boolean; detail: string }
    cohortReady: { ok: boolean; detail: string }
    serverGateOk: { ok: boolean; detail: string }
  }
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  try {
    // ── Auth: require admin role ─────────────────────────────
    const authHeader = req.headers.get('Authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      return json(401, { error: 'Unauthorized' })
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } }
    )

    // Use getUser() — canonical JWT verification
    const { data: userData, error: userErr } = await supabase.auth.getUser()
    if (userErr || !userData?.user?.id) {
      return json(401, { error: 'Invalid token' })
    }

    const userId = userData.user.id

    // Check admin role
    const { data: roleRow, error: roleErr } = await supabase
      .from('user_roles')
      .select('role')
      .eq('user_id', userId)
      .eq('role', 'admin')
      .maybeSingle()

    if (roleErr || !roleRow) {
      return json(403, { error: 'Admin access required' })
    }

    // ── Parse query params ──────────────────────────────────
    const url = new URL(req.url)
    const deep = url.searchParams.get('deep') === '1'

    // ── Gather data ─────────────────────────────────────────
    const serviceClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    // Fetch all active cohorts
    const { data: cohorts, error: cohortQueryErr } = await serviceClient
      .from('cohorts')
      .select('id, name, cohort_phase, is_active, entry_fee, tier_id')
      .eq('is_active', true)

    const activeCohorts = cohorts || []

    // Check Stripe key presence
    const stripeKey = Deno.env.get('STRIPE_SECRET_KEY')
    const stripeKeyPresent = !!stripeKey && stripeKey.length > 10

    // Optional deep Stripe verification
    let stripeDeepResults: Record<string, { priceValid: boolean; productValid: boolean; priceMatchesProduct: boolean; error?: string }> = {}
    if (deep && stripeKeyPresent) {
      try {
        const stripe = new Stripe(stripeKey!)
        for (const [id, cfg] of Object.entries(TIER_CONFIG)) {
          try {
            const [price, product] = await Promise.all([
              stripe.prices.retrieve(cfg.priceId).catch(() => null),
              stripe.products.retrieve(cfg.productId).catch(() => null),
            ])
            const priceProductId = price
              ? (typeof price.product === 'string' ? price.product : (price.product as { id: string })?.id)
              : null
            stripeDeepResults[id] = {
              priceValid: !!price && price.active === true,
              productValid: !!product,
              priceMatchesProduct: priceProductId === cfg.productId,
            }
          } catch (e) {
            stripeDeepResults[id] = {
              priceValid: false,
              productValid: false,
              priceMatchesProduct: false,
              error: (e as Error).message,
            }
          }
        }
      } catch (e) {
        console.error('Stripe deep check init failed:', e)
      }
    }

    // ── Build per-tier readiness ─────────────────────────────
    const tiers: TierReadiness[] = Object.entries(TIER_CONFIG).map(([id, cfg]) => {
      // Purchasable check
      const purchasable = {
        ok: cfg.isLive,
        detail: cfg.isLive ? 'Tier is live' : 'isLive = false — blocked in UI and server',
      }

      // Stripe wired check
      const hasPriceId = !!cfg.priceId && cfg.priceId.startsWith('price_')
      const hasProductId = !!cfg.productId && cfg.productId.startsWith('prod_')

      let stripeDetail: string
      let stripeOk: boolean

      if (deep && stripeDeepResults[id]) {
        const dr = stripeDeepResults[id]
        stripeOk = dr.priceValid && dr.productValid && dr.priceMatchesProduct && stripeKeyPresent
        if (dr.error) {
          stripeDetail = `Stripe API error: ${dr.error}`
        } else if (!dr.priceValid && !dr.productValid) {
          stripeDetail = 'Price and product not found or inactive in Stripe'
        } else if (!dr.priceValid) {
          stripeDetail = 'Price not found or inactive in Stripe'
        } else if (!dr.productValid) {
          stripeDetail = 'Product not found or inactive in Stripe'
        } else if (!dr.priceMatchesProduct) {
          stripeDetail = 'Price exists but belongs to a different product — check for copy/paste error'
        } else {
          stripeDetail = 'Price and product verified active in Stripe'
        }
      } else {
        stripeOk = hasPriceId && hasProductId && stripeKeyPresent
        stripeDetail = !stripeKeyPresent
          ? 'STRIPE_SECRET_KEY not configured'
          : !hasPriceId
            ? 'Missing or invalid priceId'
            : !hasProductId
              ? 'Missing or invalid productId'
              : 'Price and product IDs configured (use deep verify to confirm in Stripe)'
      }

      const stripeWired = { ok: stripeOk, detail: stripeDetail }

      // Cohort ready check — prefer tier_id match, fallback to entry_fee
      const matchingCohort = activeCohorts.find(
        (c) => (c.tier_id === id) || (!c.tier_id && c.entry_fee === cfg.entryFee)
      )
      const cohortReady = {
        ok: !!matchingCohort,
        detail: matchingCohort
          ? `Active cohort: ${matchingCohort.name} (${matchingCohort.cohort_phase})${!matchingCohort.tier_id ? ' — matched by entry_fee (add tier_id for safety)' : ''}`
          : cohortQueryErr
            ? `Cohort query failed: ${cohortQueryErr.message}`
            : `No active cohort found for tier "${id}"`,
      }

      // Server gate check — simulates create-checkout-session validation
      const gateInputsPresent = cfg.isLive && hasPriceId && hasProductId && stripeKeyPresent
      const serverGateOk = {
        ok: gateInputsPresent,
        detail: !cfg.isLive
          ? 'Server returns 400: TIER_NOT_LIVE'
          : !stripeKeyPresent
            ? 'Server will fail: STRIPE_CONFIG_MISSING'
            : !hasPriceId || !hasProductId
              ? 'Server will fail: STRIPE_CONFIG_MISSING'
              : 'All gate inputs present — server will accept checkout requests',
      }

      return {
        id,
        name: cfg.name,
        isLive: cfg.isLive,
        entryFee: cfg.entryFee,
        accountSize: cfg.accountSize,
        firstPayoutCap: cfg.firstPayoutCap,
        splitPercent: cfg.splitPercent,
        lifetimeCapMultiple: cfg.lifetimeCapMultiple,
        checks: { purchasable, stripeWired, cohortReady, serverGateOk },
      }
    })

    return json(200, { tiers, deep })
  } catch (err) {
    const error = err as Error
    console.error('get-tier-readiness error:', error)
    return json(500, { error: error.message })
  }
})
