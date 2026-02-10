import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  try {
    // ── Auth: require admin role ─────────────────────────────
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
    const { data: claimsData, error: claimsError } = await supabase.auth.getClaims(token)
    if (claimsError || !claimsData?.claims?.sub) {
      return new Response(JSON.stringify({ error: 'Invalid token' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const userId = claimsData.claims.sub as string

    // Check admin role
    const { data: roleData } = await supabase
      .from('user_roles')
      .select('role')
      .eq('user_id', userId)
      .eq('role', 'admin')
      .maybeSingle()

    if (!roleData) {
      return new Response(JSON.stringify({ error: 'Admin access required' }), {
        status: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // ── Gather data ─────────────────────────────────────────
    // Use service role for cohort checks
    const serviceClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    // Fetch all active cohorts
    const { data: cohorts } = await serviceClient
      .from('cohorts')
      .select('id, name, cohort_phase, is_active, entry_fee, profit_target_percent')
      .eq('is_active', true)

    const activeCohorts = cohorts || []

    // Check Stripe key presence
    const stripeKeyPresent = !!Deno.env.get('STRIPE_SECRET_KEY')

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
      const stripeWired = {
        ok: hasPriceId && hasProductId && stripeKeyPresent,
        detail: !stripeKeyPresent
          ? 'STRIPE_SECRET_KEY not configured'
          : !hasPriceId
            ? 'Missing or invalid priceId'
            : !hasProductId
              ? 'Missing or invalid productId'
              : 'Price and product IDs configured',
      }

      // Cohort ready check — look for a matching cohort by entry_fee
      const matchingCohort = activeCohorts.find(
        (c) => c.entry_fee === cfg.entryFee && c.is_active
      )
      const cohortReady = {
        ok: !!matchingCohort,
        detail: matchingCohort
          ? `Active cohort: ${matchingCohort.name} (${matchingCohort.cohort_phase})`
          : `No active cohort found with entry_fee=${cfg.entryFee}`,
      }

      // Server gate check — mirrors create-checkout-session logic
      const serverGateOk = {
        ok: cfg.isLive && hasPriceId && hasProductId && stripeKeyPresent,
        detail: cfg.isLive
          ? 'Server will accept checkout requests'
          : 'Server returns 400: TIER_NOT_LIVE',
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

    return new Response(JSON.stringify({ tiers }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (err) {
    const error = err as Error
    console.error('get-tier-readiness error:', error)
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
