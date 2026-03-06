import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import Stripe from 'https://esm.sh/stripe@18.5.0'
import { TIER_ECONOMICS, TIER_STRIPE } from '../_shared/checkout/tier-economics.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
}

interface CheckResult {
  ok: boolean
  detail: string
  verifyUnavailable?: boolean
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
    purchasable: CheckResult
    stripeWired: CheckResult
    cohortReady: CheckResult
    serverGateOk: CheckResult
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

    const { data: userData, error: userErr } = await supabase.auth.getUser()
    if (userErr || !userData?.user?.id) {
      return json(401, { error: 'Invalid token' })
    }

    const userId = userData.user.id

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

    const { data: cohorts, error: cohortQueryErr } = await serviceClient
      .from('cohorts')
      .select('id, name, cohort_phase, is_active, entry_fee, tier_id')
      .eq('is_active', true)

    const activeCohorts = cohorts || []

    const stripeKey = Deno.env.get('STRIPE_SECRET_KEY')
    const stripeKeyPresent = !!stripeKey && stripeKey.length > 10

    // Optional deep Stripe verification
    let stripeDeepResults: Record<string, { priceValid: boolean; productValid: boolean; priceMatchesProduct: boolean; observedPriceProductId?: string | null; error?: string }> = {}
    if (deep && stripeKeyPresent) {
      try {
        const stripe = new Stripe(stripeKey!)
        for (const [id, stripeCfg] of Object.entries(TIER_STRIPE)) {
          try {
            const [price, product] = await Promise.all([
              stripe.prices.retrieve(stripeCfg.priceId).catch(() => null),
              stripe.products.retrieve(stripeCfg.productId).catch(() => null),
            ])
            const priceProductId = price
              ? (typeof price.product === 'string' ? price.product : (price.product as { id: string })?.id)
              : null
            stripeDeepResults[id] = {
              priceValid: !!price && price.active === true,
              productValid: !!product,
              priceMatchesProduct: priceProductId === stripeCfg.productId,
              observedPriceProductId: priceProductId,
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
    const tiers: TierReadiness[] = Object.entries(TIER_ECONOMICS).map(([id, econ]) => {
      const stripeCfg = TIER_STRIPE[id]

      // Purchasable check
      const purchasable = {
        ok: econ.isLive,
        detail: econ.isLive ? 'Tier is live' : 'isLive = false — blocked in UI and server',
      }

      // Stripe wired check
      const hasPriceId = !!stripeCfg?.priceId && stripeCfg.priceId.startsWith('price_')
      const hasProductId = !!stripeCfg?.productId && stripeCfg.productId.startsWith('prod_')

      let stripeDetail: string
      let stripeOk: boolean
      let stripeWired: CheckResult

      if (deep && stripeDeepResults[id]) {
        const dr = stripeDeepResults[id]
        stripeOk = dr.priceValid && dr.productValid && dr.priceMatchesProduct && stripeKeyPresent
        const verifyUnavailable = !!dr.error
        if (dr.error) {
          stripeDetail = `Could not verify via Stripe API: ${dr.error}. Config looks valid.`
        } else if (!dr.priceValid && !dr.productValid) {
          stripeDetail = 'Price and product not found or inactive in Stripe'
        } else if (!dr.priceValid) {
          stripeDetail = 'Price not found or inactive in Stripe'
        } else if (!dr.productValid) {
          stripeDetail = 'Product not found or inactive in Stripe'
        } else if (!dr.priceMatchesProduct) {
          stripeDetail = `Mismatch: price.product=${dr.observedPriceProductId} but expected ${stripeCfg.productId}`
        } else {
          stripeDetail = 'Price and product verified active in Stripe'
        }
        stripeWired = { ok: stripeOk, detail: stripeDetail, verifyUnavailable }
      } else {
        stripeOk = hasPriceId && hasProductId && stripeKeyPresent
        stripeDetail = !stripeKeyPresent
          ? 'STRIPE_SECRET_KEY not configured'
          : !hasPriceId
            ? 'Missing or invalid priceId'
            : !hasProductId
              ? 'Missing or invalid productId'
              : 'Price and product IDs configured (use deep verify to confirm in Stripe)'
        stripeWired = { ok: stripeOk, detail: stripeDetail }
      }

      // Cohort ready check
      const matchingCohort = activeCohorts.find(
        (c) => (c.tier_id === id) || (!c.tier_id && c.entry_fee === econ.entryFee)
      )
      const cohortReady = {
        ok: !!matchingCohort,
        detail: matchingCohort
          ? `Active cohort: ${matchingCohort.name} (${matchingCohort.cohort_phase})${!matchingCohort.tier_id ? ' — matched by entry_fee (add tier_id for safety)' : ''}`
          : cohortQueryErr
            ? `Cohort query failed: ${cohortQueryErr.message}`
            : `No active cohort found for tier "${id}"`,
      }

      // Server gate check
      const deepResult = deep ? stripeDeepResults[id] : null
      const deepStripeOk = deepResult
        ? deepResult.priceValid && deepResult.productValid && deepResult.priceMatchesProduct
        : null
      const deepVerifyUnavailable = !!deepResult?.error
      const gateStripeOk = deepStripeOk !== null ? deepStripeOk : (hasPriceId && hasProductId && stripeKeyPresent)
      const gateInputsPresent = econ.isLive && gateStripeOk
      const serverGateOk: CheckResult = {
        ok: gateInputsPresent,
        detail: !econ.isLive
          ? 'Server returns 400: TIER_NOT_LIVE'
          : !stripeKeyPresent
            ? 'Server will fail: STRIPE_CONFIG_MISSING'
            : deepVerifyUnavailable
              ? 'Verification unavailable — flip locked until Stripe verification succeeds'
              : deep && deepStripeOk === false
                ? 'Server will fail: Stripe verification failed (see Stripe Wired check)'
                : !hasPriceId || !hasProductId
                  ? 'Server will fail: STRIPE_CONFIG_MISSING'
                  : deep
                    ? 'Stripe Gate (verified) — all inputs validated against live Stripe'
                    : 'All gate inputs present — server will accept checkout requests',
        verifyUnavailable: deepVerifyUnavailable,
      }

      return {
        id,
        name: econ.name,
        isLive: econ.isLive,
        entryFee: econ.entryFee,
        accountSize: econ.accountSize,
        firstPayoutCap: econ.firstPayoutCap,
        splitPercent: econ.splitPercent,
        lifetimeCapMultiple: econ.lifetimeCapMultiple,
        checks: { purchasable, stripeWired, cohortReady, serverGateOk },
      }
    })

    return json(200, { tiers, deep, checkedAt: new Date().toISOString() })
  } catch (err) {
    const error = err as Error
    console.error('get-tier-readiness error:', error)
    return json(500, { error: error.message })
  }
})
